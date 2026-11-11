import { app } from "@/server/app";
import { ingestNote } from "@/server/ingest";

export async function POST(req: Request) {
  const body = (await req.json()) as { kitchenId: string; transcript: string; date?: string };
  if (!body.transcript?.trim()) return Response.json({ error: "Empty note" }, { status: 400 });
  const { db, extractor } = await app();
  try {
    return Response.json(await ingestNote(db, extractor, { kitchenId: body.kitchenId, date: body.date ?? new Date().toISOString().slice(0, 10), transcript: body.transcript }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
