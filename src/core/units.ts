import type { Qty, Unit } from "./types";

export type Dimension = "mass" | "volume" | "count";

const BASE: Record<Unit, { dim: Dimension; factor: number }> = {
  g: { dim: "mass", factor: 1 },
  kg: { dim: "mass", factor: 1000 },
  ml: { dim: "volume", factor: 1 },
  l: { dim: "volume", factor: 1000 },
  jar: { dim: "count", factor: 1 },
  piece: { dim: "count", factor: 1 },
};

export function dimension(unit: Unit): Dimension {
  return BASE[unit].dim;
}
/** Value in the base unit of its dimension (g, ml or count). */
export function toBase(q: Qty): number {
  return q.value * BASE[q.unit].factor;
}
export function comparable(a: Qty, b: Qty): boolean {
  return BASE[a.unit].dim === BASE[b.unit].dim;
}
/** Rounds away floating point noise in sums of grams and millilitres. */
export function clean(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
