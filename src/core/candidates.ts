import { lotBalance } from "./balance";
import type { Batch, BatchInput, Id, Ingredient, Ledger, LinkTarget, Lot } from "./types";
import { comparable, toBase } from "./units";

export function normaliseName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, (m) => (/[ऀ-ॿ]/.test(m) ? m : ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const t = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}
export function similarity(a: string, b: string): number {
  const x = trigrams(normaliseName(a));
  const y = trigrams(normaliseName(b));
  let shared = 0;
  for (const g of x) if (y.has(g)) shared += 1;
  return shared === 0 ? 0 : (2 * shared) / (x.size + y.size);
}

export type NameMatch = { kind: "exact" | "alias" | "contains" | "similar"; score: number; alias: string };

/** How well the words match an ingredient's name and known local names. */
export function matchIngredient(words: string, ingredient: Pick<Ingredient, "name" | "aliases">): NameMatch | null {
  const text = normaliseName(words);
  const names = [ingredient.name, ...ingredient.aliases];
  let best: NameMatch | null = null;
  for (const name of names) {
    const n = normaliseName(name);
    if (!n) continue;
    let m: NameMatch | null = null;
    if (text === n) m = { kind: name === ingredient.name ? "exact" : "alias", score: 1, alias: name };
    else if (` ${text} `.includes(` ${n} `)) m = { kind: "contains", score: 0.85, alias: name };
    else {
      const s = similarity(text, n);
      if (s >= 0.55) m = { kind: "similar", score: s * 0.8, alias: name };
    }
    if (m && (!best || m.score > best.score)) best = m;
  }
  return best;
}

export interface Candidate {
  target: LinkTarget;
  score: number;
  reasons: string[];
}
export interface Exclusion {
  lotId: Id;
  reason: string;
}
export interface CandidateResult {
  candidates: Candidate[];
  excluded: Exclusion[];
  /** A printed code in the words matched exactly one lot. */
  exactCode: Id | null;
}

function supplierName(ledger: Ledger, lot: Lot): string {
  return lot.supplierId ? (ledger.parties.get(lot.supplierId)?.name ?? "") : "";
}

/**
 * Deterministic candidate generation for one input. The list is never cut
 * short: a lot left off it would be silently ruled out. Evidence raises or lowers
 * a score, and impossible lots are excluded with the reason. Nothing here
 * confirms a link: a high score is still only a proposal.
 */
export function candidateLots(ledger: Ledger, batch: Batch, input: BatchInput): CandidateResult {
  const candidates: Candidate[] = [];
  const excluded: Exclusion[] = [];

  if (input.lotCodeHint) {
    const code = normaliseName(input.lotCodeHint);
    const hits = [...ledger.lots.values()].filter(
      (l) => l.supplierLotCode && normaliseName(l.supplierLotCode) === code,
    );
    if (hits.length === 1 && hits[0]) return { candidates: [], excluded: [], exactCode: hits[0].lotId };
  }

  for (const lot of ledger.lots.values()) {
    const ingredient = ledger.ingredients.get(lot.ingredientId);
    if (!ingredient) continue;
    const name = input.ingredientId === lot.ingredientId
      ? ({ kind: "exact", score: 1, alias: ingredient.name } as NameMatch)
      : input.ingredientId !== null
        ? null
        : matchIngredient(input.text, ingredient);
    if (!name) continue;

    if (lot.receivedOn > batch.madeOn) {
      excluded.push({ lotId: lot.lotId, reason: `Received ${lot.receivedOn}, after this batch was made` });
      continue;
    }
    const balance = lotBalance(ledger, lot.lotId);
    if (input.qty && comparable(input.qty, lot.qty) && toBase(input.qty) > balance.remainingConfirmed) {
      excluded.push({
        lotId: lot.lotId,
        reason: `Only ${balance.remainingConfirmed} ${balance.unit} left on record, batch used ${toBase(input.qty)}`,
      });
      continue;
    }

    const reasons: string[] = [];
    let score = 0.35 * name.score;
    if (name.kind === "exact") reasons.push(`Ingredient is ${ingredient.name}`);
    else reasons.push(`"${input.text}" matches local name "${name.alias}" for ${ingredient.name}`);

    const issued = lot.issuedTo.some((i) => i.kitchenId === batch.kitchenId && i.at <= batch.madeOn);
    if (issued) {
      score += 0.3;
      reasons.push("Issued to this kitchen before the batch");
    } else if (lot.issuedTo.length > 0) {
      score -= 0.15;
      reasons.push("Issued to other kitchens, not this one");
    }

    if (input.supplierHint) {
      const s = similarity(input.supplierHint, supplierName(ledger, lot));
      if (s >= 0.5) {
        score += 0.25;
        reasons.push(`Supplier matches "${input.supplierHint}"`);
      } else {
        score -= 0.1;
        reasons.push(`Supplier does not match "${input.supplierHint}"`);
      }
    }

    const ageDays = (Date.parse(batch.madeOn) - Date.parse(lot.receivedOn)) / 864e5;
    if (ageDays <= 45) {
      score += 0.1 * (1 - ageDays / 45);
      reasons.push(`Received ${Math.round(ageDays)} days before the batch`);
    }
    candidates.push({ target: { kind: "lot", id: lot.lotId }, score: Math.max(0, Math.round(score * 1000) / 1000), reasons });
  }

  // Earlier batches can be inputs too, such as a shared masala mix.
  if (input.ingredientId === null) {
    for (const other of ledger.batches.values()) {
      if (other.voided || other.batchId === batch.batchId || other.madeOn > batch.madeOn) continue;
      const product = ledger.products.get(other.productId);
      if (!product) continue;
      const name = matchIngredient(input.text, { name: product.name, aliases: product.aliases ?? [] });
      if (!name) continue;
      const reasons = [`"${input.text}" matches product ${product.name}`];
      let score = 0.35 * name.score;
      if (other.kitchenId === batch.kitchenId) {
        score += 0.3;
        reasons.push("Made by the same kitchen");
      }
      candidates.push({ target: { kind: "batch", id: other.batchId }, score: Math.round(score * 1000) / 1000, reasons });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id));
  return { candidates, excluded, exactCode: null };
}
