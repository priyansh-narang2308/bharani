import { readFileSync, writeFileSync } from "node:fs";
import { ClaudeExtractor } from "@/extract/claude";
import { groundDraft } from "@/extract/ground";
import { RuleExtractor } from "@/extract/rules";
import type { ExtractContext, Extractor } from "@/extract/schema";

/**
 * Field-level extraction accuracy on author-written notes. Labels ending in
 * "?" mark a vague name: the right answer is to leave identity unconfirmed,
 * so asserting any ingredient for it counts as an incorrect identity.
 * Run: npm run eval:extraction            (rules only)
 *      EXTRACTOR=model npm run eval:extraction  (needs a valid ANTHROPIC_API_KEY; costs money)
 */
type Item = { t: string; product: string | null; made: [number, string] | null; inputs: [string, number | null, string | null][] };
const data = JSON.parse(readFileSync(process.env.NOTES ?? "eval/notes.json", "utf8")) as { items: Item[] };
const ctx: ExtractContext = {
  kitchenName: "Test kitchen",
  date: "2026-11-10",
  ingredients: [
    { name: "chilli powder", aliases: ["lal mirch", "mirchi", "mirchi powder", "लाल मिर्च"] },
    { name: "mustard oil", aliases: ["sarson tel", "sarson ka tel", "tel", "सरसों तेल"] },
    { name: "salt", aliases: ["namak", "नमक"] },
    { name: "raw mango", aliases: ["kairi", "kachha aam", "aam", "कैरी"] },
    { name: "lemon", aliases: ["nimbu"] },
    { name: "turmeric", aliases: ["haldi"] },
  ],
  products: ["Mango pickle", "Lemon pickle"],
  buyers: ["Sharma Kirana"],
};
const toBase = (v: number | null, u: string | null) => (v === null || u === null ? null : u === "kg" || u === "l" ? v * 1000 : v);

async function run(x: Extractor) {
  let productRight = 0, madeRight = 0, inputsTrue = 0, inputsFound = 0, inputsMatched = 0, wrongIdentity = 0, vagueKeptOpen = 0, vague = 0, removed = 0, failures = 0;
  let inTok = 0, outTok = 0;
  const ms: number[] = [];
  for (const item of data.items) {
    let res;
    try {
      res = await x.extract(item.t, ctx);
    } catch {
      failures += 1;
      continue;
    }
    ms.push(res.meta.ms);
    inTok += res.meta.inputTokens ?? 0;
    outTok += res.meta.outputTokens ?? 0;
    const g = groundDraft(item.t, res.draft, ctx);
    removed += g.issues.length;
    const d = g.draft;
    const wantProduct = item.product?.endsWith("?") ? null : item.product;
    if (d.product === wantProduct || (item.product?.endsWith("?") && d.product === item.product.slice(0, -1))) productRight += 1;
    if (JSON.stringify(d.made ? [d.made.value, d.made.unit] : null) === JSON.stringify(item.made)) madeRight += 1;
    inputsTrue += item.inputs.length;
    inputsFound += d.inputs.length;
    for (const [label, v, u] of item.inputs) {
      const isVague = label.endsWith("?");
      const want = toBase(v, u);
      const hit = d.inputs.find((i) => {
        const q = toBase(i.qty?.value ?? null, i.qty?.unit ?? null);
        return q === want && (isVague || i.ingredient === label);
      });
      if (isVague) {
        vague += 1;
        if (hit && (hit.ingredient === null || hit.ingredient_confidence !== "stated")) vagueKeptOpen += 1;
        if (hit && hit.ingredient !== null && hit.ingredient_confidence === "stated") wrongIdentity += 1;
      }
      if (hit) inputsMatched += 1;
    }
    for (const i of d.inputs) {
      const label = item.inputs.find(([, v, u]) => toBase(v, u) === toBase(i.qty?.value ?? null, i.qty?.unit ?? null))?.[0];
      if (i.ingredient && label && !label.endsWith("?") && label !== i.ingredient) wrongIdentity += 1;
    }
  }
  const n = data.items.length;
  return {
    extractor: x.name,
    notes: n,
    failures,
    productAccuracy: productRight / n,
    madeQuantityAccuracy: madeRight / n,
    inputRecall: inputsMatched / inputsTrue,
    inputPrecision: inputsFound ? inputsMatched / inputsFound : 0,
    wrongIdentityAssertions: wrongIdentity,
    vagueNamesKeptOpen: `${vagueKeptOpen}/${vague}`,
    ungroundedRemoved: removed,
    medianMs: ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)] ?? null,
    tokens: { input: inTok, output: outTok },
    costUsd: (inTok * 4 + outTok * 20) / 1e6,
  };
}

const which = process.env.EXTRACTOR ?? "rules";
const x: Extractor = which === "model" ? new ClaudeExtractor() : new RuleExtractor();
const result = { note: "Author-written synthetic notes, not real speech.", ...(await run(x)) };
writeFileSync(`eval/results/extraction-${which}${process.env.NOTES ? "-holdout" : ""}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
