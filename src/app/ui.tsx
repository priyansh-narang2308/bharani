"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Snapshot } from "@/server/state";

type Status = "confirmed" | "conditional" | "undetermined" | "no_recorded_link";
const LABEL: Record<Status, string> = { confirmed: "Confirmed", conditional: "Conditional", undetermined: "Undetermined", no_recorded_link: "No recorded link" };
const COORD = "coord-asha";

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}
const Chip = ({ s }: { s: Status }) => <span className={`chip s-${s}`}>{LABEL[s]}</span>;

export function Workbench() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<"investigation" | "kitchen" | "lineage" | "audit">("investigation");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => setSnap(await (await fetch("/api/state", { cache: "no-store" })).json()), []);
  useEffect(() => { void refresh(); }, [refresh]);
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    await refresh(); setBusy(false);
  }, [refresh]);

  if (!snap) return <div className="shell">Loading the ledger…</div>;
  return (
    <div className="shell">
      <div className="top">
        <span className="brand">Bharani</span>
        <span className="tag">Ledger revision {snap.rev}</span>
        <span className="tag">Note reader: {snap.extractor}</span>
        {snap.gatewaySimulated && <span className="tag sim">Messages are simulated. Nothing is sent.</span>}
        <span className="tag sim">Demo data is fictional</span>
        <span style={{ flex: 1 }} />
        <button disabled={busy} onClick={() => act(() => post("/api/reset", {}))}>Reset demo</button>
      </div>
      <div className="tabs" role="tablist">
        {(["investigation", "kitchen", "lineage", "audit"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {{ investigation: "Investigation", kitchen: "Kitchen voice log", lineage: "Lineage explorer", audit: "Audit trail" }[t]}
          </button>
        ))}
      </div>
      {error && <p className="err">{error}</p>}
      {tab === "investigation" && <Investigation snap={snap} busy={busy} act={act} />}
      {tab === "kitchen" && <Kitchen snap={snap} busy={busy} act={act} />}
      {tab === "lineage" && <Lineage snap={snap} />}
      {tab === "audit" && <Audit snap={snap} />}
    </div>
  );
}

type Props = { snap: Snapshot; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> };

