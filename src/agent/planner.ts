import type { Id } from "@/core/types";
import type { Db } from "@/server/db";
import type { ToolCall, ToolResult, ToolRuntime } from "./runtime";

export type Step = { call: ToolCall } | { wait: string } | { done: string };

export interface InvestigationView {
  id: Id;
  state: string;
  trace: { recipientListComplete: boolean; recipients: { name: string }[] } | null;
  notices: { id: string; recipient: string; phone: string | null }[];
  approvals: { id: string; status: string; notice_ids: string[] }[];
  outbox: { notice_id: string; status: string }[];
}

export async function view(db: Db, id: Id, lastTrace: InvestigationView["trace"]): Promise<InvestigationView> {
  const inv = (await db.query<{ state: string }>("select state from investigations where id = $1", [id]))[0];
  const notices = await db.query<{ id: string; recipient: string; facts: { phone: string | null } }>("select id, recipient, facts from notices where investigation_id = $1 order by id", [id]);
  return {
    id,
    state: inv?.state ?? "missing",
    trace: lastTrace,
    notices: notices.map((n) => ({ id: n.id, recipient: n.recipient, phone: n.facts.phone })),
    approvals: await db.query("select id, status, notice_ids from approvals where investigation_id = $1 order by id", [id]),
    outbox: await db.query("select o.notice_id, o.status from outbox o join approvals a on a.id = o.approval_id where a.investigation_id = $1", [id]),
  };
}

/**
 * The default planner: a fixed procedure over typed tools. Every step it takes
 * is visible in the journal and the audit log. It stops and waits whenever a
 * person must decide.
 */
export class RulePlanner {
  next(v: InvestigationView, traced: boolean, questionsRanked: boolean, notesDrafted: boolean): Step {
    if (v.state === "closed") return { done: "Closed by a person" };
    if (!traced) return { call: { tool: "trace_impact", args: {} } };
    if (!questionsRanked) return { call: { tool: "rank_questions", args: {} } };
    if (!notesDrafted) return { call: { tool: "draft_notices", args: {} } };
    const sendable = v.notices.filter((n) => n.phone);
    const covered = new Set(v.approvals.filter((a) => a.status !== "rejected").flatMap((a) => a.notice_ids));
    const uncovered = sendable.filter((n) => !covered.has(n.id)).map((n) => n.id);
    if (uncovered.length > 0) return { call: { tool: "request_approval", args: { noticeIds: uncovered } } };
    for (const a of v.approvals) {
      if (a.status !== "approved") continue;
      for (const nid of a.notice_ids) {
        const out = v.outbox.find((o) => o.notice_id === nid);
        if (!out || out.status === "queued") return { call: { tool: "send_notice", args: { approvalId: a.id, noticeId: nid } } };
      }
    }
    if (v.approvals.some((a) => a.status === "pending")) return { wait: "Waiting for a person to approve the notices" };
    const failed = v.outbox.filter((o) => o.status === "failed").length;
    if (failed > 0) return { wait: `${failed} notices could not be sent. A person must decide what to do` };
    if (v.notices.some((n) => !n.phone)) return { wait: "Some recipients have no phone number. A person must reach them" };
    if (v.trace && !v.trace.recipientListComplete) return { wait: "Notices sent to known recipients. The recipient list is not complete, so the investigation stays open" };
    return { wait: "Notices sent. Only a person can close this investigation" };
  }
}

export interface RunLog {
  steps: { call: ToolCall; result: ToolResult }[];
  stoppedBecause: string;
}

/** Runs the planner until it has to wait. Re-running after a crash resumes from the journal. */
export async function runInvestigation(db: Db, runtime: ToolRuntime, id: Id, maxSteps = 50): Promise<RunLog> {
  const planner = new RulePlanner();
  const log: RunLog = { steps: [], stoppedBecause: "" };
  let traced = false;
  let ranked = false;
  let drafted = false;
  let lastTrace: InvestigationView["trace"] = null;
  for (let i = 0; i < maxSteps; i++) {
    const step = planner.next(await view(db, id, lastTrace), traced, ranked, drafted);
    if ("wait" in step) return { ...log, stoppedBecause: step.wait };
    if ("done" in step) return { ...log, stoppedBecause: step.done };
    const result = await runtime.call(id, step.call);
    log.steps.push({ call: step.call, result });
    if (step.call.tool === "trace_impact" && result.ok) {
      traced = true;
      lastTrace = result.output as InvestigationView["trace"];
    }
    if (step.call.tool === "rank_questions" && result.ok) ranked = true;
    if (step.call.tool === "draft_notices" && result.ok) drafted = true;
    if (!result.ok && step.call.tool === "send_notice") {
      // The outbox row is now failed, so the planner will stop and ask a person.
      continue;
    }
    if (!result.ok) return { ...log, stoppedBecause: `Stopped: ${result.error}` };
  }
  return { ...log, stoppedBecause: "Step limit reached" };
}
