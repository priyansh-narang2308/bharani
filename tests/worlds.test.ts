import { describe, expect, it } from "vitest";
import { computeLineage, evaluate, liveLinks } from "@/core/lineage";
import { project } from "@/core/ledger";
import type { Id, Ledger } from "@/core/types";
import { Book, batchRef, input, jars, kg, lotRef } from "./helpers";

/** Small seeded generator so a failure can be reproduced from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBook(seed: number): { book: Book; lots: Id[]; batches: Id[] } {
  const r = rng(seed);
  const pick = (n: number) => Math.floor(r() * n);
  const book = Book.base().product("mix");
  const lots = ["L0", "L1", "L2", "L3"];
  for (const l of lots) book.lot(l, "chilli", kg(1000));
  const batches: Id[] = [];
  const count = 4 + pick(6);
  for (let i = 0; i < count; i++) {
    const id = `b${i}`;
    const inputs = [];
    const links: [string, string, { kind: "lot" | "batch"; id: Id }][] = [];
    const inputCount = 1 + pick(3);
    for (let k = 0; k < inputCount; k++) {
      const inputId = `i${k}`;
      const shape = pick(4);
      const earlier = batches.length > 0;
      if (shape === 0) {
        inputs.push(input(inputId, "mirchi", "chilli", kg(1), lotRef(lots[pick(4)] as Id)));
      } else if (shape === 1 && earlier) {
        inputs.push(input(inputId, "mix", "chilli", kg(1), batchRef(batches[pick(batches.length)] as Id)));
      } else {
        inputs.push(input(inputId, "mirchi", "chilli", kg(1)));
        const options = 2 + pick(2);
        const used = new Set<string>();
        for (let o = 0; o < options; o++) {
          const toBatch = earlier && r() < 0.4;
          const target = toBatch
            ? ({ kind: "batch", id: batches[pick(batches.length)] as Id } as const)
            : ({ kind: "lot", id: lots[pick(4)] as Id } as const);
          const key = `${target.kind}:${target.id}`;
          if (used.has(key)) continue;
          used.add(key);
          links.push([`${id}.${inputId}.${o}`, inputId, target]);
        }
      }
    }
    book.batch(id, inputs, jars(10), "2026-09-10", "k1", "mix");
    for (const [linkId, inputId, target] of links) book.propose(linkId, id, inputId, target);
    batches.push(id);
  }
  return { book, lots, batches };
}

/** Ground truth for one complete choice of links, by plain walking. */
function contains(ledger: Ledger, world: Set<Id>, batchId: Id, flagged: Set<Id>): boolean {
  const batch = ledger.batches.get(batchId);
  if (!batch) return false;
  return batch.inputs.some((inp) => {
    if (inp.ref.kind === "lot") return flagged.has(inp.ref.lotId);
    if (inp.ref.kind === "batch") return contains(ledger, world, inp.ref.batchId, flagged);
    const chosen = liveLinks(ledger, batchId, inp.inputId).find((l) => world.has(l.linkId));
    if (!chosen) return false;
    return chosen.target.kind === "lot" ? flagged.has(chosen.target.id) : contains(ledger, world, chosen.target.id, flagged);
  });
}

function* worlds(groups: Id[][]): Generator<Set<Id>> {
  const walk = function* (i: number, chosen: Id[]): Generator<Id[]> {
    if (i === groups.length) {
      yield chosen;
      return;
    }
    for (const option of groups[i] ?? []) yield* walk(i + 1, [...chosen, option]);
  };
  for (const w of walk(0, [])) yield new Set(w);
}

describe("every possible world agrees with the computed conditions", () => {
  it("holds across 300 random ledgers, checked exhaustively or by sampling", () => {
    let checkedWorlds = 0;
    let conditionalBatches = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { book, batches } = randomBook(seed);
      const ledger = project(book.log());
      const flagged = new Set(["L0"]);
      const lineage = computeLineage(ledger, ["L0"]);
      const groups = new Map<string, Id[]>();
      for (const l of ledger.links.values()) {
        const k = `${l.batchId}:${l.inputId}`;
        groups.set(k, [...(groups.get(k) ?? []), l.linkId]);
      }
      const list = [...groups.values()];
      const size = list.reduce((n, g) => n * g.length, 1);
      const r = rng(seed * 7919);
      const sample =
        size <= 4096
          ? [...worlds(list)]
          : Array.from({ length: 2000 }, () => new Set(list.map((g) => g[Math.floor(r() * g.length)] as Id)));
      for (const world of sample) {
        checkedWorlds += 1;
        for (const id of batches) {
          const line = lineage.get(id);
          if (!line) throw new Error("missing lineage");
          const truth = contains(ledger, world, id, flagged);
          const computed = evaluate(line.condition, (l) => world.has(l));
          if (truth !== computed) throw new Error(`seed ${seed} batch ${id}: truth ${truth}, computed ${computed}`);
          if (line.status === "confirmed") expect(truth).toBe(true);
          if (line.status === "no_recorded_link") expect(truth).toBe(false);
        }
      }
      conditionalBatches += [...lineage.values()].filter((l) => l.status === "conditional").length;
    }
    expect(conditionalBatches).toBeGreaterThan(100);
    console.log(`checked ${checkedWorlds} worlds, ${conditionalBatches} conditional batches`);
  });
});
