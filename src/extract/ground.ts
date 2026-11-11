import { normaliseName } from "@/core/candidates";
import type { ExtractContext, NoteDraft } from "./schema";

export interface GroundingIssue {
  field: string;
  value: string;
  action: "removed" | "set_to_null";
}

const inNote = (note: string, words: string | null) => {
  if (!words) return true;
  const n = ` ${normaliseName(note)} `;
  const w = normaliseName(words);
  return w.length > 0 && n.includes(` ${w} `) || (w.length > 0 && n.replace(/\s/g, "").includes(w.replace(/\s/g, "")));
};
const known = (list: string[], name: string | null) => name === null || list.includes(name);

/**
 * Checks a draft against the note it came from. Words not found in the note
 * and names outside the provided lists are removed, never repaired. The count
 * of removals is reported so ungrounded output is visible, not hidden.
 */
export function groundDraft(note: string, draft: NoteDraft, ctx: ExtractContext): { draft: NoteDraft; issues: GroundingIssue[] } {
  const issues: GroundingIssue[] = [];
  const ingredientNames = ctx.ingredients.map((i) => i.name);
  const out: NoteDraft = structuredClone(draft);

  if (!inNote(note, out.product_words)) {
    issues.push({ field: "product_words", value: out.product_words ?? "", action: "set_to_null" });
    out.product_words = null;
  }
  if (!known(ctx.products, out.product)) {
    issues.push({ field: "product", value: out.product ?? "", action: "set_to_null" });
    out.product = null;
  }
  if (out.batch_code && !inNote(note, out.batch_code)) {
    issues.push({ field: "batch_code", value: out.batch_code, action: "set_to_null" });
    out.batch_code = null;
  }
  out.inputs = out.inputs.filter((i) => {
    if (!inNote(note, i.words)) {
      issues.push({ field: "inputs.words", value: i.words, action: "removed" });
      return false;
    }
    return true;
  });
  for (const i of out.inputs) {
    if (!known(ingredientNames, i.ingredient)) {
      issues.push({ field: "inputs.ingredient", value: i.ingredient ?? "", action: "set_to_null" });
      i.ingredient = null;
    }
    for (const key of ["supplier_words", "lot_code_words", "batch_words"] as const) {
      if (!inNote(note, i[key])) {
        issues.push({ field: `inputs.${key}`, value: i[key] ?? "", action: "set_to_null" });
        i[key] = null;
      }
    }
  }
  out.dispatches = out.dispatches.filter((d) => {
    if (!inNote(note, d.buyer_words)) {
      issues.push({ field: "dispatches.buyer_words", value: d.buyer_words, action: "removed" });
      return false;
    }
    return true;
  });
  for (const d of out.dispatches) {
    if (!known(ctx.buyers, d.buyer)) {
      issues.push({ field: "dispatches.buyer", value: d.buyer ?? "", action: "set_to_null" });
      d.buyer = null;
    }
  }
  return { draft: out, issues };
}
