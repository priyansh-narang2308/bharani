import { traceImpact } from "@/core/impact";
import { rankQuestions } from "@/core/questions";
import type { Id } from "@/core/types";
import type { Db } from "@/server/db";
import { audit, EventStore, sha256 } from "@/server/store";
import { CrashError, type Gateway } from "./gateway";
import { draftNotices, draftScheduleI } from "./notices";

export type ToolName =
  | "trace_impact"
  | "rank_questions"
  | "draft_notices"
  | "request_approval"
  | "send_notice"
  | "draft_schedule_i";

/** Tools the agent may call. Everything else is refused and audited. */
export const AGENT_TOOLS: readonly ToolName[] = ["trace_impact", "rank_questions", "draft_notices", "request_approval", "send_notice", "draft_schedule_i"];

/**
 * Decisions only people make. They have no agent tool at all, so a model
 * cannot reach them by asking cleverly.
 */
export const HUMAN_ONLY = ["decide_approval", "confirm_link", "close_investigation"] as const;
export const NEVER = ["declare_safe", "declare_recall_unnecessary", "file_with_regulator", "delete_records", "edit_notice_after_approval"] as const;

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}
export type ToolResult = { ok: true; output: unknown; cached: boolean } | { ok: false; error: string; retryable: boolean; denied?: boolean };

export interface RuntimeOptions {
  brand: string;
  contact: string;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
}
export const RUNTIME_DEFAULTS: RuntimeOptions = { brand: "Bharani collective", contact: "the coordinator", timeoutMs: 2000, maxAttempts: 3, backoffMs: 50 };

export class ToolRuntime {
  constructor(private db: Db, private gateway: Gateway, private opts: RuntimeOptions = RUNTIME_DEFAULTS) {}

  async call(investigationId: Id, call: ToolCall, actor = "agent"): Promise<ToolResult> {
    if (!(AGENT_TOOLS as readonly string[]).includes(call.tool)) {
      const kind = (NEVER as readonly string[]).includes(call.tool) ? "never_allowed" : (HUMAN_ONLY as readonly string[]).includes(call.tool) ? "human_only" : "unknown_tool";
      await audit(this.db, actor, call.tool, investigationId, `denied:${kind}`, call.args);
      return { ok: false, error: `Refused: ${call.tool} is ${kind.replace("_", " ")}`, retryable: false, denied: true };
    }
    const inv = (await this.db.query<{ flagged: string[]; reason: string; state: string }>("select flagged, reason, state from investigations where id = $1", [investigationId]))[0];
    if (!inv) return { ok: false, error: "No such investigation", retryable: false };
    if (inv.state === "closed") return { ok: false, error: "Investigation is closed", retryable: false, denied: true };

    const store = new EventStore(this.db);
    const ledger = await store.ledger();
    // Read results depend on the ledger, so the revision is part of the step key.
    const key = `${call.tool}:${sha256(JSON.stringify({ args: call.args, rev: call.tool === "send_notice" ? 0 : ledger.rev })).slice(0, 16)}`;
    const done = (await this.db.query<{ status: string; output: unknown }>("select status, output from agent_steps where investigation_id = $1 and step_key = $2", [investigationId, key]))[0];
    if (done?.status === "done") return { ok: true, output: done.output, cached: true };

    await this.db.query(
      `insert into agent_steps (investigation_id, step_key, status, attempts) values ($1,$2,'running',1)
       on conflict (investigation_id, step_key) do update set status = 'running', attempts = agent_steps.attempts + 1, updated_at = now()`,
      [investigationId, key],
    );
    try {
      const output = await this.exec(investigationId, inv, call, ledger);
      await this.db.query("update agent_steps set status = 'done', output = $3, error = null where investigation_id = $1 and step_key = $2", [investigationId, key, JSON.stringify(output ?? null)]);
      await audit(this.db, actor, call.tool, investigationId, "ok", call.args);
      return { ok: true, output, cached: false };
    } catch (e) {
      if (e instanceof CrashError) throw e;
      const error = e instanceof Error ? e.message : String(e);
      const retryable = !(e instanceof PolicyError);
      await this.db.query("update agent_steps set status = 'failed', error = $3 where investigation_id = $1 and step_key = $2", [investigationId, key, error]);
      await audit(this.db, actor, call.tool, investigationId, e instanceof PolicyError ? "denied:policy" : "error", { ...call.args, error });
      return { ok: false, error, retryable, denied: e instanceof PolicyError };
    }
  }

