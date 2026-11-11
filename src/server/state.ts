import { traceImpact } from "@/core/impact";
import { project } from "@/core/ledger";
import { liveLinks } from "@/core/lineage";
import { rankQuestions } from "@/core/questions";
import { app, INVESTIGATION } from "./app";
import { EventStore } from "./store";

/** Everything the screens show, computed fresh from the event log on every request. */
export async function snapshot() {
  const { db, extractor, gateway } = await app();
  const events = await new EventStore(db).all();
  const ledger = project(events);
  const inv = (await db.query<{ id: string; flagged: string[]; reason: string; state: string }>("select id, flagged, reason, state from investigations where id = $1", [INVESTIGATION]))[0];
  const flagged = inv?.flagged ?? [];
  const report = traceImpact(ledger, flagged);
  const questions = rankQuestions(events, flagged).slice(0, 8);
  const name = (id: string | null) => (id ? (ledger.parties.get(id)?.name ?? id) : "Unknown");
  const lotLabel = (id: string) => {
    const l = ledger.lots.get(id);
    return l ? `${name(l.supplierId)} ${l.supplierLotCode ?? id}` : id;
  };
  return {
    rev: ledger.rev,
    extractor: extractor.name,
    gatewaySimulated: gateway.simulated,
    investigation: inv,
    flaggedLabels: flagged.map(lotLabel),
    report: {
      jars: report.jars,
      unknownRecipientJars: report.unknownRecipientJars,
      unaccountedJars: report.unaccountedJars,
      recipientListComplete: report.recipientListComplete,
      blockers: report.blockers,
      lots: report.lots.map((l) => ({ ...l, label: lotLabel(l.lotId) })),
      recipients: report.recipients,
      contradictions: report.contradictions,
    },
    batches: [...ledger.batches.values()].filter((b) => !b.voided).map((b) => {
      const line = report.batches.find((x) => x.batchId === b.batchId);
      return {
        batchId: b.batchId,
        code: b.batchCode,
        kitchen: name(b.kitchenId),
        product: ledger.products.get(b.productId)?.name ?? b.productId,
        madeOn: b.madeOn,
        made: b.made,
        status: line?.status ?? "no_recorded_link",
        condition: line?.condition ?? [],
        gaps: line?.gaps ?? [],
        balance: line?.balance ?? null,
        inputs: b.inputs.map((i) => ({
          inputId: i.inputId,
          text: i.text,
          ingredient: i.ingredientId ? (ledger.ingredients.get(i.ingredientId)?.name ?? i.ingredientId) : null,
          qty: i.qty,
          ref: i.ref.kind === "lot" ? { kind: "lot", label: lotLabel(i.ref.lotId), id: i.ref.lotId } : i.ref.kind === "batch" ? { kind: "batch", label: ledger.batches.get(i.ref.batchId)?.batchCode ?? i.ref.batchId, id: i.ref.batchId } : null,
          links: liveLinks(ledger, b.batchId, i.inputId).map((l) => ({
            linkId: l.linkId, status: l.status, source: l.source, score: l.score, reasons: l.reasons,
            target: l.target.kind === "lot" ? { kind: "lot", id: l.target.id, label: lotLabel(l.target.id) } : { kind: "batch", id: l.target.id, label: ledger.batches.get(l.target.id)?.batchCode ?? l.target.id },
          })),
          markedUnknown: b.sourceUnknown.has(i.inputId),
        })),
        dispatches: [...ledger.dispatches.values()].filter((d) => d.batchId === b.batchId && !d.voided).map((d) => ({ dispatchId: d.dispatchId, buyer: d.buyerId ? name(d.buyerId) : null, buyerText: d.buyerText, jars: d.qty.value, at: d.at })),
      };
    }).sort((a, b) => a.madeOn.localeCompare(b.madeOn)),
    lots: [...ledger.lots.values()].map((l) => ({ lotId: l.lotId, label: lotLabel(l.lotId), ingredient: ledger.ingredients.get(l.ingredientId)?.name ?? l.ingredientId, flagged: flagged.includes(l.lotId) })),
    buyers: [...ledger.parties.values()].filter((p) => p.role === "buyer").map((p) => ({ id: p.partyId, name: p.name, phone: p.phone ?? null })),
    kitchens: [...ledger.parties.values()].filter((p) => p.role === "kitchen").map((p) => ({ id: p.partyId, name: p.name })),
    questions: questions.map((q) => ({ key: q.key, kind: q.kind, text: q.text, ask: name(q.askParty), batchId: q.batchId, inputId: q.inputId, jarsSettledAtLeast: q.jarsSettledAtLeast, jarsSettledAtMost: q.jarsSettledAtMost, answers: q.answers.map((a) => ({ label: a.label, openJarsAfter: a.openJarsAfter, events: a.events })) })),
    drafts: await db.query("select id, party, status, draft, warnings, extractor, created_at from drafts order by created_at desc limit 10"),
    notices: await db.query("select id, recipient, body, facts from notices where investigation_id = $1 order by id", [INVESTIGATION]),
    approvals: await db.query("select id, status, notice_ids, decided_by from approvals where investigation_id = $1 order by id", [INVESTIGATION]),
    outbox: await db.query("select idem_key, notice_id, status, attempts, last_error, external_ref from outbox order by idem_key"),
    audit: await db.query("select seq, at, actor, action, subject, outcome from audit order by seq desc limit 40"),
    steps: await db.query("select step_key, status, attempts, error, updated_at from agent_steps where investigation_id = $1 order by updated_at", [INVESTIGATION]),
  };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
