import { describe, expect, it } from "vitest";
import { batchBalance, findContradictions, lotBalance } from "@/core/balance";
import { traceImpact } from "@/core/impact";
import { project } from "@/core/ledger";
import { computeLineage, evaluate } from "@/core/lineage";
import { asOf } from "@/core/log";
import { rankQuestions } from "@/core/questions";
import { Book, batchRef, input, jars, kg, lotRef } from "./helpers";

const status = (log: ReturnType<Book["log"]>, flagged: string[]) =>
  Object.fromEntries(traceImpact(project(log), flagged).batches.map((b) => [b.batchId, b.status]));

describe("required case 1: one ingredient lot used in many finished batches", () => {
  it("finds every batch and nothing else", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .lot("B", "chilli", kg(10))
      .batch("b1", [input("i", "mirchi", "chilli", kg(2), lotRef("A"))], jars(40))
      .batch("b2", [input("i", "mirchi", "chilli", kg(3), lotRef("A"))], jars(60), "2026-09-11", "k2")
      .batch("b3", [input("i", "mirchi", "chilli", kg(5), lotRef("A"))], jars(100), "2026-09-12")
      .batch("b4", [input("i", "mirchi", "chilli", kg(2), lotRef("B"))], jars(50));
    expect(status(b.log(), ["A"])).toEqual({ b1: "confirmed", b2: "confirmed", b3: "confirmed", b4: "no_recorded_link" });
    const r = traceImpact(project(b.log()), ["A"]);
    expect(r.jars.confirmed).toBe(200);
    expect(r.lots[0]).toMatchObject({ received: 10000, usedConfirmed: 10000, unexplainedMax: 0, withinTolerance: true });
  });
});

describe("required case 2: many ingredient lots combined into one product", () => {
  it("reports the batch for each lot that went into it", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .lot("S", "salt", kg(10))
      .lot("O", "mustard oil", kg(10))
      .batch("b1", [
        input("c", "mirchi", "chilli", kg(1), lotRef("A")),
        input("s", "namak", "salt", kg(1), lotRef("S")),
        input("o", "tel", "mustard oil", kg(1), lotRef("O")),
      ]);
    for (const lot of ["A", "S", "O"]) expect(status(b.log(), [lot]).b1).toBe("confirmed");
  });
  it("carries through a shared masala mix made by another kitchen", () => {
    const b = Book.base()
      .product("masala")
      .lot("A", "chilli", kg(10))
      .batch("m1", [input("c", "mirchi", "chilli", kg(5), lotRef("A"))], kg(5), "2026-09-05", "k2", "masala")
      .batch("b1", [input("m", "masala", null, kg(1), batchRef("m1"))], jars(20))
      .batch("b2", [input("m", "masala", null, kg(1), batchRef("m1"))], jars(20), "2026-09-11");
    expect(status(b.log(), ["A"])).toMatchObject({ m1: "confirmed", b1: "confirmed", b2: "confirmed" });
    expect(batchBalance(project(b.log()), "m1")).toMatchObject({ made: 5000, usedInBatches: 2000, unaccounted: 3000 });
  });
});

describe("required case 3: one production batch split into many deliveries", () => {
  it("lists each recipient with jars and closes the balance", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(2))
      .batch("b1", [input("i", "mirchi", "chilli", kg(2), lotRef("A"))], jars(100))
      .ship("d1", "b1", "shop", jars(60))
      .ship("d2", "b1", "hostel", jars(25))
      .ship("d3", "b1", "shop", jars(15), "2026-09-13");
    const r = traceImpact(project(b.log()), ["A"]);
    expect(r.recipients.map((x) => [x.buyerId, x.jars.confirmed])).toEqual([["hostel", 25], ["shop", 75]]);
    expect(r.unaccountedJars).toBe(0);
    expect(r.recipientListComplete).toBe(true);
  });
  it("refuses completeness when jars are unaccounted for", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(2))
      .batch("b1", [input("i", "mirchi", "chilli", kg(2), lotRef("A"))], jars(100))
      .ship("d1", "b1", "shop", jars(60));
    const r = traceImpact(project(b.log()), ["A"]);
    expect(r.unaccountedJars).toBe(40);
    expect(r.recipientListComplete).toBe(false);
    expect(r.blockers.map((x) => x.code)).toContain("batch_unaccounted");
  });
});

