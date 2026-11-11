import { DEFAULTS, type BalanceOptions } from "./balance";
import { traceImpact, type ImpactReport } from "./impact";
import { project } from "./ledger";
import { liveLinks } from "./lineage";
import { sequence } from "./log";
import type { Id, Ledger, LedgerEvent, NewEvent } from "./types";

export interface Answer {
  label: string;
  /** Events a person's answer would append. */
  events: NewEvent[];
  /** Jars still conditional or undetermined if this answer is given. */
  openJarsAfter: number;
}
export interface Question {
  key: string;
  kind: "which_source" | "unaccounted_stock" | "unknown_buyer" | "buyer_contact";
  /** Who can answer: the kitchen, or the coordinator. */
  askParty: Id;
  batchId?: Id;
  inputId?: Id;
  text: string;
  /** Jars this answer settles whatever the reply turns out to be. */
  jarsSettledAtLeast: number;
  /** Jars settled by the most helpful reply. */
  jarsSettledAtMost: number;
  answers: Answer[];
}

const open = (r: ImpactReport) => r.jars.conditional + r.jars.undetermined;

/**
 * Ranks questions by what each is worth, computed by replaying every possible
 * answer through the same engine. Nothing is estimated and no model is called.
 */
export function rankQuestions(events: readonly LedgerEvent[], flagged: readonly Id[], opts: BalanceOptions = DEFAULTS): Question[] {
  const ledger = project(events);
  const now = traceImpact(ledger, flagged, opts);
  const nextSeq = ledger.rev;
  const after = (extra: NewEvent[]) =>
    traceImpact(project([...events, ...sequence(extra, nextSeq)]), flagged, opts);
  const today = maxDate(ledger);
  const out: Question[] = [];

  const seen = new Set<string>();
  for (const b of now.batches) {
    if (b.status !== "conditional" && b.status !== "undetermined") continue;
    const batch = ledger.batches.get(b.batchId);
    if (!batch) continue;
    const inputs = new Set([
      ...b.hops.filter((h) => !h.confirmed && h.linkId).map((h) => h.inputId),
      ...b.gaps.flatMap((g) => (g.inputId ? [g.inputId] : [])),
    ]);
    for (const inputId of inputs) {
      const key = `${b.batchId}:${inputId}`;
      if (seen.has(key) || batch.sourceUnknown.has(inputId)) continue;
      seen.add(key);
      const input = batch.inputs.find((i) => i.inputId === inputId);
      if (!input) continue;
      const links = liveLinks(ledger, b.batchId, inputId).filter((l) => l.status === "proposed");
      if (links.length === 0) continue;
      const base = { at: today, actor: "system" };
      const answers: Answer[] = links.map((l) => {
        const events: NewEvent[] = [{ ...base, type: "link.confirmed", id: `q-${l.linkId}`, linkId: l.linkId }];
        return { label: describeTarget(ledger, l.target), events, openJarsAfter: open(after(events)) };
      });
      const none: NewEvent[] = [{ ...base, type: "input.source_unknown", id: `q-none-${key}`, batchId: b.batchId, inputId }];
      answers.push({ label: "Cannot tell", events: none, openJarsAfter: open(after(none)) });
      const definite = answers.slice(0, -1);
      const settled = definite.map((a) => open(now) - a.openJarsAfter);
      out.push({
        key,
        kind: "which_source",
        askParty: batch.kitchenId,
        batchId: b.batchId,
        inputId,
        text: `For batch ${batch.batchCode ?? b.batchId}, which ${input.text} was used?`,
        jarsSettledAtLeast: Math.max(0, Math.min(...settled)),
        jarsSettledAtMost: Math.max(0, ...settled),
        answers,
      });
    }
  }

  for (const b of now.batches) {
    if (b.status === "no_recorded_link" || b.balance.unit !== "jar") continue;
    const gapJars = Math.max(0, b.balance.unaccounted ?? 0);
    const batch = ledger.batches.get(b.batchId);
    if (gapJars > 0 && batch) {
      out.push({
        key: `stock:${b.batchId}`,
        kind: "unaccounted_stock",
        askParty: batch.kitchenId,
        batchId: b.batchId,
        text: `Batch ${batch.batchCode ?? b.batchId}: ${gapJars} jars have no recorded destination. Where did they go?`,
        jarsSettledAtLeast: gapJars,
        jarsSettledAtMost: gapJars,
        answers: [],
      });
    }
    if (b.balance.dispatchedUnknownBuyer > 0 && batch) {
      out.push({
        key: `buyer:${b.batchId}`,
        kind: "unknown_buyer",
        askParty: batch.kitchenId,
        batchId: b.batchId,
        text: `Batch ${batch.batchCode ?? b.batchId}: ${b.balance.dispatchedUnknownBuyer} jars went to a buyer the records do not identify. Who was it?`,
        jarsSettledAtLeast: b.balance.dispatchedUnknownBuyer,
        jarsSettledAtMost: b.balance.dispatchedUnknownBuyer,
        answers: [],
      });
    }
  }
  for (const r of now.recipients) {
    if (r.contactable) continue;
    const jars = r.jars.confirmed + r.jars.conditional + r.jars.undetermined;
    out.push({
      key: `contact:${r.buyerId}`,
      kind: "buyer_contact",
      askParty: "coordinator",
      text: `${r.name} received ${jars} jars but has no phone number on record. What is it?`,
      jarsSettledAtLeast: jars,
      jarsSettledAtMost: jars,
      answers: [],
    });
  }

  return out.sort(
    (a, b) =>
      b.jarsSettledAtLeast - a.jarsSettledAtLeast ||
      b.jarsSettledAtMost - a.jarsSettledAtMost ||
      a.key.localeCompare(b.key),
  );
}

function describeTarget(ledger: Ledger, t: { kind: "lot" | "batch"; id: Id }): string {
  if (t.kind === "lot") {
    const lot = ledger.lots.get(t.id);
    const supplier = lot?.supplierId ? ledger.parties.get(lot.supplierId)?.name : undefined;
    return `${supplier ?? "Unknown supplier"}, lot ${lot?.supplierLotCode ?? t.id}`;
  }
  const b = ledger.batches.get(t.id);
  return `Batch ${b?.batchCode ?? t.id}`;
}

function maxDate(ledger: Ledger): string {
  let max = "1970-01-01";
  for (const b of ledger.batches.values()) if (b.madeOn > max) max = b.madeOn;
  return max;
}