function Investigation({ snap, busy, act }: Props) {
  const r = snap.report;
  const [open, setOpen] = useState<string | null>(null);
  const [agentLog, setAgentLog] = useState<{ steps: { call: { tool: string }; result: { ok: boolean; error?: string; cached?: boolean } }[]; stoppedBecause: string } | null>(null);
  const affected = snap.batches.filter((b) => b.status !== "no_recorded_link");
  return (
    <div className="grid">
      <div>
        <div className="card">
          <h2>Flagged: {snap.flaggedLabels.join(", ")}</h2>
          <p className="muted" style={{ marginTop: 0 }}>{snap.investigation?.reason}</p>
          <div className="tiles">
            {(Object.keys(LABEL) as Status[]).map((s) => (
              <div key={s} className={`tile s-${s}`}><b>{r.jars[s]}</b><span>jars {LABEL[s].toLowerCase()}</span></div>
            ))}
          </div>
          <div className={`coverage ${r.recipientListComplete ? "ok" : ""}`}>
            {r.recipientListComplete
              ? <><b>Recipient list is complete against the records held.</b> Food that was never written down is not covered by this statement.</>
              : <><b>The recipient list is not complete.</b> It cannot be called complete until these are resolved:<ul>{r.blockers.map((b, i) => <li key={i}>{b.message}</li>)}</ul></>}
          </div>
          {r.lots.map((l) => (
            <p key={l.lotId} className="muted" style={{ fontSize: 13 }}>
              Stock check on {l.label}: received {l.received / 1000} kg, confirmed use {l.usedConfirmed / 1000} kg, possible use {l.usedConditional / 1000} kg, counted on hand {l.onHand === null ? "not counted" : `${l.onHand / 1000} kg`}. Unexplained: {l.unexplainedMin / 1000} to {l.unexplainedMax / 1000} kg.
            </p>
          ))}
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <h2>Batches</h2>
          <div className="wrap"><table>
            <thead><tr><th>Batch</th><th>Kitchen</th><th>Made</th><th>Status</th><th>Why</th></tr></thead>
            <tbody>
              {snap.batches.map((b) => (
                <BatchRow key={b.batchId} b={b} open={open === b.batchId} toggle={() => setOpen(open === b.batchId ? null : b.batchId)} snap={snap} busy={busy} act={act} />
              ))}
            </tbody>
          </table></div>
          <p className="muted" style={{ fontSize: 12 }}>{affected.length} of {snap.batches.length} batches need attention. "No recorded link" means the records show no path from the flagged lot. It does not mean the food is safe.</p>
        </div>
      </div>

      <div>
        <div className="card">
          <h2>Questions worth asking</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Ranked by jars each answer settles, worked out by replaying every possible answer.</p>
          {snap.questions.length === 0 && <p className="muted">No open questions.</p>}
          {snap.questions.map((q) => (
            <div key={q.key} className="q">
              <div>{q.text}</div>
              <div className="meta">Ask {q.ask}. Settles at least {q.jarsSettledAtLeast} jars{q.jarsSettledAtMost !== q.jarsSettledAtLeast ? `, up to ${q.jarsSettledAtMost}` : ""}.</div>
              {q.answers.length > 0 && (
                <div className="answers">
                  {q.answers.map((a) => (
                    <button key={a.label} disabled={busy} onClick={() => act(() => post("/api/answer", { events: a.events, by: COORD }))}>
                      {a.label} <small>· leaves {a.openJarsAfter} open</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <h2>Agent</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Runs typed tools in a fixed order and stops whenever a person must decide. It cannot approve, close, or declare anything safe.</p>
          <button className="primary" disabled={busy} onClick={() => act(async () => setAgentLog(await post("/api/agent", {})))}>Run agent</button>
          {agentLog && (
            <div style={{ marginTop: 8 }}>
              {agentLog.steps.map((s, i) => (
                <div key={i} className="step"><span className="mono">{s.call.tool}</span> {s.result.ok ? (s.result.cached ? "· already done" : "· done") : <span className="err">· {s.result.error}</span>}</div>
              ))}
              <p><b>Stopped:</b> {agentLog.stoppedBecause}</p>
            </div>
          )}
          <h3>Notices</h3>
          {snap.notices.length === 0 && <p className="muted">None drafted yet.</p>}
          {(snap.notices as { id: string; recipient: string; body: string; facts: { phone: string | null } }[]).map((n) => {
            const sent = (snap.outbox as { notice_id: string; status: string; attempts: number; last_error: string | null; external_ref: string | null }[]).find((o) => o.notice_id === n.id);
            return (
              <div key={n.id}>
                <div className="row"><b>{snap.buyers.find((b) => b.id === n.recipient)?.name ?? n.recipient}</b>
                  <span className="tag">{n.facts.phone ?? "no phone on record"}</span>
                  {sent && <span className={`tag ${sent.status === "sent" ? "sim" : ""}`}>{sent.status === "sent" ? `simulated send ${sent.external_ref}` : `${sent.status}, ${sent.attempts} attempts${sent.last_error ? `: ${sent.last_error}` : ""}`}</span>}
                </div>
                <div className="notice">{n.body}</div>
              </div>
            );
          })}
          {(snap.approvals as { id: string; status: string; notice_ids: string[]; decided_by: string | null }[]).map((a) => (
            <div key={a.id} className="row" style={{ marginTop: 8 }}>
              <span>Approval for {a.notice_ids.length} notices: <b>{a.status}</b>{a.decided_by ? ` by ${a.decided_by}` : ""}</span>
              {a.status === "pending" && <>
                <button className="primary" disabled={busy} onClick={() => act(() => post("/api/approval", { approvalId: a.id, approve: true, by: COORD }))}>Approve as Asha</button>
                <button disabled={busy} onClick={() => act(() => post("/api/approval", { approvalId: a.id, approve: false, by: COORD }))}>Reject</button>
              </>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type B = Snapshot["batches"][number];
function BatchRow({ b, open, toggle, snap, busy, act }: { b: B; open: boolean; toggle: () => void } & Props) {
  const why = b.status === "confirmed" ? "Recorded path from the flagged lot"
    : b.status === "conditional" ? `True only if ${b.condition.map((c) => c.map((l) => linkLabel(b, l)).join(" and ")).join(", or ")}`
    : b.status === "undetermined" ? b.gaps.map((g) => g.text).join("; ")
    : "";
  const [buyer, setBuyer] = useState("");
  return (
    <>
      <tr onClick={toggle} style={{ cursor: "pointer" }}>
        <td><b>{b.code ?? b.batchId}</b><div className="muted" style={{ fontSize: 12 }}>{b.product}, {b.madeOn}</div></td>
        <td>{b.kitchen}</td>
        <td>{b.made ? `${b.made.value} ${b.made.unit}` : <span className="err">not given</span>}</td>
        <td><Chip s={b.status as Status} /></td>
        <td style={{ fontSize: 13 }}>{why}</td>
      </tr>
      {open && (
        <tr><td colSpan={5} style={{ background: "var(--surface-2)" }}>
          <b>Inputs as spoken</b>
          {b.inputs.map((i) => (
            <div key={i.inputId} style={{ margin: "6px 0" }}>
              “{i.text}” {i.qty ? `${i.qty.value} ${i.qty.unit}` : "(no quantity)"} · {i.ingredient ?? <span className="err">ingredient not confirmed</span>}
              {i.ref && <span className="tag" style={{ marginLeft: 6 }}>recorded: {i.ref.label}</span>}
              {i.markedUnknown && <span className="tag" style={{ marginLeft: 6 }}>kitchen cannot tell</span>}
              {i.links.map((l) => (
                <div key={l.linkId} className="row" style={{ marginLeft: 16, fontSize: 13 }}>
                  <span>{l.status === "confirmed" ? "Confirmed" : "Possible"}: {l.target.label}</span>
                  <span className="tag">{l.source === "model" ? "proposed by model" : "proposed by rules"} · score {l.score}</span>
                  <span className="muted">{l.reasons.join("; ")}</span>
                  {l.status === "proposed" && <>
                    <button disabled={busy} onClick={() => act(() => post("/api/answer", { by: COORD, events: [{ type: "link.confirmed", linkId: l.linkId }] }))}>Confirm</button>
                    <button disabled={busy} onClick={() => act(() => post("/api/answer", { by: COORD, events: [{ type: "link.rejected", linkId: l.linkId }] }))}>Rule out</button>
                  </>}
                  {l.status === "confirmed" && <button disabled={busy} onClick={() => act(() => post("/api/answer", { by: COORD, events: [{ type: "link.reopened", linkId: l.linkId, reason: "Reopened from workspace" }] }))}>Reopen</button>}
                </div>
              ))}
            </div>
          ))}
          <b>Change an ingredient lot</b>
          <div className="row" style={{ margin: "6px 0" }}>
            {snap.lots.map((l) => (
              <button key={l.lotId} disabled={busy} onClick={() => act(() => post("/api/answer", { by: COORD, events: [{ type: "batch.corrected", batchId: b.batchId, reason: "Corrected in workspace", inputs: [{ inputId: `fix-${l.lotId}`, text: l.label, ingredientId: null, qty: { value: 1, unit: "kg" }, ref: { kind: "lot", lotId: l.lotId } }] }] }))}>
                Add use of {l.label}
              </button>
            ))}
          </div>
          <b>Where the jars went</b>
          {b.dispatches.length === 0 && <div className="muted">No dispatches recorded.</div>}
          {b.dispatches.map((d) => <div key={d.dispatchId}>{d.jars} jars to {d.buyer ?? <span className="err">unknown buyer (“{d.buyerText}”)</span>} on {d.at}</div>)}
          {b.balance && b.balance.unaccounted !== null && b.balance.unaccounted > 0 && <div className="warn">{b.balance.unaccounted} jars have no recorded destination.</div>}
          <div className="row" style={{ marginTop: 6 }}>
            <select value={buyer} onChange={(e) => setBuyer(e.target.value)}><option value="">Record jars sent to…</option>{snap.buyers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            <button disabled={busy || !buyer || !b.balance?.unaccounted} onClick={() => act(() => post("/api/answer", { by: COORD, events: [{ type: "dispatch.recorded", dispatchId: `d-${Date.now()}`, batchId: b.batchId, buyerId: buyer, buyerText: "recorded in workspace", qty: { value: b.balance?.unaccounted ?? 0, unit: "jar" } }] }))}>
              Record remaining {b.balance?.unaccounted ?? 0} jars
            </button>
          </div>
        </td></tr>
      )}
    </>
  );
}
function linkLabel(b: B, linkId: string) {
  for (const i of b.inputs) for (const l of i.links) if (l.linkId === linkId) return `“${i.text}” was ${l.target.label}`;
  return linkId;
}

function Kitchen({ snap, busy, act }: Props) {
  const [kitchen, setKitchen] = useState(snap.kitchens[0]?.id ?? "");
  const [text, setText] = useState("aaj Mango pickle banaya 36 dabbe, kairi 11 kilo, sarson tel 3 litre, namak 1 kilo, laal wala powder 1 kilo");
  const [res, setRes] = useState<{ draftId: string; readBack: string; warnings: { message: string }[]; duplicateOf: string | null; extractor: string } | null>(null);
  const [listening, setListening] = useState(false);
  const speech = typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  const listen = () => {
    const W = window as unknown as Record<string, new () => { lang: string; onresult: (e: { results: { 0: { transcript: string } }[] }) => void; onend: () => void; start: () => void }>;
    const Rec = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Rec) return;
    const rec = new Rec();
    rec.lang = "hi-IN";
    rec.onresult = (e) => setText(Array.from(e.results).map((r) => r[0].transcript).join(" "));
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  };
  const drafts = snap.drafts as { id: string; status: string; party: string; draft: { readBack: string } }[];
  return (
    <div className="phone">
      <div className="row"><b>Today’s batch</b><span style={{ flex: 1 }} />
        <select value={kitchen} onChange={(e) => setKitchen(e.target.value)} aria-label="Kitchen">{snap.kitchens.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Say what you made and what went in. You can mix Hindi and English.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} aria-label="Note" />
      {speech && <button className="big" disabled={listening} onClick={listen}>{listening ? "Listening…" : "Hold to speak (browser speech recognition)"}</button>}
      <button className="big primary" disabled={busy || !text.trim()} onClick={() => act(async () => setRes(await post("/api/note", { kitchenId: kitchen, transcript: text })))}>Send note</button>
      {res && (
        <div className="card" style={{ marginTop: 12 }}>
          {res.duplicateOf && <div className="warn">This note was already sent. Showing the first one.</div>}
          <div style={{ fontSize: 17 }}>{res.readBack}</div>
          <div className="muted" style={{ fontSize: 12 }}>Read by: {res.extractor}</div>
          {res.warnings.map((w, i) => <div key={i} className="warn">{w.message}</div>)}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy} onClick={() => act(async () => { await post("/api/draft", { draftId: res.draftId, action: "accept", by: kitchen }); setRes(null); })}>Haan, sahi hai</button>
            <button disabled={busy} onClick={() => act(async () => { await post("/api/draft", { draftId: res.draftId, action: "discard", by: kitchen }); setRes(null); })}>Nahi, phir se</button>
          </div>
        </div>
      )}
      <h3 className="muted" style={{ fontSize: 12, marginTop: 16 }}>RECENT NOTES</h3>
      {drafts.map((d) => <div key={d.id} className="step">{d.draft.readBack} <span className="tag">{d.status}</span></div>)}
    </div>
  );
}

function Lineage({ snap }: { snap: Snapshot }) {
  const layout = useMemo(() => {
    const cols: { id: string; label: string; sub: string; status?: Status; kind: "lot" | "mix" | "batch" | "buyer" }[][] = [[], [], [], []];
    for (const l of snap.lots) cols[0]?.push({ id: l.lotId, label: l.label, sub: l.ingredient, kind: "lot", status: l.flagged ? "confirmed" : undefined });
    for (const b of snap.batches) (b.made?.unit === "jar" ? cols[2] : cols[1])?.push({ id: b.batchId, label: b.code ?? b.batchId, sub: `${b.kitchen} · ${b.product}`, status: b.status as Status, kind: b.made?.unit === "jar" ? "batch" : "mix" });
    const buyers = new Set<string>();
    for (const b of snap.batches) for (const d of b.dispatches) buyers.add(d.buyer ?? "Unknown buyer");
    if (snap.batches.some((b) => (b.balance?.unaccounted ?? 0) > 0)) buyers.add("No record");
    for (const name of buyers) cols[3]?.push({ id: `buyer:${name}`, label: name, sub: "", kind: "buyer" });
    const pos = new Map<string, { x: number; y: number }>();
    cols.forEach((c, ci) => c.forEach((n, ri) => pos.set(n.id, { x: 10 + ci * 240, y: 30 + ri * 64 + (ci === 1 ? 44 : 0) })));
    const edges: { from: string; to: string; dashed: boolean; status: Status | "none"; label?: string }[] = [];
    for (const b of snap.batches) {
      for (const i of b.inputs) {
        if (i.ref) edges.push({ from: i.ref.id, to: b.batchId, dashed: false, status: b.status as Status });
        for (const l of i.links) if (l.status !== "rejected") edges.push({ from: l.target.id, to: b.batchId, dashed: l.status !== "confirmed", status: b.status as Status });
      }
      for (const d of b.dispatches) edges.push({ from: b.batchId, to: `buyer:${d.buyer ?? "Unknown buyer"}`, dashed: d.buyer === null, status: b.status as Status, label: `${d.jars}` });
      if ((b.balance?.unaccounted ?? 0) > 0) edges.push({ from: b.batchId, to: "buyer:No record", dashed: true, status: b.status as Status, label: `${b.balance?.unaccounted}` });
    }
    const height = Math.max(...cols.map((c, ci) => c.length + (ci === 1 ? 1 : 0))) * 64 + 40;
    return { cols, pos, edges, height };
  }, [snap]);
  const color = (s: Status | "none" | undefined) => (s ? `var(--${s === "no_recorded_link" || s === "none" ? "nolink" : s})` : "var(--line)");
  return (
    <div className="card">
      <h2>Lineage explorer</h2>
      <div className="legend">
        <span>Solid line: recorded</span><span>Dashed line: unconfirmed or unknown</span>
        {(Object.keys(LABEL) as Status[]).map((s) => <span key={s}><Chip s={s} /></span>)}
      </div>
      <div className="wrap">
        <svg width={950} height={layout.height} role="img" aria-label="Lineage from supplier lots through batches to buyers">
          {layout.edges.map((e, i) => {
            const a = layout.pos.get(e.from); const b = layout.pos.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + 190, y1 = a.y + 22, x2 = b.x, y2 = b.y + 22;
            return <g key={i}>
              <path d={`M${x1},${y1} C${x1 + 30},${y1} ${x2 - 30},${y2} ${x2},${y2}`} fill="none" stroke={color(e.status)} strokeWidth={e.status === "no_recorded_link" ? 1 : 2} strokeDasharray={e.dashed ? "5 4" : undefined} opacity={e.status === "no_recorded_link" ? 0.5 : 0.9} />
              {e.label && <text x={x1 + 6} y={y1 + (y2 > y1 ? 13 : y2 < y1 ? -5 : -4)} style={{ fontSize: 11 }}>{e.label}</text>}
            </g>;
          })}
          {layout.cols.flat().map((n) => {
            const p = layout.pos.get(n.id);
            if (!p) return null;
            return <g key={n.id} transform={`translate(${p.x},${p.y})`}>
              <rect width={190} height={44} rx={8} fill="var(--surface)" stroke={color(n.status)} strokeWidth={n.status && n.status !== "no_recorded_link" ? 2 : 1} />
              <text x={10} y={18} style={{ fontWeight: 600 }}>{n.label}</text>
              <text x={10} y={34} style={{ fontSize: 11, fill: "var(--muted)" }}>{n.sub}{n.status && n.kind !== "lot" ? ` · ${LABEL[n.status]}` : n.kind === "lot" && n.status ? " · flagged" : ""}</text>
            </g>;
          })}
        </svg>
      </div>
    </div>
  );
}

function Audit({ snap }: { snap: Snapshot }) {
  const rows = snap.audit as { seq: number; at: string; actor: string; action: string; subject: string | null; outcome: string }[];
  const steps = snap.steps as { step_key: string; status: string; attempts: number; error: string | null }[];
  return (
    <div className="grid">
      <div className="card"><h2>Audit trail</h2><p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Append-only. Refused actions are recorded too.</p>
        <div className="wrap"><table><thead><tr><th>#</th><th>Who</th><th>Action</th><th>Outcome</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.seq}><td className="mono">{r.seq}</td><td>{r.actor}</td><td className="mono">{r.action}</td><td className={r.outcome.startsWith("denied") ? "err" : ""}>{r.outcome}</td></tr>)}</tbody></table></div>
      </div>
      <div className="card"><h2>Agent step journal</h2><p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Each step runs once. After a restart, finished steps are reused.</p>
        {steps.map((s) => <div key={s.step_key} className="step"><span className="mono">{s.step_key}</span> · {s.status} · {s.attempts} attempts {s.error && <span className="err">· {s.error}</span>}</div>)}
      </div>
    </div>
  );
}