  private async exec(investigationId: Id, inv: { flagged: string[]; reason: string }, call: ToolCall, ledger: Awaited<ReturnType<EventStore["ledger"]>>) {
    switch (call.tool as ToolName) {
      case "trace_impact":
        return summarise(traceImpact(ledger, inv.flagged));
      case "rank_questions": {
        const events = await new EventStore(this.db).all();
        return rankQuestions(events, inv.flagged).slice(0, 8).map((q) => ({ key: q.key, ask: q.askParty, text: q.text, jarsSettledAtLeast: q.jarsSettledAtLeast }));
      }
      case "draft_notices": {
        const report = traceImpact(ledger, inv.flagged);
        const notices = draftNotices(ledger, report, this.opts.brand, this.opts.contact);
        for (const n of notices) {
          await this.db.query(
            "insert into notices (id, investigation_id, recipient, channel, body, facts, body_hash) values ($1,$2,$3,'sms',$4,$5,$6) on conflict (id) do nothing",
            [n.id, investigationId, n.recipient, n.body, JSON.stringify({ phone: n.phone, worst: n.worst, facts: n.facts }), n.bodyHash],
          );
        }
        return notices.map((n) => ({ id: n.id, recipient: n.recipientName, phone: n.phone, worst: n.worst, jars: n.facts.reduce((s, f) => s + f.jars, 0) }));
      }
      case "request_approval": {
        const ids = (call.args.noticeIds as string[] | undefined) ?? [];
        if (ids.length === 0) throw new PolicyError("Nothing to approve");
        const rows = await this.db.query<{ id: string; body_hash: string }>("select id, body_hash from notices where investigation_id = $1 and id = any($2) order by id", [investigationId, ids]);
        if (rows.length !== ids.length) throw new PolicyError("Unknown notice in approval request");
        const payloadHash = sha256(rows.map((r) => `${r.id}:${r.body_hash}`).join("\n"));
        const id = `apr-${payloadHash.slice(0, 12)}`;
        await this.db.query(
          "insert into approvals (id, investigation_id, action, notice_ids, payload_hash, status) values ($1,$2,'send_notices',$3,$4,'pending') on conflict (id) do nothing",
          [id, investigationId, rows.map((r) => r.id), payloadHash],
        );
        return { approvalId: id, status: "pending" };
      }
      case "send_notice":
        return this.send(investigationId, String(call.args.approvalId), String(call.args.noticeId));
      case "draft_schedule_i":
        return draftScheduleI(ledger, traceImpact(ledger, inv.flagged), inv.reason);
    }
  }

