import type { Batch, Contradiction, Id, Ledger, Qty } from "./types";
import { sum, subjectKey } from "./ledger";
import { liveLinks, resolveInput } from "./lineage";
import { clean, comparable, toBase } from "./units";

export interface LotBalance {
  lotId: Id;
  received: number;
  unit: "g" | "ml" | "count";
  usedConfirmed: number;
  /** Uses that depend on an unconfirmed link. */
  usedConditional: number;
  /** Uses recorded against this lot with no quantity given. */
  usesWithoutQuantity: number;
  losses: number;
  onHand: number | null;
  /** What the records fail to explain, if every conditional use is true / false. */
  unexplainedMin: number;
  unexplainedMax: number;
  remainingConfirmed: number;
  withinTolerance: boolean;
  overdrawn: boolean;
}

export interface BatchBalance {
  batchId: Id;
  made: number | null;
  unit: "jar" | "g" | "ml" | "other";
  dispatchedKnown: number;
  dispatchedUnknownBuyer: number;
  usedInBatches: number;
  onHand: number;
  counted: boolean;
  losses: number;
  /** Quantity with no recorded destination. Negative means over-dispatched. */
  unaccounted: number | null;
}

export interface BalanceOptions {
  /** Share of a lot that may go unexplained, for spillage and sampling. */
  lotTolerance: number;
}
export const DEFAULTS: BalanceOptions = { lotTolerance: 0.02 };

function baseUnit(q: Qty): "g" | "ml" | "count" {
  return q.unit === "g" || q.unit === "kg" ? "g" : q.unit === "ml" || q.unit === "l" ? "ml" : "count";
}

export function lotBalance(ledger: Ledger, lotId: Id, opts = DEFAULTS): LotBalance {
  const lot = ledger.lots.get(lotId);
  if (!lot) throw new Error(`Unknown lot ${lotId}`);
  const received = toBase(lot.qty);
  let usedConfirmed = 0;
  let usedConditional = 0;
  let usesWithoutQuantity = 0;

  for (const batch of ledger.batches.values()) {
    if (batch.voided) continue;
    for (const input of batch.inputs) {
      const resolved = resolveInput(ledger, batch, input);
      const confirmedHere = resolved?.kind === "lot" && resolved.lotId === lotId;
      const conditionalHere =
        resolved === null &&
        liveLinks(ledger, batch.batchId, input.inputId).some(
          (l) => l.target.kind === "lot" && l.target.id === lotId,
        );
      if (!confirmedHere && !conditionalHere) continue;
      if (input.qty === null || !comparable(input.qty, lot.qty)) {
        usesWithoutQuantity += 1;
        continue;
      }
      if (confirmedHere) usedConfirmed += toBase(input.qty);
      else usedConditional += toBase(input.qty);
    }
  }

  const losses = sum(ledger.losses.get(subjectKey({ kind: "lot", id: lotId })) ?? [], lot.qty).total;
  const counted = ledger.stock.get(subjectKey({ kind: "lot", id: lotId }));
  const onHand = counted && comparable(counted, lot.qty) ? toBase(counted) : null;
  const accounted = usedConfirmed + losses + (onHand ?? 0);
  const unexplainedMax = clean(received - accounted);
  const unexplainedMin = clean(received - accounted - usedConditional);
  const tolerance = received * opts.lotTolerance;
  return {
    lotId,
    received,
    unit: baseUnit(lot.qty),
    usedConfirmed: clean(usedConfirmed),
    usedConditional: clean(usedConditional),
    usesWithoutQuantity,
    losses: clean(losses),
    onHand,
    unexplainedMin,
    unexplainedMax,
    remainingConfirmed: clean(received - usedConfirmed - losses),
    withinTolerance:
      usesWithoutQuantity === 0 && usedConditional === 0 && Math.abs(unexplainedMax) <= tolerance,
    overdrawn: clean(received - usedConfirmed - losses) < -tolerance,
  };
}

