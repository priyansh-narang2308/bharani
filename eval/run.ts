import { writeFileSync } from "node:fs";
import { project } from "@/core/ledger";
import { sequence } from "@/core/log";
import { rankQuestions } from "@/core/questions";
import type { LedgerEvent } from "@/core/types";
import { autoAccept, batchSystem, bharani, spreadsheet, type MethodOutput } from "./methods";
import { DEFAULT_PARAMS, simulate, trueLink, type Sim } from "./sim";

/**
 * Measures each method against synthetic ground truth. Run: npm run eval.
 * Results are written to eval/results. They describe simulated records only.
 */
const RUNS = Number(process.env.RUNS ?? 200);

function score(sim: Sim, out: MethodOutput) {
  const truthB = sim.affectedBatches;
  const tp = [...out.flaggedBatches].filter((b) => truthB.has(b)).length;
  const totalJars = [...sim.affectedJarsByBuyer.values()].reduce((a, b) => a + b, 0);
  const reached = [...sim.affectedJarsByBuyer.entries()].filter(([b]) => out.contacted.has(b)).reduce((a, [, j]) => a + j, 0);
  const missed = totalJars - reached;
  const wrong = out.autoAccepted.filter((a) => !trueLink(sim, a.target, a.batchId, a.inputId)).length;
  return {
    batchRecall: truthB.size ? tp / truthB.size : 1,
    batchPrecision: out.flaggedBatches.size ? tp / out.flaggedBatches.size : 1,
    jarsReachedShare: totalJars ? reached / totalJars : 1,
    falseCompleteClaim: out.claimsComplete && missed > 0 ? 1 : 0,
    autoAccepted: out.autoAccepted.length,
    wrongAccepted: wrong,
  };
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Answers the top question from the hidden truth, as a kitchen would, and repeats. */
function answerQuestions(sim: Sim, rounds: number) {
  let events: LedgerEvent[] = sim.events;
  const curve: { asked: number; precision: number; openJars: number }[] = [];
  for (let q = 0; q <= rounds; q++) {
    const out = bharani(events, sim.truth.flagged);
    const s = score(sim, out);
    curve.push({ asked: q, precision: s.batchPrecision, openJars: out.report.jars.conditional + out.report.jars.undetermined });
    if (q === rounds) break;
    const question = rankQuestions(events, [sim.truth.flagged]).find((x) => x.kind === "which_source" && x.answers.length > 0);
    if (!question || !question.batchId || !question.inputId) {
      for (let rest = q + 1; rest <= rounds; rest++) curve.push({ ...curve[curve.length - 1]!, asked: rest });
      break;
    }
    const ledger = project(events);
    const live = [...ledger.links.values()].filter((l) => l.batchId === question.batchId && l.inputId === question.inputId && l.status === "proposed");
    const right = live.find((l) => trueLink(sim, l.target, l.batchId, l.inputId));
    const answer = right
      ? { type: "link.confirmed" as const, id: `ans-${q}`, at: "2026-09-30", actor: "kitchen", linkId: right.linkId }
      : { type: "input.source_unknown" as const, id: `ans-${q}`, at: "2026-09-30", actor: "kitchen", batchId: question.batchId, inputId: question.inputId };
    events = [...events, ...sequence([answer], ledger.rev)];
  }
  return curve;
}

const methods = { spreadsheet, batchSystem, autoAccept, bharani } as const;
const rows: Record<string, ReturnType<typeof score>[]> = { spreadsheet: [], batchSystem: [], autoAccept: [], bharani: [] };
const curves: ReturnType<typeof answerQuestions>[] = [];
const latency: number[] = [];
let affectedRuns = 0;
for (let seed = 1; seed <= RUNS; seed++) {
  const sim = simulate(seed);
  if (sim.affectedBatches.size === 0) continue;
  affectedRuns += 1;
  for (const [name, fn] of Object.entries(methods)) {
    const t = performance.now();
    const out = fn(sim.events, sim.truth.flagged);
    if (name === "bharani") latency.push(performance.now() - t);
    rows[name]?.push(score(sim, out));
  }
  if (seed <= 60) curves.push(answerQuestions(sim, 10));
}

const summary = Object.fromEntries(
  Object.entries(rows).map(([name, rs]) => [
    name,
    {
      batchRecall: mean(rs.map((r) => r.batchRecall)),
      batchPrecision: mean(rs.map((r) => r.batchPrecision)),
      jarsReachedShare: mean(rs.map((r) => r.jarsReachedShare)),
      falseCompleteClaimRate: mean(rs.map((r) => r.falseCompleteClaim)),
      wrongAutoAcceptRate: rs.reduce((a, r) => a + r.wrongAccepted, 0) / Math.max(1, rs.reduce((a, r) => a + r.autoAccepted, 0)),
    },
  ]),
);
const curve = Array.from({ length: 11 }, (_, q) => ({
  asked: q,
  precision: mean(curves.map((c) => c[q]?.precision ?? 0)),
  openJars: mean(curves.map((c) => c[q]?.openJars ?? 0)),
}));
latency.sort((a, b) => a - b);
const result = {
  note: "Synthetic records from eval/sim.ts. Not real kitchens. Answers to questions come from the hidden truth.",
  params: DEFAULT_PARAMS,
  runsWithAffectedBatches: affectedRuns,
  summary,
  questionCurve: curve,
  traceLatencyMs: { p50: latency[Math.floor(latency.length * 0.5)], p95: latency[Math.floor(latency.length * 0.95)], max: latency[latency.length - 1] },
};
writeFileSync("eval/results/traceability.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
