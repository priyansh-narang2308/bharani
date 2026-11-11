import type { Batch, BatchInput, Id, InputRef, Ledger, Link } from "./types";

/**
 * A condition is a monotone formula in disjunctive normal form over link ids.
 * Each clause is one path from the flagged lot to the batch, and it holds only
 * if every unconfirmed link on that path is true.
 *   []     no path (false)
 *   [[]]   a path made of confirmed records only (true)
 * A path enters each batch once, so one clause never needs two different
 * sources for the same input. Clashes can only occur between clauses.
 */
export type Dnf = Id[][];
export const FALSE: Dnf = [];
export const TRUE: Dnf = [[]];

export type GapCode =
  | "input_source_unknown"
  | "input_unidentified"
  | "recipe_input_missing"
  | "subbatch_undetermined"
  | "lineage_cycle";

export interface Gap {
  code: GapCode;
  batchId: Id;
  inputId?: Id;
  ingredientId?: Id;
  text: string;
}

export type ImpactClass = "confirmed" | "conditional" | "undetermined" | "no_recorded_link";

export interface LineageHop {
  inputId: Id;
  text: string;
  from: { kind: "lot" | "batch"; id: Id };
  linkId: Id | null;
  confirmed: boolean;
}
export interface BatchLineage {
  batchId: Id;
  status: ImpactClass;
  condition: Dnf;
  gaps: Gap[];
  hops: LineageHop[];
}

function normalise(dnf: Dnf): Dnf {
  const sets = dnf.map((c) => [...new Set(c)].sort());
  // Absorption: if A alone is enough, A and B adds nothing.
  const kept = sets.filter(
    (c, i) =>
      !sets.some(
        (o, j) =>
          j !== i &&
          o.every((x) => c.includes(x)) &&
          (o.length < c.length || (o.length === c.length && j < i)),
      ),
  );
  return kept.sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()));
}

export function or(a: Dnf, b: Dnf): Dnf {
  return normalise([...a, ...b]);
}
export function and(a: Dnf, b: Dnf): Dnf {
  return normalise(a.flatMap((x) => b.map((y) => [...x, ...y])));
}
export function evaluate(dnf: Dnf, isTrue: (linkId: Id) => boolean): boolean {
  return dnf.some((clause) => clause.every(isTrue));
}

export function liveLinks(ledger: Ledger, batchId: Id, inputId: Id): Link[] {
  return [...ledger.links.values()]
    .filter((l) => l.batchId === batchId && l.inputId === inputId && l.status !== "rejected")
    .sort((a, b) => a.linkId.localeCompare(b.linkId));
}

/** Where an input came from, if the records settle it. Null while open. */
export function resolveInput(ledger: Ledger, batch: Batch, input: BatchInput): Exclude<InputRef, { kind: "none" }> | null {
  if (input.ref.kind !== "none") return input.ref;
  const confirmed = liveLinks(ledger, batch.batchId, input.inputId).find((l) => l.status === "confirmed");
  if (!confirmed) return null;
  return confirmed.target.kind === "lot"
    ? { kind: "lot", lotId: confirmed.target.id }
    : { kind: "batch", batchId: confirmed.target.id };
}

function dependencies(ledger: Ledger, batch: Batch): Id[] {
  const deps: Id[] = [];
  for (const input of batch.inputs) {
    if (input.ref.kind === "batch") deps.push(input.ref.batchId);
    for (const link of liveLinks(ledger, batch.batchId, input.inputId)) {
      if (link.target.kind === "batch") deps.push(link.target.id);
    }
  }
  return deps;
}

/** Dependencies first. Batches caught in a cycle are reported, not followed. */
export function topoOrder(ledger: Ledger): { order: Batch[]; cyclic: Set<Id> } {
  const state = new Map<Id, 1 | 2>();
  const order: Batch[] = [];
  const cyclic = new Set<Id>();
  const visit = (id: Id, stack: Id[]) => {
    const b = ledger.batches.get(id);
    if (!b) return;
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) {
      for (const member of stack.slice(stack.indexOf(id))) cyclic.add(member);
      return;
    }
    state.set(id, 1);
    for (const dep of dependencies(ledger, b)) visit(dep, [...stack, id]);
    state.set(id, 2);
    order.push(b);
  };
  for (const id of [...ledger.batches.keys()].sort()) visit(id, []);
  return { order, cyclic };
}

/**
 * Computes how every batch relates to the flagged lots.
 * An unknown source only counts against a batch if the words could be the
 * flagged ingredient. Knowing that "salt" came from nowhere in particular says
 * nothing about a flagged chilli lot.
 */
