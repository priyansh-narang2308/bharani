import { describe, expect, it } from "vitest";
import { project } from "@/core/ledger";
import { sequence } from "@/core/log";
import { traceImpact } from "@/core/impact";
import { FLAGGED_LOT, scenario } from "@/demo/scenario";
import { groundDraft } from "@/extract/ground";
import { reconcile } from "@/extract/reconcile";
import { RuleExtractor } from "@/extract/rules";
import type { ExtractContext, NoteDraft } from "@/extract/schema";

const ledger = project(sequence(scenario()));
const ctx: ExtractContext = {
  kitchenName: "Meena", date: "2026-10-22",
  ingredients: [...ledger.ingredients.values()].map((i) => ({ name: i.name, aliases: i.aliases })),
  products: [...ledger.products.values()].map((p) => p.name),
  buyers: ["Sharma Kirana"],
};

describe("grounding", () => {
  it("removes words the note never said and names outside the lists", () => {
    const note = "Mango pickle 40 dabbe, kairi 12 kilo";
    const invented: NoteDraft = {
      kind: "batch", product_words: "Mango pickle", product: "Mango pickle", made: { value: 40, unit: "jar" }, batch_code: "MX-999",
      inputs: [
        { words: "kairi", ingredient: "raw mango", ingredient_confidence: "stated", qty: { value: 12, unit: "kg" }, supplier_words: "Raju", lot_code_words: null, batch_words: null },
        { words: "lal mirch", ingredient: "chilli powder", ingredient_confidence: "stated", qty: { value: 1, unit: "kg" }, supplier_words: null, lot_code_words: null, batch_words: null },
        { words: "12 kilo", ingredient: "saffron", ingredient_confidence: "likely", qty: null, supplier_words: null, lot_code_words: null, batch_words: null },
      ],
      dispatches: [{ buyer_words: "Gupta store", buyer: "Gupta store", qty: null }], unclear: [],
    };
    const { draft, issues } = groundDraft(note, invented, ctx);
    expect(draft.inputs.map((i) => i.words)).toEqual(["kairi", "12 kilo"]);
    expect(draft.inputs[0]?.supplier_words).toBeNull();
    expect(draft.inputs[1]?.ingredient).toBeNull();
    expect(draft.batch_code).toBeNull();
    expect(draft.dispatches).toEqual([]);
    expect(issues.length).toBe(5);
  });
});

describe("Case A: ambiguous ingredient identity from a note", () => {
  it("keeps a vague name, proposes nothing as fact, and the batch stays open", async () => {
    const note = "aaj Mango pickle banaya 36 dabbe, kairi 11 kilo, laal wala powder 1 kilo";
    const { draft } = await new RuleExtractor().extract(note, ctx);
    const g = groundDraft(note, draft, ctx);
    expect(g.issues).toEqual([]);
    expect(g.draft.inputs.map((i) => [i.words, i.ingredient])).toEqual([["kairi", "raw mango"], ["laal wala powder", null]]);
    const r = reconcile(ledger, g.draft, { kitchenId: "k-meena", date: "2026-10-22", evidenceId: "e1", batchId: "b-new", issues: g.issues });
    expect(r.readBack).toMatch(/not sure what "laal wala powder" is/);
    const after = traceImpact(project(sequence([...scenario(), ...r.events])), [FLAGGED_LOT]);
    expect(after.batches.find((b) => b.batchId === "b-new")?.status).toBe("undetermined");
  });
  it("a model reading becomes a named condition, not a fact", () => {
    const draft: NoteDraft = {
      kind: "batch", product_words: "Mango pickle", product: "Mango pickle", made: { value: 36, unit: "jar" }, batch_code: null,
      inputs: [{ words: "laal wala powder", ingredient: "chilli powder", ingredient_confidence: "likely", qty: { value: 1, unit: "kg" }, supplier_words: null, lot_code_words: null, batch_words: null }],
      dispatches: [], unclear: [],
    };
    const r = reconcile(ledger, draft, { kitchenId: "k-meena", date: "2026-10-22", evidenceId: "e1", batchId: "b-new", issues: [] });
    const links = r.events.filter((e) => e.type === "link.proposed");
    expect(links.length).toBe(2);
    expect(links.every((l) => l.type === "link.proposed" && l.source === "model")).toBe(true);
    expect(r.events.some((e) => e.type === "link.confirmed")).toBe(false);
    const after = traceImpact(project(sequence([...scenario(), ...r.events])), [FLAGGED_LOT]);
    expect(after.batches.find((b) => b.batchId === "b-new")?.status).toBe("conditional");
  });
});