  /** Sends one approved notice through the outbox. Safe to call any number of times. */
  private async send(investigationId: Id, approvalId: Id, noticeId: Id) {
    const approval = (await this.db.query<{ status: string; notice_ids: string[]; payload_hash: string }>("select status, notice_ids, payload_hash from approvals where id = $1 and investigation_id = $2", [approvalId, investigationId]))[0];
    if (!approval || approval.status !== "approved") throw new PolicyError("No approval from a person for this notice");
    if (!approval.notice_ids.includes(noticeId)) throw new PolicyError("Notice is not part of the approved set");
    const notices = await this.db.query<{ id: string; body: string; body_hash: string; facts: { phone: string | null } }>("select id, body, body_hash, facts from notices where id = any($1) order by id", [approval.notice_ids]);
    const current = sha256(notices.map((r) => `${r.id}:${sha256(r.body)}`).join("\n"));
    if (current !== approval.payload_hash) throw new PolicyError("Notice text changed after approval");
    const notice = notices.find((n) => n.id === noticeId);
    if (!notice) throw new PolicyError("Notice missing");
    // Records may have changed since the person approved. Stale notices are not sent.
    const inv = (await this.db.query<{ flagged: string[] }>("select flagged from investigations where id = $1", [investigationId]))[0];
    const ledger = await new EventStore(this.db).ledger();
    const fresh = draftNotices(ledger, traceImpact(ledger, inv?.flagged ?? []), this.opts.brand, this.opts.contact);
    if (!fresh.some((n) => n.id === noticeId)) throw new PolicyError("Records changed after approval. The notice must be redrafted and approved again");
    if (!notice.facts.phone) throw new PolicyError("Recipient has no phone number on record");

    const idemKey = `${approvalId}:${noticeId}`;
    await this.db.query("insert into outbox (idem_key, approval_id, notice_id, status) values ($1,$2,$3,'queued') on conflict do nothing", [idemKey, approvalId, noticeId]);
    const row = (await this.db.query<{ status: string; external_ref: string | null }>("select status, external_ref from outbox where idem_key = $1", [idemKey]))[0];
    if (row?.status === "sent") return { status: "sent", ref: row.external_ref, alreadySent: true };

    let lastError = "";
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs);
      try {
        const { ref } = await Promise.race([
          this.gateway.send({ to: notice.facts.phone, channel: "sms", body: notice.body }, idemKey, ctl.signal),
          new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new Error("timeout")))),
        ]);
        await this.db.query("update outbox set status = 'sent', attempts = attempts + 1, external_ref = $2, last_error = null where idem_key = $1", [idemKey, ref]);
        return { status: "sent", ref, attempts: attempt, simulated: this.gateway.simulated };
      } catch (e) {
        if (e instanceof CrashError) throw e;
        lastError = e instanceof Error ? e.message : String(e);
        await this.db.query("update outbox set attempts = attempts + 1, last_error = $2 where idem_key = $1", [idemKey, lastError]);
        if (attempt < this.opts.maxAttempts) await new Promise((r) => setTimeout(r, this.opts.backoffMs * 2 ** (attempt - 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    await this.db.query("update outbox set status = 'failed' where idem_key = $1", [idemKey]);
    throw new Error(`Not sent after ${this.opts.maxAttempts} attempts: ${lastError}`);
  }
}

export class PolicyError extends Error {}

function summarise(r: ReturnType<typeof traceImpact>) {
  return {
    rev: r.rev,
    jars: r.jars,
    unknownRecipientJars: r.unknownRecipientJars,
    unaccountedJars: r.unaccountedJars,
    recipientListComplete: r.recipientListComplete,
    blockers: r.blockers.map((b) => b.message),
    batches: r.batches.filter((b) => b.status !== "no_recorded_link").map((b) => ({ batch: b.batchCode ?? b.batchId, status: b.status, dependsOn: b.condition, gaps: b.gaps.map((g) => g.text) })),
    recipients: r.recipients.map((x) => ({ name: x.name, jars: x.jars, contactable: x.contactable })),
  };
}

/** Human actions. They are separate functions so no agent tool can reach them. */
export async function decideApproval(db: Db, approvalId: Id, by: Id, approve: boolean) {
  if (by === "agent") throw new PolicyError("The agent cannot approve its own request");
  const rows = await db.query("update approvals set status = $2, decided_by = $3, decided_at = now() where id = $1 and status = 'pending' returning id", [approvalId, approve ? "approved" : "rejected", by]);
  await audit(db, by, "decide_approval", approvalId, rows.length ? (approve ? "approved" : "rejected") : "not_pending");
  return rows.length > 0;
}
export async function closeInvestigation(db: Db, investigationId: Id, by: Id, note: string) {
  if (by === "agent") throw new PolicyError("Only a person can close an investigation");
  await db.query("update investigations set state = 'closed', closed_by = $2 where id = $1", [investigationId, by]);
  await audit(db, by, "close_investigation", investigationId, "closed", { note });
}
export async function openInvestigation(db: Db, id: Id, flagged: Id[], reason: string, by: Id) {
  await db.query("insert into investigations (id, flagged, reason, state, opened_by) values ($1,$2,$3,'open',$4) on conflict (id) do nothing", [id, flagged, reason, by]);
  await audit(db, by, "open_investigation", id, "opened", { flagged, reason });
}