describe("required case 4: missing ingredient identity", () => {
  it("keeps the batch undetermined and never rules it out", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .batch("b1", [input("i", "laal wala powder", null, kg(1))])
      .batch("b2", [input("i", "mirchi", "chilli", kg(1))]);
    const r = traceImpact(project(b.log()), ["A"]);
    expect(r.batches.find((x) => x.batchId === "b1")?.status).toBe("undetermined");
    expect(r.batches.find((x) => x.batchId === "b2")?.status).toBe("undetermined");
    expect(r.gaps.map((g) => g.code).sort()).toEqual(["input_source_unknown", "input_unidentified"]);
    expect(r.recipientListComplete).toBe(false);
  });
  it("does not count an unknown source of a different ingredient", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .lot("B", "chilli", kg(10))
      .batch("b1", [input("c", "mirchi", "chilli", kg(1), lotRef("B")), input("s", "namak", "salt", kg(1))]);
    expect(status(b.log(), ["A"]).b1).toBe("no_recorded_link");
  });
  it("flags a recipe ingredient the log never mentions", () => {
    const b = Book.base().lot("A", "chilli", kg(10)).batch("b1", [input("s", "namak", "salt", kg(1))]);
    const r = traceImpact(project(b.log()), ["A"]);
    expect(r.batches[0]?.status).toBe("undetermined");
    expect(r.gaps[0]?.code).toBe("recipe_input_missing");
  });
});

describe("required case 5: contradictory batch records", () => {
  it("reports each contradiction and does not pick a winner", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(1))
      .lot("L", "chilli", kg(5), "2026-09-20")
      .batch("b1", [input("i", "mirchi", "chilli", kg(2), lotRef("A"))], jars(10))
      .batch("b2", [input("i", "mirchi", "chilli", kg(1), lotRef("L"))], jars(10), "2026-09-11", "k1", "pickle", "b1")
      .ship("d1", "b1", "shop", jars(12));
    const c = findContradictions(project(b.log())).map((x) => x.code).sort();
    expect(c).toEqual(["dispatched_more_than_made", "duplicate_batch_code", "lot_overdrawn", "used_before_received"]);
    const r = traceImpact(project(b.log()), ["A"]);
    expect(r.recipientListComplete).toBe(false);
    expect(r.blockers.map((x) => x.code)).toContain("contradiction");
  });
});

describe("required case 7: corrected production information", () => {
  it("changes the answer, keeps the old answer available and keeps the original event", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .lot("B", "chilli", kg(10))
      .batch("b1", [input("i", "mirchi", "chilli", kg(2), lotRef("B"))], jars(100));
    const before = b.log();
    expect(status(before, ["A"]).b1).toBe("no_recorded_link");
    b.add({
      type: "batch.corrected", id: "fix", at: "2026-09-15", actor: "k1", batchId: "b1", reason: "Wrong packet read out",
      inputs: [input("i", "mirchi", "chilli", kg(2), lotRef("A"))], made: jars(90),
    });
    const after = b.log();
    expect(status(after, ["A"]).b1).toBe("confirmed");
    expect(project(after).batches.get("b1")?.made).toEqual(jars(90));
    expect(status(asOf(after, before.length), ["A"]).b1).toBe("no_recorded_link");
    expect(after.slice(0, before.length)).toEqual(before);
  });
  it("voiding a batch removes it and frees its lot use", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .batch("b1", [input("i", "mirchi", "chilli", kg(2), lotRef("A"))])
      .add({ type: "batch.voided", id: "v", at: "2026-09-15", actor: "k1", batchId: "b1", reason: "Entered twice" });
    const r = traceImpact(project(b.log()), ["A"]);
    expect(r.batches).toEqual([]);
    expect(lotBalance(project(b.log()), "A").usedConfirmed).toBe(0);
  });
});

