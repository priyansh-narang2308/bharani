import { matchIngredient, normaliseName } from "@/core/candidates";
import type { Unit } from "@/core/types";
import type { ExtractContext, Extractor, NoteDraft } from "./schema";

const UNITS: [RegExp, Unit][] = [
  [/^(kilo|kg|kgs|kilogram|किलो)$/, "kg"],
  [/^(gram|grams|gm|g|ग्राम)$/, "g"],
  [/^(litre|liter|litres|l|ltr|लीटर)$/, "l"],
  [/^(ml)$/, "ml"],
  [/^(jar|jars|bottle|bottles|dabba|dabbe|डब्बे|डिब्बे|बोतल)$/, "jar"],
];
const NUMBERS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
  bees: 20, tees: 30, chalis: 40, pachas: 50, sau: 100, aadha: 0.5, dedh: 1.5, dhai: 2.5,
};
const FILLER = new Set(["aaj", "banaya", "banaye", "bani", "today", "made", "jo", "se", "aaya", "tha", "wali", "wala", "daali", "thoda", "thodi", "si", "sirf", "ko", "diye", "lot", "the", "of", "kuch", "nahi", "mein", "ka", "ki"]);

function readSegment(seg: string) {
  const tokens = normaliseName(seg).split(" ").filter(Boolean);
  const qtys: { at: number; value: number; unit: Unit }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    const glued = t.match(/^(\d+(?:\.\d+)?)(kg|g|l|ml)$/);
    if (glued) {
      qtys.push({ at: i, value: Number(glued[1]), unit: glued[2] as Unit });
      continue;
    }
    const value = /^\d+(\.\d+)?$/.test(t) ? Number(t) : NUMBERS[t];
    const unit = UNITS.find(([re]) => re.test(tokens[i + 1] ?? ""))?.[1];
    if (value !== undefined && unit) qtys.push({ at: i, value, unit });
  }
  const used = new Set(qtys.flatMap((q) => [q.at, q.at + 1]));
  const words = tokens.filter((_, i) => !used.has(i));
  // Longest run of spoken words between quantities, kept exactly as said.
  const runs: string[][] = [[]];
  tokens.forEach((t, i) => (used.has(i) ? runs.push([]) : runs[runs.length - 1]?.push(t)));
  return { tokens, words, qtys, runs: runs.filter((r) => r.length > 0) };
}

/**
 * A deterministic reader for common phrasings: one ingredient and quantity per
 * clause. It is the offline fallback and the baseline the model is measured
 * against. Words it cannot map stay unidentified; it never guesses.
 */
export class RuleExtractor implements Extractor {
  readonly name = "rules";
  async extract(transcript: string, ctx: ExtractContext) {
    const started = performance.now();
    const draft: NoteDraft = { kind: "unclear", product_words: null, product: null, made: null, batch_code: null, inputs: [], dispatches: [], unclear: [] };
    const whole = ` ${normaliseName(transcript)} `;
    for (const p of ctx.products) {
      if (whole.includes(` ${normaliseName(p)} `)) {
        draft.product = p;
        draft.product_words = p;
      }
    }
    const productTokens = new Set(draft.product ? normaliseName(draft.product).split(" ") : []);
    const dispatching = /\b(diye|bheje|sent|delivered)\b/i.test(transcript);

    for (const seg of transcript.split(/[,;.।]|\baur\b|\band\b|\bwith\b/i)) {
      const { words, qtys, runs } = readSegment(seg);
      const content = words.filter((w) => !productTokens.has(w) && !FILLER.has(w) && !/^[a-z]{1,3}\d|\d/.test(w));
      for (const q of qtys.filter((x) => x.unit === "jar")) {
        if (!draft.made && !dispatching) draft.made = { value: q.value, unit: "jar" };
      }
      const mass = qtys.filter((x) => x.unit !== "jar");
      let best: { name: string; words: string; score: number } | null = null;
      for (const ing of ctx.ingredients) {
        for (let len = Math.min(3, content.length); len >= 1; len--) {
          for (let s = 0; s + len <= content.length; s++) {
            const phrase = content.slice(s, s + len).join(" ");
            const m = matchIngredient(phrase, ing);
            if (m && (m.kind === "exact" || m.kind === "alias") && (!best || m.score > best.score || (m.score === best.score && phrase.length > best.words.length))) {
              best = { name: ing.name, words: phrase, score: m.score };
            }
          }
        }
      }
      const q = mass[0];
      if (best) {
        draft.inputs.push({ words: best.words, ingredient: best.name, ingredient_confidence: "stated", qty: q ? { value: q.value, unit: q.unit } : null, supplier_words: null, lot_code_words: null, batch_words: null });
      } else if (q && content.length > 0) {
        const isContent = (w: string) => !productTokens.has(w) && !FILLER.has(w) && !/\d/.test(w);
        const run = runs.find((r) => r.some(isContent)) ?? [];
        let a = 0;
        let b = run.length;
        while (a < b && !isContent(run[a] ?? "")) a++;
        while (b > a && !isContent(run[b - 1] ?? "")) b--;
        const spoken = run.slice(a, b).join(" ");
        draft.inputs.push({ words: spoken, ingredient: null, ingredient_confidence: "unsure", qty: { value: q.value, unit: q.unit }, supplier_words: null, lot_code_words: null, batch_words: null });
        draft.unclear.push(`What is "${spoken}"?`);
      }
    }
    const code = transcript.match(/\b([A-Z]{1,3}-\d{2,})\b/);
    if (code?.[1]) {
      const chilliLike = draft.inputs.find((i) => normaliseName(transcript).includes(normaliseName(code[1] ?? "")));
      if (chilliLike) chilliLike.lot_code_words = code[1];
    }
    if (draft.inputs.length > 0 || draft.made) draft.kind = "batch";
    if (dispatching && draft.inputs.length === 0) draft.kind = "dispatch";
    if (draft.kind === "batch" && !draft.product) draft.unclear.push("Which product was this?");
    if (draft.kind === "batch" && !draft.made) draft.unclear.push("How many jars were made?");
    return { draft, meta: { source: "rules" as const, ms: performance.now() - started } };
  }
}
