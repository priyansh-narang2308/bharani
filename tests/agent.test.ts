import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrashError, SimulatedGateway, type Faults } from "@/agent/gateway";
import { runInvestigation } from "@/agent/planner";
import { closeInvestigation, decideApproval, openInvestigation, RUNTIME_DEFAULTS, ToolRuntime } from "@/agent/runtime";
import { DEMO_REASON, FLAGGED_LOT, scenario } from "@/demo/scenario";
import { openDb, type Db } from "@/server/db";
import { EventStore } from "@/server/store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(faults: Faults = {}, dir?: string) {
  const db = await openDb(dir);
  await new EventStore(db).append(scenario());
  await openInvestigation(db, "inv-1", [FLAGGED_LOT], DEMO_REASON, "coord-asha");
  const gateway = new SimulatedGateway(faults);
  const runtime = new ToolRuntime(db, gateway, { ...RUNTIME_DEFAULTS, timeoutMs: 100, backoffMs: 5 });
  return { db, gateway, runtime };
}
const pendingApproval = async (db: Db) => (await db.query<{ id: string; notice_ids: string[] }>("select id, notice_ids from approvals where status = 'pending'"))[0];
const auditRows = (db: Db, outcome: string) => db.query<{ action: string }>("select action from audit where outcome like $1", [outcome]);