describe("required case 8: missing customer details", () => {
  it("keeps an unidentified buyer as an open gap", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(2))
      .batch("b1", [input("i", "mirchi", "chilli", kg(2), lotRef("A"))], jars(100))
      .ship("d1", "b1", "shop", jars(70))
      .ship("d2", "b1", null, jars(30));
    const r = traceImpact(project(b.log()), ["A"]);
    expect(r.unknownRecipientJars).toBe(30);
    expect(r.unaccountedJars).toBe(0);
    expect(r.recipientListComplete).toBe(false);
    expect(r.blockers.map((x) => x.code)).toEqual(["recipient_unknown"]);
  });
  it("blocks when a known buyer cannot be contacted", () => {
    const b = Book.base()
      .party("canteen", "buyer")
      .lot("A", "chilli", kg(2))
      .batch("b1", [input("i", "mirchi", "chilli", kg(2), lotRef("A"))], jars(10))
      .ship("d1", "b1", "canteen", jars(10));
    const r = traceImpact(project(b.log()), ["A"]);
    expect(r.blockers.map((x) => x.code)).toEqual(["recipient_no_contact"]);
  });
});

describe("conditional lineage", () => {
  const twoLots = () =>
    Book.base()
      .lot("A", "chilli", kg(10))
      .lot("B", "chilli", kg(10))
      .batch("b1", [input("i", "mirchi", "chilli", kg(2))])
      .propose("L1", "b1", "i", { kind: "lot", id: "A" })
      .propose("L2", "b1", "i", { kind: "lot", id: "B" });

  it("names the assumption the batch depends on", () => {
    const line = computeLineage(project(twoLots().log()), ["A"]).get("b1");
    expect(line?.status).toBe("conditional");
    expect(line?.condition).toEqual([["L1"]]);
  });
  it("confirming one candidate settles both flagged lots", () => {
    const log = twoLots().confirm("L2").log();
    expect(status(log, ["A"]).b1).toBe("no_recorded_link");
    expect(status(log, ["B"]).b1).toBe("confirmed");
  });
  it("rejecting all candidates leaves it undetermined, not clear", () => {
    const log = twoLots().reject("L1").reject("L2").log();
    expect(status(log, ["A"]).b1).toBe("undetermined");
  });
  it("carries a condition through an uncertain masala link", () => {
    const b = Book.base()
      .product("masala")
      .lot("A", "chilli", kg(10))
      .lot("B", "chilli", kg(10))
      .batch("m1", [input("c", "mirchi", "chilli", kg(1))], kg(1), "2026-09-05", "k1", "masala")
      .batch("m2", [input("c", "mirchi", "chilli", kg(1), lotRef("B"))], kg(1), "2026-09-05", "k1", "masala")
      .batch("p", [input("m", "masala", null, kg(1))], jars(30))
      .propose("LA", "m1", "c", { kind: "lot", id: "A" })
      .propose("LB", "m1", "c", { kind: "lot", id: "B" })
      .propose("M1", "p", "m", { kind: "batch", id: "m1" })
      .propose("M2", "p", "m", { kind: "batch", id: "m2" });
    const line = computeLineage(project(b.log()), ["A"]).get("p");
    expect(line?.condition).toEqual([["LA", "M1"]]);
    expect(evaluate(line?.condition ?? [], (l) => l === "LA")).toBe(false);
    expect(evaluate(line?.condition ?? [], (l) => l === "LA" || l === "M1")).toBe(true);
  });
  it("absorbs a weaker path when a stronger one exists", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .batch("b1", [input("x", "mirchi", "chilli", kg(1), lotRef("A")), input("y", "mirchi", "chilli", kg(1))])
      .propose("L", "b1", "y", { kind: "lot", id: "A" });
    expect(computeLineage(project(b.log()), ["A"]).get("b1")?.condition).toEqual([[]]);
  });
  it("reports a cycle instead of looping", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .batch("x", [input("i", "y", null, kg(1), batchRef("y"))])
      .batch("y", [input("i", "x", null, kg(1), batchRef("x"))]);
    const r = traceImpact(project(b.log()), ["A"]);
    expect(r.batches.every((x) => x.gaps.some((g) => g.code === "lineage_cycle"))).toBe(true);
  });
});

