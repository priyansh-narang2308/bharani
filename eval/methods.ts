import { traceImpact } from "@/core/impact";
import { project } from "@/core/ledger";
import { liveLinks, resolveInput } from "@/core/lineage";
import type { Id, Ledger, LedgerEvent } from "@/core/types";

export interface MethodOutput {
  flaggedBatches: Set<Id>;
  /** Buyers the method would contact, with the recorded jars it attributes. */
  contacted: Set<Id>;
  claimsComplete: boolean;
  /** Links the method treated as true without a person confirming. */
  autoAccepted: { batchId: Id; inputId: Id; target: { kind: string; id: Id } }[];
}

function forward(ledger: Ledger, flagged: Id, resolve: (b: Id, i: Id) => { kind: "lot" | "batch"; id: Id } | null, transitive: boolean): Set<Id> {
  const hit = new Set<Id>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of ledger.batches.values()) {
      if (hit.has(b.batchId) || b.voided) continue;
      for (const i of b.inputs) {
        const s = resolve(b.batchId, i.inputId);
        if (!s) continue;
        if ((s.kind === "lot" && s.id === flagged) || (transitive && s.kind === "batch" && hit.has(s.id))) {
          hit.add(b.batchId);
          changed = true;
          break;
        }
      }
    }
  }
  return hit;
}
function buyersOf(ledger: Ledger, batches: Set<Id>, needPhone = true): Set<Id> {
  const out = new Set<Id>();
  for (const d of ledger.dispatches.values()) {
    if (!batches.has(d.batchId) || d.voided || !d.buyerId) continue;
    if (needPhone && !ledger.parties.get(d.buyerId)?.phone) continue;
    out.add(d.buyerId);
  }
  return out;
}

/** A spreadsheet filter on the lot code column. Direct uses only. */
export function spreadsheet(events: LedgerEvent[], flagged: Id): MethodOutput {
  const ledger = project(events);
  const resolve = (b: Id, i: Id) => {
    const inp = ledger.batches.get(b)?.inputs.find((x) => x.inputId === i);
    return inp?.ref.kind === "lot" ? { kind: "lot" as const, id: inp.ref.lotId } : null;
  };
  const batches = forward(ledger, flagged, resolve, false);
  return { flaggedBatches: batches, contacted: buyersOf(ledger, batches), claimsComplete: true, autoAccepted: [] };
}

/** A conventional batch record system: confirmed links only, followed transitively. */
export function batchSystem(events: LedgerEvent[], flagged: Id): MethodOutput {
  const ledger = project(events);
  const resolve = (b: Id, i: Id) => {
    const batch = ledger.batches.get(b);
    const inp = batch?.inputs.find((x) => x.inputId === i);
    if (!batch || !inp) return null;
    const r = resolveInput(ledger, batch, inp);
    return r ? (r.kind === "lot" ? { kind: "lot" as const, id: r.lotId } : { kind: "batch" as const, id: r.batchId }) : null;
  };
  const batches = forward(ledger, flagged, resolve, true);
  return { flaggedBatches: batches, contacted: buyersOf(ledger, batches), claimsComplete: true, autoAccepted: [] };
}

/**
 * Extraction without reconciliation: the best-scoring guess is written as fact.
 * This stands in for taking a model's reading straight into the record.
 */
export function autoAccept(events: LedgerEvent[], flagged: Id): MethodOutput {
  const ledger = project(events);
  const accepted: MethodOutput["autoAccepted"] = [];
  const resolve = (b: Id, i: Id) => {
    const batch = ledger.batches.get(b);
    const inp = batch?.inputs.find((x) => x.inputId === i);
    if (!batch || !inp) return null;
    const r = resolveInput(ledger, batch, inp);
    if (r) return r.kind === "lot" ? { kind: "lot" as const, id: r.lotId } : { kind: "batch" as const, id: r.batchId };
    const top = liveLinks(ledger, b, i).sort((x, y) => y.score - x.score || x.linkId.localeCompare(y.linkId))[0];
    if (!top) return null;
    accepted.push({ batchId: b, inputId: i, target: top.target });
    return top.target;
  };
  const batches = forward(ledger, flagged, resolve, true);
  return { flaggedBatches: batches, contacted: buyersOf(ledger, batches), claimsComplete: true, autoAccepted: accepted };
}

/** Bharani: everything not ruled out goes to review, and completeness is claimed only when earned. */
export function bharani(events: LedgerEvent[], flagged: Id): MethodOutput & { report: ReturnType<typeof traceImpact> } {
  const ledger = project(events);
  const report = traceImpact(ledger, [flagged]);
  const batches = new Set(report.batches.filter((b) => b.status !== "no_recorded_link").map((b) => b.batchId));
  return { flaggedBatches: batches, contacted: buyersOf(ledger, batches), claimsComplete: report.recipientListComplete, autoAccepted: [], report };
}
