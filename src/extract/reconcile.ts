import { candidateLots, normaliseName } from "@/core/candidates";
import type { BatchInput, Id, Ledger, NewEvent } from "@/core/types";
import type { GroundingIssue } from "./ground";
import type { NoteDraft } from "./schema";

export interface Warning {
  code: "possible_duplicate" | "unknown_product" | "no_quantity" | "ingredient_from_model" | "ungrounded_removed" | "not_a_batch";
  message: string;
}
export interface Reconciled {
  events: NewEvent[];
  warnings: Warning[];
  readBack: string;
}

/**
 * Turns a grounded draft into ledger events. Identity comes only from the
 * alias table or a person. A model's ingredient reading becomes a proposed
 * link with source "model", which keeps the batch conditional until confirmed.
 */
export function reconcile(
  ledger: Ledger,
  draft: NoteDraft,
  opts: { kitchenId: Id; date: string; evidenceId: Id; batchId: Id; issues: GroundingIssue[] },
): Reconciled {
  const warnings: Warning[] = [];
  const events: NewEvent[] = [];
  if (opts.issues.length > 0) {
    const n = opts.issues.length;
    warnings.push({ code: "ungrounded_removed", message: `${n} ${n === 1 ? "item was" : "items were"} not found in the note and ${n === 1 ? "was" : "were"} removed: ${opts.issues.map((i) => `"${i.value}"`).join(", ")}` });
  }
  if (draft.kind !== "batch") {
    warnings.push({ code: "not_a_batch", message: "This note does not look like a production record" });
    return { events, warnings, readBack: "Is this about a batch you made?" };
  }
  const product = [...ledger.products.values()].find((p) => p.name === draft.product);
  if (!product) warnings.push({ code: "unknown_product", message: "Product not recognised" });

  const ingredients = [...ledger.ingredients.values()];
  const inputs: BatchInput[] = draft.inputs.map((i, k) => {
    const words = normaliseName(i.words);
    const byAlias = ingredients.find((ing) => [ing.name, ...ing.aliases].some((a) => normaliseName(a) === words));
    if (!i.qty) warnings.push({ code: "no_quantity", message: `No quantity for "${i.words}"` });
    return {
      inputId: `i${k + 1}`,
      text: i.words,
      ingredientId: byAlias?.ingredientId ?? null,
      qty: i.qty,
      ref: { kind: "none" },
      supplierHint: i.supplier_words ?? undefined,
      lotCodeHint: i.lot_code_words ?? undefined,
    };
  });

  const base = { at: opts.date, actor: opts.kitchenId, evidence: [opts.evidenceId] };
  const batchEvent: NewEvent = {
    ...base,
    type: "batch.logged",
    id: `ev-${opts.batchId}`,
    batchId: opts.batchId,
    kitchenId: opts.kitchenId,
    productId: product?.productId ?? "unknown",
    batchCode: draft.batch_code,
    made: draft.made,
    inputs,
  };
  events.push(batchEvent);

  // Propose candidates against a ledger that already contains this batch.
  const withBatch: Ledger = { ...ledger, batches: new Map(ledger.batches) };
  withBatch.batches.set(opts.batchId, {
    batchId: opts.batchId, kitchenId: opts.kitchenId, productId: batchEvent.productId, batchCode: draft.batch_code,
    made: draft.made, madeOn: opts.date, inputs, voided: false, acceptance: null, sourceUnknown: new Set(), evidence: [opts.evidenceId],
  });
  const batch = withBatch.batches.get(opts.batchId);
  if (!batch) throw new Error("unreachable");
  draft.inputs.forEach((d, k) => {
    const input = inputs[k];
    if (!input) return;
    const res = candidateLots(withBatch, batch, input);
    let proposals = res.exactCode
      ? [{ target: { kind: "lot" as const, id: res.exactCode }, score: 0.95, reasons: [`Lot code "${input.lotCodeHint}" was spoken`] }]
      : res.candidates;
    let source: "rules" | "model" = "rules";
    if (proposals.length === 0 && input.ingredientId === null && d.ingredient) {
      const guessed = ingredients.find((x) => x.name === d.ingredient);
      if (guessed) {
        const asIfNamed = { ...input, ingredientId: guessed.ingredientId };
        proposals = candidateLots(withBatch, batch, asIfNamed).candidates.map((c) => ({
          ...c,
          score: Math.round(c.score * (d.ingredient_confidence === "unsure" ? 0.4 : 0.7) * 1000) / 1000,
          reasons: [`Model reads "${input.text}" as ${guessed.name} (${d.ingredient_confidence}); not confirmed`, ...c.reasons.slice(1)],
        }));
        source = "model";
        warnings.push({ code: "ingredient_from_model", message: `"${input.text}" was read as ${guessed.name} by the model. A person must confirm.` });
      }
    }
    proposals.forEach((p, j) => {
      events.push({
        ...base,
        actor: source,
        type: "link.proposed",
        id: `ev-${opts.batchId}-${input.inputId}-${j}`,
        linkId: `${opts.batchId}.${input.inputId}.${j}`,
        batchId: opts.batchId,
        inputId: input.inputId,
        target: p.target,
        score: p.score,
        reasons: p.reasons,
        source,
      });
    });
  });

  const twin = [...ledger.batches.values()].find(
    (b) => !b.voided && b.kitchenId === opts.kitchenId && b.productId === batchEvent.productId && b.madeOn === opts.date &&
      JSON.stringify(b.made) === JSON.stringify(draft.made),
  );
  if (twin) warnings.push({ code: "possible_duplicate", message: `Looks like batch ${twin.batchCode ?? twin.batchId} logged the same day` });

  const parts = [
    `${draft.product ?? "Unknown product"}`,
    draft.made ? `${draft.made.value} ${draft.made.unit}` : "quantity not given",
    ...draft.inputs.map((i) => `${i.words}${i.qty ? ` ${i.qty.value} ${i.qty.unit}` : ""}`),
  ];
  const unsure = draft.inputs.filter((i) => inputs.find((x) => x.text === i.words)?.ingredientId === null).map((i) => `"${i.words}"`);
  const dropped = opts.issues.filter((i) => i.action === "removed").map((i) => `"${i.value}"`);
  const tail = [
    unsure.length ? `I am not sure what ${unsure.join(", ")} is. The coordinator will check.` : "",
    dropped.length ? `I could not place ${dropped.join(", ")} in your note.` : "",
  ].filter(Boolean).join(" ");
  return { events, warnings, readBack: `I heard: ${parts.join(", ")}. ${tail ? `${tail} ` : ""}Is that right?` };
}
