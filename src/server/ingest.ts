import { project } from "@/core/ledger";
import type { Id, NewEvent } from "@/core/types";
import { groundDraft } from "@/extract/ground";
import { reconcile, type Warning } from "@/extract/reconcile";
import type { ExtractContext, Extractor, NoteDraft } from "@/extract/schema";
import type { Db } from "./db";
import { audit, EventStore, sha256 } from "./store";

export interface IngestResult {
  duplicateOf: Id | null;
  draftId: Id;
  readBack: string;
  warnings: Warning[];
  events: NewEvent[];
  draft: NoteDraft | null;
  extractor: string;
}

/**
 * A kitchen's note goes in, a pending draft comes out. Nothing touches the
 * ledger until a person accepts the read-back. The same audio or text sent
 * twice returns the first draft.
 */
export async function ingestNote(
  db: Db,
  extractor: Extractor,
  note: { kitchenId: Id; date: string; transcript: string; audio?: Uint8Array },
): Promise<IngestResult> {
  const hash = sha256(note.audio ?? `${note.kitchenId}\n${note.transcript.trim().replace(/\s+/g, " ").toLowerCase()}`);
  const existing = await db.query<{ id: string; draft_id: string; read_back: string; warnings: Warning[]; events: NewEvent[]; draft: NoteDraft; extractor: { name: string } }>(
    `select e.id, d.id as draft_id, d.draft->>'readBack' as read_back, d.warnings, d.events, d.draft->'draft' as draft, d.extractor
       from evidence e join drafts d on d.evidence_id = e.id where e.sha256 = $1`,
    [hash],
  );
  const prior = existing[0];
  if (prior) {
    await audit(db, note.kitchenId, "ingest_note", prior.id, "duplicate_ignored");
    return { duplicateOf: prior.id, draftId: prior.draft_id, readBack: prior.read_back, warnings: prior.warnings, events: prior.events, draft: prior.draft, extractor: prior.extractor.name };
  }

  const store = new EventStore(db);
  const ledger = await store.ledger();
  const kitchen = ledger.parties.get(note.kitchenId);
  const ctx: ExtractContext = {
    kitchenName: kitchen?.name ?? note.kitchenId,
    date: note.date,
    ingredients: [...ledger.ingredients.values()].map((i) => ({ name: i.name, aliases: i.aliases })),
    products: [...ledger.products.values()].map((p) => p.name),
    buyers: [...ledger.parties.values()].filter((p) => p.role === "buyer").map((p) => p.name),
  };
  const evidenceId = `evd-${hash.slice(0, 12)}`;
  const draftId = `drf-${hash.slice(0, 12)}`;
  const { draft, meta } = await extractor.extract(note.transcript, ctx);
  const grounded = groundDraft(note.transcript, draft, ctx);
  const r = reconcile(project(await store.all()), grounded.draft, {
    kitchenId: note.kitchenId, date: note.date, evidenceId, batchId: `b-${hash.slice(0, 10)}`, issues: grounded.issues,
  });
  await db.tx(async (t) => {
    await t.query("insert into evidence (id, kind, sha256, party, content) values ($1,$2,$3,$4,$5)", [evidenceId, note.audio ? "audio" : "text", hash, note.kitchenId, note.transcript]);
    await t.query(
      "insert into drafts (id, evidence_id, party, status, draft, events, warnings, extractor) values ($1,$2,$3,'pending',$4,$5,$6,$7)",
      [draftId, evidenceId, note.kitchenId, JSON.stringify({ draft: grounded.draft, issues: grounded.issues, readBack: r.readBack }), JSON.stringify(r.events), JSON.stringify(r.warnings), JSON.stringify({ name: extractor.name, ...meta })],
    );
    await audit(t, note.kitchenId, "ingest_note", evidenceId, "draft_created", { extractor: extractor.name, removed: grounded.issues.length });
  });
  return { duplicateOf: null, draftId, readBack: r.readBack, warnings: r.warnings, events: r.events, draft: grounded.draft, extractor: extractor.name };
}

/** The kitchen said yes to the read-back. Events are written once. */
export async function acceptDraft(db: Db, draftId: Id, by: Id) {
  return db.tx(async (t) => {
    const rows = await t.query<{ status: string; events: NewEvent[] }>("select status, events from drafts where id = $1 for update", [draftId]);
    const d = rows[0];
    if (!d) throw new Error("No such draft");
    if (d.status === "discarded") throw new Error("Draft was discarded");
    const res = await new EventStore(t).append(d.events, t);
    await t.query("update drafts set status = 'accepted', decided_by = $2 where id = $1", [draftId, by]);
    await audit(t, by, "accept_draft", draftId, d.status === "accepted" ? "already_accepted" : "accepted", res);
    return res;
  });
}
