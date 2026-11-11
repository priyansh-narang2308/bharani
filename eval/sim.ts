import { candidateLots } from "@/core/candidates";
import { project } from "@/core/ledger";
import { sequence } from "@/core/log";
import type { BatchInput, Id, LedgerEvent, NewEvent } from "@/core/types";

/**
 * Synthetic ground truth. A hidden "true world" says which lot every input
 * really used and where every jar really went. Records are then degraded the
 * way informal logs are. All numbers measured on this are synthetic.
 */
export interface SimParams {
  kitchens: number;
  batches: number;
  pCode: number;
  pVague: number;
  pOmit: number;
  pDispatchMissing: number;
  pUnknownBuyer: number;
  pNoPhone: number;
  pMasala: number;
}
export const DEFAULT_PARAMS: SimParams = { kitchens: 5, batches: 40, pCode: 0.45, pVague: 0.15, pOmit: 0.05, pDispatchMissing: 0.1, pUnknownBuyer: 0.08, pNoPhone: 0.1, pMasala: 0.25 };

export interface TrueWorld {
  /** batchId -> inputId -> true source */
  sources: Map<Id, Map<Id, { kind: "lot" | "batch"; id: Id }>>;
  dispatches: { batchId: Id; buyerId: Id; jars: number }[];
  made: Map<Id, number>;
  flagged: Id;
}
export interface Sim {
  events: LedgerEvent[];
  truth: TrueWorld;
  affectedBatches: Set<Id>;
  affectedJarsByBuyer: Map<Id, number>;
}

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulate(seed: number, p: SimParams = DEFAULT_PARAMS): Sim {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)] as T;
  const day = (d: number) => `2026-09-${String(1 + d).padStart(2, "0")}`;
  const e: NewEvent[] = [];
  let k = 0;
  const nid = () => `s${++k}`;
  const base = (at: string, actor = "coord") => ({ id: nid(), at, actor, evidence: [] as string[] });

  const kitchens = Array.from({ length: p.kitchens }, (_, i) => `k${i}`);
  const buyers = Array.from({ length: 10 }, (_, i) => `buyer${i}`);
  for (const kId of kitchens) e.push({ ...base(day(0)), type: "party.registered", partyId: kId, role: "kitchen", name: kId, phone: "x" });
  for (const b of buyers) e.push({ ...base(day(0)), type: "party.registered", partyId: b, role: "buyer", name: b, phone: r() < p.pNoPhone ? undefined : "x" });
  for (const s of ["supA", "supB", "supC"]) e.push({ ...base(day(0)), type: "party.registered", partyId: s, role: "supplier", name: s });
  e.push({ ...base(day(0)), type: "ingredient.defined", ingredientId: "chilli", name: "chilli powder", aliases: ["mirchi"] });
  e.push({ ...base(day(0)), type: "ingredient.defined", ingredientId: "oil", name: "mustard oil", aliases: ["tel"] });
  e.push({ ...base(day(0)), type: "product.defined", productId: "pickle", name: "Pickle", recipe: ["chilli", "oil"] });
  e.push({ ...base(day(0)), type: "product.defined", productId: "masala", name: "Masala", aliases: ["masala"], recipe: ["chilli"] });

  const lots: Record<string, Id[]> = { chilli: ["c0", "c1", "c2"], oil: ["o0", "o1"] };
  const suppliers: Record<Id, Id> = { c0: "supA", c1: "supB", c2: "supC", o0: "supA", o1: "supB" };
  for (const [ing, ids] of Object.entries(lots)) {
    for (const l of ids) e.push({ ...base(day(0)), type: "lot.received", lotId: l, ingredientId: ing, supplierId: suppliers[l] ?? null, supplierLotCode: l.toUpperCase(), qty: { value: 500, unit: "kg" } });
  }
  const holds = new Map<Id, Record<string, Id[]>>();
  for (const kId of kitchens) {
    const h: Record<string, Id[]> = {};
    for (const [ing, ids] of Object.entries(lots)) {
      const mine = ids.filter(() => r() < 0.6);
      h[ing] = mine.length > 0 ? mine : [pick(ids)];
      for (const l of h[ing] ?? []) e.push({ ...base(day(0)), type: "lot.issued", lotId: l, kitchenId: kId, qty: { value: 50, unit: "kg" } });
    }
    holds.set(kId, h);
  }

  const truth: TrueWorld = { sources: new Map(), dispatches: [], made: new Map(), flagged: "c0" };
  const masalas: { id: Id; kitchen: Id; at: number }[] = [];
  const pending: { batchId: Id; recorded: BatchInput; candidatesFor: "rules" | "model" | null }[] = [];

  for (let i = 0; i < p.batches; i++) {
    const kId = pick(kitchens);
    const at = 1 + Math.floor((i / p.batches) * 25);
    const isMasala = r() < 0.2;
    const batchId = `B${i}`;
    const src = new Map<Id, { kind: "lot" | "batch"; id: Id }>();
    const recorded: BatchInput[] = [];
    const h = holds.get(kId) ?? {};
    const ings = isMasala ? ["chilli"] : ["chilli", "oil"];
    for (const ing of ings) {
      const inputId = `i-${ing}`;
      const earlier = masalas.filter((m) => m.kitchen === kId && m.at < at);
      const useMasala = !isMasala && ing === "chilli" && earlier.length > 0 && r() < p.pMasala;
      const truthSrc = useMasala ? { kind: "batch" as const, id: pick(earlier).id } : { kind: "lot" as const, id: pick(h[ing] ?? []) };
      src.set(inputId, truthSrc);
      const roll = r();
      if (roll < p.pOmit) continue;
      if (truthSrc.kind === "batch") {
        // Masala use is usually said plainly, but which batch is often not.
        if (r() < 0.5) recorded.push({ inputId, text: "masala", ingredientId: null, qty: { value: 1, unit: "kg" }, ref: { kind: "batch", batchId: truthSrc.id } });
        else {
          const input: BatchInput = { inputId, text: "masala", ingredientId: null, qty: { value: 1, unit: "kg" }, ref: { kind: "none" } };
          recorded.push(input);
          pending.push({ batchId, recorded: input, candidatesFor: "rules" });
        }
        continue;
      }
      if (r() < p.pCode) recorded.push({ inputId, text: ing, ingredientId: ing, qty: { value: 1, unit: "kg" }, ref: { kind: "lot", lotId: truthSrc.id } });
      else if (r() < p.pVague) {
        const input: BatchInput = { inputId, text: "laal wala", ingredientId: null, qty: { value: 1, unit: "kg" }, ref: { kind: "none" } };
        recorded.push(input);
        pending.push({ batchId, recorded: { ...input, ingredientId: ing }, candidatesFor: "model" });
      } else {
        const input: BatchInput = { inputId, text: ing, ingredientId: ing, qty: { value: 1, unit: "kg" }, ref: { kind: "none" } };
        recorded.push(input);
        pending.push({ batchId, recorded: input, candidatesFor: "rules" });
      }
    }
    truth.sources.set(batchId, src);
    const made = isMasala ? 0 : 20 + Math.floor(r() * 60);
    truth.made.set(batchId, made);
    e.push({ ...base(day(at), kId), type: "batch.logged", batchId, kitchenId: kId, productId: isMasala ? "masala" : "pickle", batchCode: batchId, made: isMasala ? { value: 5, unit: "kg" } : { value: made, unit: "jar" }, inputs: recorded });
    if (isMasala) {
      masalas.push({ id: batchId, kitchen: kId, at });
      continue;
    }
    let left = made;
    const splits = 1 + Math.floor(r() * 3);
    for (let s = 0; s < splits && left > 0; s++) {
      const jars = s === splits - 1 ? left : Math.max(1, Math.floor(left * r()));
      left -= jars;
      const buyerId = pick(buyers);
      truth.dispatches.push({ batchId, buyerId, jars });
      if (r() < p.pDispatchMissing) continue;
      const unknown = r() < p.pUnknownBuyer;
      e.push({ ...base(day(at + 2)), type: "dispatch.recorded", dispatchId: `D${batchId}-${s}`, batchId, buyerId: unknown ? null : buyerId, buyerText: buyerId, qty: { value: jars, unit: "jar" } });
    }
  }

  // Candidate proposals, made the same way the app makes them.
  const ledger = project(sequence(e));
  for (const pnd of pending) {
    const b = ledger.batches.get(pnd.batchId);
    if (!b) continue;
    const cands = candidateLots(ledger, b, pnd.recorded).candidates;
    cands.forEach((c, j) => e.push({
      ...base(day(28), pnd.candidatesFor ?? "rules"), type: "link.proposed", linkId: `${pnd.batchId}.${pnd.recorded.inputId}.${j}`, batchId: pnd.batchId, inputId: pnd.recorded.inputId,
      target: c.target, score: c.score, reasons: c.reasons, source: pnd.candidatesFor ?? "rules",
    }));
  }

  const affected = new Set<Id>();
  const contains = (batchId: Id, seen = new Set<Id>()): boolean => {
    if (seen.has(batchId)) return false;
    seen.add(batchId);
    for (const s of truth.sources.get(batchId)?.values() ?? []) {
      if (s.kind === "lot" ? s.id === truth.flagged : contains(s.id, seen)) return true;
    }
    return false;
  };
  for (const id of truth.sources.keys()) if (contains(id)) affected.add(id);
  const byBuyer = new Map<Id, number>();
  for (const d of truth.dispatches) if (affected.has(d.batchId)) byBuyer.set(d.buyerId, (byBuyer.get(d.buyerId) ?? 0) + d.jars);
  return { events: sequence(e), truth, affectedBatches: affected, affectedJarsByBuyer: byBuyer };
}

/** The true answer to "which source did this input use?" */
export function trueLink(sim: Sim, linkTarget: { kind: string; id: Id }, batchId: Id, inputId: Id): boolean {
  const s = sim.truth.sources.get(batchId)?.get(inputId);
  return !!s && s.kind === linkTarget.kind && s.id === linkTarget.id;
}
