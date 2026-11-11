import { createHash } from "node:crypto";
import { project } from "@/core/ledger";
import type { Ledger, LedgerEvent, NewEvent } from "@/core/types";
import type { Db } from "./db";

export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/**
 * Append-only event store. An event id can be written once; writing it again
 * is a no-op, which makes retries and replays safe.
 */
export class EventStore {
  constructor(private db: Db) {}
  async append(events: NewEvent[], db: Db = this.db): Promise<{ written: number; skipped: number }> {
    let written = 0;
    for (const e of events) {
      const { id, type, at, actor, evidence, ...body } = e as NewEvent & { evidence?: string[] };
      const rows = await db.query(
        `insert into events (id, type, at, actor, evidence, body) values ($1,$2,$3,$4,$5,$6)
         on conflict (id) do nothing returning seq`,
        [id, type, at, actor, evidence ?? [], JSON.stringify(body)],
      );
      written += rows.length;
    }
    return { written, skipped: events.length - written };
  }
  async all(db: Db = this.db): Promise<LedgerEvent[]> {
    const rows = await db.query<{ seq: string; id: string; type: string; at: string; actor: string; evidence: string[]; body: Record<string, unknown> }>(
      "select seq, id, type, at, actor, evidence, body from events order by seq",
    );
    return rows.map((r) => ({ ...r.body, seq: Number(r.seq), id: r.id, type: r.type, at: r.at, actor: r.actor, evidence: r.evidence }) as LedgerEvent);
  }
  async ledger(db: Db = this.db): Promise<Ledger> {
    return project(await this.all(db));
  }
}

export async function audit(db: Db, actor: string, action: string, subject: string | null, outcome: string, detail: object = {}) {
  await db.query("insert into audit (actor, action, subject, outcome, detail) values ($1,$2,$3,$4,$5)", [actor, action, subject, outcome, JSON.stringify(detail)]);
}
