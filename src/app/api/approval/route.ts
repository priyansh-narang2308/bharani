import { decideApproval } from "@/agent/runtime";
import { app } from "@/server/app";

export async function POST(req: Request) {
  const { approvalId, approve, by } = (await req.json()) as { approvalId: string; approve: boolean; by: string };
  const { db } = await app();
  try {
    return Response.json({ changed: await decideApproval(db, approvalId, by, approve) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 403 });
  }
}