export function computeLineage(ledger: Ledger, flagged: readonly Id[]): Map<Id, BatchLineage> {
  const flaggedSet = new Set(flagged);
  const flaggedIngredients = new Set(
    flagged.flatMap((id) => {
      const lot = ledger.lots.get(id);
      return lot ? [lot.ingredientId] : [];
    }),
  );
  const { order, cyclic } = topoOrder(ledger);
  const out = new Map<Id, BatchLineage>();

  for (const batch of order) {
    let condition: Dnf = FALSE;
    const gaps: Gap[] = [];
    const hops: LineageHop[] = [];

    if (batch.voided) {
      out.set(batch.batchId, { batchId: batch.batchId, status: "no_recorded_link", condition, gaps, hops });
      continue;
    }
    if (cyclic.has(batch.batchId)) {
      gaps.push({ code: "lineage_cycle", batchId: batch.batchId, text: "Batch records refer to each other in a loop" });
    }

    for (const input of batch.inputs) {
      const resolved = resolveInput(ledger, batch, input);

      if (resolved?.kind === "lot") {
        if (flaggedSet.has(resolved.lotId)) {
          condition = or(condition, TRUE);
          hops.push({ inputId: input.inputId, text: input.text, from: { kind: "lot", id: resolved.lotId }, linkId: null, confirmed: true });
        }
        continue;
      }
      if (resolved?.kind === "batch") {
        if (cyclic.has(batch.batchId)) continue;
        const sub = out.get(resolved.batchId);
        if (!sub) continue;
        if (sub.condition.length > 0) {
          condition = or(condition, sub.condition);
          hops.push({ inputId: input.inputId, text: input.text, from: { kind: "batch", id: resolved.batchId }, linkId: null, confirmed: sub.status === "confirmed" });
        }
        if (sub.gaps.length > 0) {
          gaps.push({ code: "subbatch_undetermined", batchId: batch.batchId, inputId: input.inputId, text: `Uses a batch that has open gaps` });
        }
        continue;
      }

      const links = liveLinks(ledger, batch.batchId, input.inputId);
      for (const link of links) {
        if (link.target.kind === "lot") {
          if (!flaggedSet.has(link.target.id)) continue;
          condition = or(condition, [[link.linkId]]);
          hops.push({ inputId: input.inputId, text: input.text, from: { kind: "lot", id: link.target.id }, linkId: link.linkId, confirmed: false });
        } else {
          if (cyclic.has(batch.batchId)) continue;
          const sub = out.get(link.target.id);
          if (!sub) continue;
          if (sub.condition.length > 0) {
            condition = or(condition, and([[link.linkId]], sub.condition));
            hops.push({ inputId: input.inputId, text: input.text, from: { kind: "batch", id: link.target.id }, linkId: link.linkId, confirmed: false });
          }
          if (sub.gaps.length > 0) {
            gaps.push({ code: "subbatch_undetermined", batchId: batch.batchId, inputId: input.inputId, text: `May use a batch that has open gaps` });
          }
        }
      }

      // Words that name no known ingredient cannot be ruled out by links that
      // assume one. Only a person's confirmation settles what the words meant.
      if (input.ingredientId === null && links.every((l) => l.target.kind === "lot")) {
        gaps.push({ code: "input_unidentified", batchId: batch.batchId, inputId: input.inputId, text: `"${input.text}" is not confirmed as any ingredient` });
        continue;
      }
      if (links.length === 0) {
        if (input.ingredientId === null) {
          gaps.push({ code: "input_unidentified", batchId: batch.batchId, inputId: input.inputId, text: `"${input.text}" could not be identified` });
        } else if (flaggedIngredients.has(input.ingredientId)) {
          gaps.push({ code: "input_source_unknown", batchId: batch.batchId, inputId: input.inputId, ingredientId: input.ingredientId, text: `Source of "${input.text}" is not recorded` });
        }
      }
    }

    // A recipe ingredient the log never mentions could have come from anywhere.
    const product = ledger.products.get(batch.productId);
    for (const ingredientId of product?.recipe ?? []) {
      if (!flaggedIngredients.has(ingredientId)) continue;
      const mentioned = batch.inputs.some((i) => {
        if (i.ingredientId === ingredientId || i.ingredientId === null) return true;
        const r = resolveInput(ledger, batch, i);
        if (r?.kind === "batch") return true;
        if (r?.kind === "lot") return ledger.lots.get(r.lotId)?.ingredientId === ingredientId;
        return liveLinks(ledger, batch.batchId, i.inputId).some(
          (l) => l.target.kind === "batch" || ledger.lots.get(l.target.id)?.ingredientId === ingredientId,
        );
      });
      if (!mentioned) {
        gaps.push({ code: "recipe_input_missing", batchId: batch.batchId, ingredientId, text: `Recipe needs ${ledger.ingredients.get(ingredientId)?.name ?? ingredientId}, but the log does not mention it` });
      }
    }

    const status: ImpactClass = condition.some((c) => c.length === 0)
      ? "confirmed"
      : condition.length > 0
        ? "conditional"
        : gaps.length > 0
          ? "undetermined"
          : "no_recorded_link";
    out.set(batch.batchId, { batchId: batch.batchId, status, condition, gaps, hops });
  }
  return out;
}
