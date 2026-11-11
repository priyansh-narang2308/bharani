import { describe, expect, it } from "vitest";
import { traceImpact } from "@/core/impact";
import { project } from "@/core/ledger";
import { sequence } from "@/core/log";
import { rankQuestions } from "@/core/questions";
import { FLAGGED_LOT, scenario } from "@/demo/scenario";

const report = (extra: Parameters<typeof sequence>[0] = []) => traceImpact(project(sequence([...scenario(), ...extra])), [FLAGGED_LOT]);

describe("demo scenario ground truth", () => {
  it("classifies every batch as expected", () => {
    const r = report();
    expect(Object.fromEntries(r.batches.map((b) => [b.batchCode, b.status]))).toEqual({
      "M-1101": "confirmed",
      "L-MX1": "confirmed",
      "L-1103": "confirmed",
      "F-1104": "no_recorded_link",
      "M-1102": "conditional",
      "L-1105": "undetermined",
    });
    expect(r.batches.find((b) => b.batchCode === "M-1102")?.condition).toEqual([["lk-m1102-rt"]]);
  });
  it("Case B: never claims every recipient is identified", () => {
    const r = report();
    expect(r.recipientListComplete).toBe(false);
    expect(r.blockers.map((b) => b.code).sort()).toEqual(
      ["batch_unaccounted", "conditional_batches", "lot_unexplained", "recipient_no_contact", "recipient_unknown", "undetermined_batches"].sort(),
    );
    expect(r.unaccountedJars).toBe(10);
    expect(r.unknownRecipientJars).toBe(20);
  });
  it("mass balance on the flagged lot is consistent only if M-1102 used it", () => {
    const lot = report().lots[0];
    expect(lot).toMatchObject({ received: 10000, usedConfirmed: 4000, usedConditional: 1000, onHand: 5000, unexplainedMin: 0, unexplainedMax: 1000 });
  });
  it("asks first about the chilli in M-1102", () => {
    const q = rankQuestions(sequence(scenario()), [FLAGGED_LOT]);
    expect(q[0]).toMatchObject({ kind: "which_source", batchId: "b-m1102", jarsSettledAtLeast: 40 });
  });
  it("a judge changes the ingredient lot and the answer follows", () => {
    const fix = [{ type: "link.confirmed" as const, id: "j1", at: "2026-10-21", actor: "coord-asha", linkId: "lk-m1102-gm" }];
    const r = report(fix);
    expect(r.batches.find((b) => b.batchCode === "M-1102")?.status).toBe("no_recorded_link");
    expect(r.lots[0]).toMatchObject({ usedConditional: 0, unexplainedMin: 1000, unexplainedMax: 1000 });
    expect(r.recipients.find((x) => x.name === "Thursday haat stall")).toBeUndefined();
  });
  it("a judge adds the missing chilli to L-1105 and it becomes confirmed", () => {
    const r = report([{
      type: "batch.corrected", id: "j2", at: "2026-10-21", actor: "k-lakshmi", batchId: "b-l1105", reason: "Forgot to say the chilli",
      inputs: [{ inputId: "i2", text: "mirchi", ingredientId: "chilli", qty: { value: 1, unit: "kg" }, ref: { kind: "lot", lotId: FLAGGED_LOT } }],
    }]);
    expect(r.batches.find((b) => b.batchCode === "L-1105")?.status).toBe("confirmed");
    expect(r.lots[0]?.unexplainedMax).toBe(0);
  });
});