export function batchBalance(ledger: Ledger, batchId: Id): BatchBalance {
  const batch = ledger.batches.get(batchId);
  if (!batch) throw new Error(`Unknown batch ${batchId}`);
  const made = batch.made;
  const like = made ?? { value: 0, unit: "jar" as const };
  const dispatches = [...ledger.dispatches.values()].filter(
    (d) => d.batchId === batchId && !d.voided,
  );
  const dispatchedKnown = sum(
    dispatches.filter((d) => d.buyerId !== null).map((d) => d.qty),
    like,
  ).total;
  const dispatchedUnknownBuyer = sum(
    dispatches.filter((d) => d.buyerId === null).map((d) => d.qty),
    like,
  ).total;
  let usedInBatches = 0;
  for (const other of ledger.batches.values()) {
    if (other.voided) continue;
    for (const input of other.inputs) {
      const resolved = resolveInput(ledger, other, input);
      if (resolved?.kind === "batch" && resolved.batchId === batchId && input.qty && comparable(input.qty, like)) {
        usedInBatches += toBase(input.qty);
      }
    }
  }
  const losses = sum(ledger.losses.get(subjectKey({ kind: "batch", id: batchId })) ?? [], like).total;
  const stock = ledger.stock.get(subjectKey({ kind: "batch", id: batchId }));
  const onHand = stock && comparable(stock, like) ? toBase(stock) : 0;
  const rejected = batch.acceptance ? toBase(batch.acceptance.rejected) : 0;
  const madeBase = made ? toBase(made) : null;
  return {
    batchId,
    made: madeBase,
    unit: !made ? "other" : made.unit === "jar" ? "jar" : made.unit === "piece" ? "other" : baseUnit(made) === "g" ? "g" : "ml",
    dispatchedKnown: clean(dispatchedKnown),
    dispatchedUnknownBuyer: clean(dispatchedUnknownBuyer),
    usedInBatches: clean(usedInBatches),
    onHand: clean(onHand),
    counted: stock !== undefined,
    losses: clean(losses + rejected),
    unaccounted:
      madeBase === null
        ? null
        : clean(madeBase - dispatchedKnown - dispatchedUnknownBuyer - usedInBatches - onHand - losses - rejected),
  };
}

/** Finds records that cannot all be true. They are reported and never auto-fixed. */
export function findContradictions(ledger: Ledger, opts = DEFAULTS): Contradiction[] {
  const out: Contradiction[] = [];
  const byCode = new Map<string, Batch[]>();
  for (const b of ledger.batches.values()) {
    if (b.voided || !b.batchCode) continue;
    const key = `${b.kitchenId}|${b.batchCode}`;
    byCode.set(key, [...(byCode.get(key) ?? []), b]);
  }
  for (const group of byCode.values()) {
    if (group.length > 1) {
      out.push({
        code: "duplicate_batch_code",
        subject: group.map((b) => b.batchId),
        detail: `Batch code ${group[0]?.batchCode} appears ${group.length} times for one kitchen`,
      });
    }
  }
  for (const lot of ledger.lots.values()) {
    const bal = lotBalance(ledger, lot.lotId, opts);
    if (bal.overdrawn) {
      out.push({
        code: "lot_overdrawn",
        subject: [lot.lotId],
        detail: `Recorded use exceeds the amount received by ${clean(-bal.remainingConfirmed)} ${bal.unit}`,
      });
    }
  }
  for (const batch of ledger.batches.values()) {
    if (batch.voided) continue;
    const bal = batchBalance(ledger, batch.batchId);
    if (bal.unaccounted !== null && bal.unaccounted < 0) {
      out.push({
        code: "dispatched_more_than_made",
        subject: [batch.batchId],
        detail: `Recorded outflow exceeds the amount made by ${-bal.unaccounted}`,
      });
    }
    for (const input of batch.inputs) {
      if (input.ref.kind !== "lot") continue;
      const lot = ledger.lots.get(input.ref.lotId);
      if (lot && lot.receivedOn > batch.madeOn) {
        out.push({
          code: "used_before_received",
          subject: [batch.batchId, lot.lotId],
          detail: `Batch made ${batch.madeOn} uses a lot received ${lot.receivedOn}`,
        });
      }
    }
  }
  return out;
}
