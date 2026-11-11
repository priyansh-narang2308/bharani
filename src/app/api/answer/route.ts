import type { NewEvent } from "@/core/types";
import { app } from "@/server/app";
import { audit, EventStore } from "@/server/store";

const HUMAN_EVENTS = new Set(["link.confirmed", "link.rejected", "link.reopened", "input.source_unknown", "batch.corrected", "dispatch.corrected", "dispatch.recorded", "party.updated", "stock.counted", "loss.recorded"]);

/** A person records an answer or a correction. Each becomes one new event; nothing is overwritten. */
export async function POST(req: Request) {
  const { events, by } = (await req.json()) as { events: NewEvent[]; by: string };
  const { db } = await app();
  for (const e of events) if (!HUMAN_EVENTS.has(e.type)) return Response.json({ error: `Not allowed: ${e.type}` }, { status: 400 });
  const stamped = events.map((e, i) => ({ ...e, id: `h-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`, actor: by, at: new Date().toISOString().slice(0, 10) })) as NewEvent[];
  const res = await new EventStore(db).append(stamped);
  await audit(db, by, "record_answer", null, "ok", { types: stamped.map((e) => e.type) });
  return Response.json(res);
}