describe("investigation agent", () => {
  it("stops for a person before sending anything", async () => {
    const { db, gateway, runtime } = await setup();
    const run = await runInvestigation(db, runtime, "inv-1");
    expect(run.steps.map((s) => s.call.tool)).toEqual(["trace_impact", "rank_questions", "draft_notices", "request_approval"]);
    expect(run.stoppedBecause).toMatch(/approve/);
    expect(gateway.calls).toBe(0);
    const a = await pendingApproval(db);
    expect(a?.notice_ids.length).toBe(2);
  });

  it("required case 10: unauthorised actions are refused and recorded", async () => {
    const { db, gateway, runtime } = await setup();
    await runInvestigation(db, runtime, "inv-1");
    const a = await pendingApproval(db);
    for (const tool of ["declare_safe", "declare_recall_unnecessary", "close_investigation", "decide_approval", "file_with_regulator", "transfer_money"]) {
      const r = await runtime.call("inv-1", { tool, args: {} });
      expect(r.ok).toBe(false);
    }
    const early = await runtime.call("inv-1", { tool: "send_notice", args: { approvalId: a?.id, noticeId: a?.notice_ids[0] } });
    expect(early).toMatchObject({ ok: false, denied: true });
    await expect(decideApproval(db, a?.id ?? "", "agent", true)).rejects.toThrow();
    await expect(closeInvestigation(db, "inv-1", "agent", "")).rejects.toThrow();
    expect(gateway.calls).toBe(0);
    expect((await auditRows(db, "denied:%")).length).toBe(7);
  });

  it("sends approved notices once, then waits because the list is incomplete", async () => {
    const { db, gateway, runtime } = await setup();
    await runInvestigation(db, runtime, "inv-1");
    await decideApproval(db, (await pendingApproval(db))?.id ?? "", "coord-asha", true);
    const run = await runInvestigation(db, runtime, "inv-1");
    expect(gateway.delivered.size).toBe(2);
    expect(run.stoppedBecause).toMatch(/no phone number|not complete/);
    const again = await runInvestigation(db, runtime, "inv-1");
    expect(again.steps.filter((s) => s.call.tool === "send_notice").every((s) => s.result.ok && s.result.cached)).toBe(true);
    expect(gateway.calls).toBe(2);
    const state = (await db.query<{ state: string }>("select state from investigations"))[0];
    expect(state?.state).toBe("open");
  });

  it("required case 9: a repeated or lost provider reply does not double send", async () => {
    const { db, gateway, runtime } = await setup({ loseReplyOnCalls: [1] });
    await runInvestigation(db, runtime, "inv-1");
    await decideApproval(db, (await pendingApproval(db))?.id ?? "", "coord-asha", true);
    await runInvestigation(db, runtime, "inv-1");
    expect(gateway.calls).toBe(3);
    expect(gateway.delivered.size).toBe(2);
    const sent = await db.query<{ status: string; attempts: number }>("select status, attempts from outbox order by idem_key");
    expect(sent.every((s) => s.status === "sent")).toBe(true);
  });

  it("required case 11: a hanging provider times out, retries, then gives up honestly", async () => {
    const { db, gateway, runtime } = await setup({ hangOnCalls: [1, 3, 4, 5] });
    await runInvestigation(db, runtime, "inv-1");
    await decideApproval(db, (await pendingApproval(db))?.id ?? "", "coord-asha", true);
    const run = await runInvestigation(db, runtime, "inv-1");
    const statuses = await db.query<{ status: string; last_error: string | null }>("select status, last_error from outbox order by idem_key");
    expect(statuses.map((s) => s.status).sort()).toEqual(["failed", "sent"]);
    expect(statuses.find((s) => s.status === "failed")?.last_error).toBe("timeout");
    expect(run.stoppedBecause).toMatch(/could not be sent/);
    expect(gateway.delivered.size).toBe(1);
  });

  it("required case 12: resumes after a crash without repeating sends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bharani-"));
    dirs.push(dir);
    const first = await setup({ crashAfterDeliveries: 1 }, dir);
    await runInvestigation(first.db, first.runtime, "inv-1");
    await decideApproval(first.db, (await pendingApproval(first.db))?.id ?? "", "coord-asha", true);
    await expect(runInvestigation(first.db, first.runtime, "inv-1")).rejects.toBeInstanceOf(CrashError);
    await first.db.close();

    // Same provider state, new process.
    const db = await openDb(dir);
    const runtime = new ToolRuntime(db, first.gateway, { ...RUNTIME_DEFAULTS, timeoutMs: 100, backoffMs: 5 });
    const run = await runInvestigation(db, runtime, "inv-1");
    expect(first.gateway.delivered.size).toBe(2);
    expect(run.steps.filter((s) => s.call.tool === "send_notice").length).toBe(2);
    const sent = await db.query<{ status: string }>("select status from outbox");
    expect(sent.map((s) => s.status)).toEqual(["sent", "sent"]);
    expect((await db.query("select * from events")).length).toBe(scenario().length);
    await db.close();
  });

  it("does not send an approved notice after the records change", async () => {
    const { db, gateway, runtime } = await setup();
    await runInvestigation(db, runtime, "inv-1");
    const a = await pendingApproval(db);
    await decideApproval(db, a?.id ?? "", "coord-asha", true);
    await new EventStore(db).append([{ type: "link.confirmed", id: "fix-1", at: "2026-10-21", actor: "coord-asha", linkId: "lk-m1102-gm" }]);
    const results = [];
    for (const noticeId of a?.notice_ids ?? []) results.push(await runtime.call("inv-1", { tool: "send_notice", args: { approvalId: a?.id, noticeId } }));
    expect(results.some((r) => !r.ok && r.denied)).toBe(true);
    expect(gateway.delivered.size).toBeLessThan(2);
  });

  it("never puts a possibly affected line under a confirmed statement", async () => {
    const { db, runtime } = await setup();
    await runInvestigation(db, runtime, "inv-1");
    const notices = await db.query<{ recipient: string; body: string }>("select recipient, body from notices");
    const sharma = notices.find((n) => n.recipient === "b-sharma")?.body ?? "";
    const lines = sharma.split("\n");
    const confirmedAt = lines.findIndex((l) => l.startsWith("Records show"));
    const mayAt = lines.findIndex((l) => l.startsWith("These jars may contain"));
    const m1102 = lines.findIndex((l) => l.includes("M-1102"));
    const m1101 = lines.findIndex((l) => l.includes("M-1101"));
    expect(confirmedAt).toBeGreaterThanOrEqual(0);
    expect(m1101).toBeGreaterThan(confirmedAt);
    expect(m1101).toBeLessThan(mayAt);
    expect(m1102).toBeGreaterThan(mayAt);
    const hostel = notices.find((n) => n.recipient === "b-hostel")?.body ?? "";
    expect(hostel).toMatch(/cannot yet rule them in or out\.\n- Mango pickle, batch L-1105/);
  });

  it("drafts Schedule I fields with unknowns marked, and files nothing", async () => {
    const { runtime } = await setup();
    const r = await runtime.call("inv-1", { tool: "draft_schedule_i", args: {} });
    expect(r.ok).toBe(true);
    const out = (r as { output: Record<string, unknown> }).output;
    expect(out.distributionListComplete).toMatch(/Incomplete/);
    expect(out.fssaiLicence).toMatch(/Not in records/);
  });
});

describe("required case 6: duplicate voice submissions", () => {
  it("returns the first draft and writes events once", async () => {
    const { ingestNote, acceptDraft } = await import("@/server/ingest");
    const { RuleExtractor } = await import("@/extract/rules");
    const db = await openDb();
    await new EventStore(db).append(scenario());
    const note = { kitchenId: "k-meena", date: "2026-10-22", transcript: "aaj Mango pickle banaya 40 dabbe, kairi 12 kilo, namak dedh kilo, mirchi 1 kilo" };
    const a = await ingestNote(db, new RuleExtractor(), note);
    const b = await ingestNote(db, new RuleExtractor(), { ...note, transcript: `  ${note.transcript.toUpperCase()} ` });
    expect(a.duplicateOf).toBeNull();
    expect(b.duplicateOf).not.toBeNull();
    expect(b.draftId).toBe(a.draftId);
    const before = (await db.query("select * from events")).length;
    const w1 = await acceptDraft(db, a.draftId, "k-meena");
    const w2 = await acceptDraft(db, a.draftId, "k-meena");
    expect(w1.written).toBeGreaterThan(0);
    expect(w2.written).toBe(0);
    expect((await db.query("select * from events")).length).toBe(before + w1.written);
    await db.close();
  });
});
