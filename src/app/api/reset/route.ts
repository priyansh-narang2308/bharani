import { reset } from "@/server/app";

export async function POST() {
  await reset();
  return Response.json({ ok: true });
}
