import { runInvestigation } from "@/agent/planner";
import { app, INVESTIGATION } from "@/server/app";

export async function POST() {
  const { db, runtime } = await app();
  const log = await runInvestigation(db, runtime, INVESTIGATION);
  return Response.json(log);
}