describe("soundness against wrong guesses", () => {
  it("a model's wrong ingredient guess cannot rule a batch out", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .lot("O", "mustard oil", kg(10))
      .batch("b1", [input("i", "laal wala", null, kg(1))])
      .propose("guess", "b1", "i", { kind: "lot", id: "O" });
    expect(status(b.log(), ["A"]).b1).toBe("undetermined");
  });
  it("a person's confirmation does settle it", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .lot("O", "mustard oil", kg(10))
      .batch("b1", [input("i", "laal wala", null, kg(1))])
      .propose("guess", "b1", "i", { kind: "lot", id: "O" })
      .confirm("guess");
    expect(status(b.log(), ["A"]).b1).toBe("no_recorded_link");
  });
});

describe("mass balance coverage", () => {
  it("shows a range of unexplained stock while links are open", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .batch("b1", [input("i", "mirchi", "chilli", kg(3), lotRef("A"))])
      .batch("b2", [input("i", "mirchi", "chilli", kg(2))])
      .propose("L", "b2", "i", { kind: "lot", id: "A" });
    expect(lotBalance(project(b.log()), "A")).toMatchObject({ usedConfirmed: 3000, usedConditional: 2000, unexplainedMin: 5000, unexplainedMax: 7000, withinTolerance: false });
  });
  it("blocks completeness when a lot suggests an unrecorded batch", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .batch("b1", [input("i", "mirchi", "chilli", kg(2), lotRef("A"))], jars(10))
      .ship("d1", "b1", "shop", jars(10));
    const r = traceImpact(project(b.log()), ["A"]);
    expect(r.blockers.map((x) => x.code)).toEqual(["lot_unexplained"]);
    expect(r.recipientListComplete).toBe(false);
  });
  it("accepts a recorded stock count and loss", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .batch("b1", [input("i", "mirchi", "chilli", kg(2), lotRef("A"))], jars(10))
      .ship("d1", "b1", "shop", jars(10))
      .add({ type: "stock.counted", id: "s", at: "2026-09-20", actor: "k1", subject: { kind: "lot", id: "A" }, qty: kg(7.9) })
      .add({ type: "loss.recorded", id: "l", at: "2026-09-20", actor: "k1", subject: { kind: "lot", id: "A" }, qty: kg(0.1), reason: "Spilled" });
    expect(traceImpact(project(b.log()), ["A"]).recipientListComplete).toBe(true);
  });
  it("treats a use without quantity as open", () => {
    const b = Book.base().lot("A", "chilli", kg(10)).batch("b1", [input("i", "mirchi", "chilli", null, lotRef("A"))]);
    expect(lotBalance(project(b.log()), "A").usesWithoutQuantity).toBe(1);
    expect(lotBalance(project(b.log()), "A").withinTolerance).toBe(false);
  });
});

describe("question ranking", () => {
  it("asks first about the input that settles the most jars, by replaying the answers", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .lot("B", "chilli", kg(10))
      .batch("small", [input("i", "mirchi", "chilli", kg(1))], jars(10))
      .batch("big", [input("i", "mirchi", "chilli", kg(1))], jars(200))
      .propose("S1", "small", "i", { kind: "lot", id: "A" })
      .propose("S2", "small", "i", { kind: "lot", id: "B" })
      .propose("B1", "big", "i", { kind: "lot", id: "A" })
      .propose("B2", "big", "i", { kind: "lot", id: "B" });
    const q = rankQuestions(b.log(), ["A"]).filter((x) => x.kind === "which_source");
    expect(q.map((x) => [x.key, x.jarsSettledAtLeast])).toEqual([["big:i", 200], ["small:i", 10]]);
    // Neither batch has any dispatch on record, so each also gets a stock question.
    expect(rankQuestions(b.log(), ["A"]).filter((x) => x.kind === "unaccounted_stock").length).toBe(2);
  });
  it("does not ask again once a person said they cannot tell", () => {
    const b = Book.base()
      .lot("A", "chilli", kg(10))
      .batch("b1", [input("i", "mirchi", "chilli", kg(1))])
      .propose("L", "b1", "i", { kind: "lot", id: "A" })
      .add({ type: "input.source_unknown", id: "u", at: "2026-09-15", actor: "k1", batchId: "b1", inputId: "i" });
    expect(rankQuestions(b.log(), ["A"]).filter((x) => x.kind === "which_source")).toEqual([]);
  });
});
