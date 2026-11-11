import { app } from "@/server/app";
import { acceptDraft } from "@/server/ingest";
import { audit } from "@/server/store";

export async function POST(req: Request) {
  const { draftId, action, by } = (await req.json()) as { draftId: string; action: "accept" | "discard"; by: string };
  const { db } = await app();
  if (action === "accept") return Response.json(await acceptDraft(db, draftId, by));
  await db.query("update drafts set status = 'discarded', decided_by = $2 where id = $1 and status = 'pending'", [draftId, by]);
  await audit(db, by, "discard_draft", draftId, "discarded");
  return Response.json({ ok: true });
}
