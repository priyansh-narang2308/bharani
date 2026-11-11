import type { Id, Ledger, LedgerEvent, Qty } from "./types";
import { comparable, toBase } from "./units";

export function subjectKey(s: { kind: "lot" | "batch"; id: Id }): string {
  return `${s.kind}:${s.id}`;
}

/** Folds the event log into current state. Pure and order dependent. */
export function project(events: readonly LedgerEvent[]): Ledger {
  const l: Ledger = {
    rev: 0,
    parties: new Map(),
    ingredients: new Map(),
    products: new Map(),
    lots: new Map(),
    batches: new Map(),
    dispatches: new Map(),
    links: new Map(),
    stock: new Map(),
    losses: new Map(),
  };
  for (const e of events) {
    l.rev = Math.max(l.rev, e.seq);
    switch (e.type) {
      case "party.registered":
        l.parties.set(e.partyId, {
          partyId: e.partyId,
          role: e.role,
          name: e.name,
          phone: e.phone,
          address: e.address,
        });
        break;
      case "party.updated": {
        const p = l.parties.get(e.partyId);
        if (p) {
          if (e.phone !== undefined) p.phone = e.phone;
          if (e.address !== undefined) p.address = e.address;
        }
        break;
      }
      case "ingredient.defined":
        l.ingredients.set(e.ingredientId, {
          ingredientId: e.ingredientId,
          name: e.name,
          aliases: e.aliases,
        });
        break;
      case "product.defined":
        l.products.set(e.productId, {
          productId: e.productId,
          name: e.name,
          aliases: e.aliases,
          recipe: e.recipe,
          shelfLifeDays: e.shelfLifeDays,
        });
        break;
      case "lot.received":
        l.lots.set(e.lotId, {
          lotId: e.lotId,
          ingredientId: e.ingredientId,
          supplierId: e.supplierId,
          supplierLotCode: e.supplierLotCode,
          qty: e.qty,
          receivedOn: e.at,
          costPerUnit: e.costPerUnit,
          issuedTo: [],
          evidence: e.evidence,
        });
        break;
      case "lot.issued":
        l.lots.get(e.lotId)?.issuedTo.push({ kitchenId: e.kitchenId, qty: e.qty, at: e.at });
        break;
      case "batch.logged":
        l.batches.set(e.batchId, {
          batchId: e.batchId,
          kitchenId: e.kitchenId,
          productId: e.productId,
          batchCode: e.batchCode,
          made: e.made,
          madeOn: e.at,
          inputs: e.inputs.map((i) => ({ ...i })),
          voided: false,
          acceptance: null,
          sourceUnknown: new Set(),
          evidence: [...e.evidence],
        });
        break;
      case "batch.corrected": {
        const b = l.batches.get(e.batchId);
        if (!b) break;
        if (e.made !== undefined) b.made = e.made;
        if (e.batchCode !== undefined) b.batchCode = e.batchCode;
        for (const input of e.inputs ?? []) {
          const at = b.inputs.findIndex((i) => i.inputId === input.inputId);
          if (at >= 0) b.inputs[at] = { ...input };
          else b.inputs.push({ ...input });
          b.sourceUnknown.delete(input.inputId);
        }
        if (e.removeInputs) {
          b.inputs = b.inputs.filter((i) => !e.removeInputs?.includes(i.inputId));
        }
        b.evidence.push(...e.evidence);
        break;
      }
      case "batch.voided": {
        const b = l.batches.get(e.batchId);
        if (b) b.voided = true;
        break;
      }
      case "batch.accepted": {
        const b = l.batches.get(e.batchId);
        if (b) b.acceptance = e;
        break;
      }
      case "dispatch.recorded":
        l.dispatches.set(e.dispatchId, {
          dispatchId: e.dispatchId,
          batchId: e.batchId,
          buyerId: e.buyerId,
          buyerText: e.buyerText,
          qty: e.qty,
          at: e.at,
          voided: false,
          evidence: [...e.evidence],
        });
        break;
      case "dispatch.corrected": {
        const d = l.dispatches.get(e.dispatchId);
        if (!d) break;
        if (e.buyerId !== undefined) d.buyerId = e.buyerId;
        if (e.qty !== undefined) d.qty = e.qty;
        d.evidence.push(...e.evidence);
        break;
      }
      case "dispatch.voided": {
        const d = l.dispatches.get(e.dispatchId);
        if (d) d.voided = true;
        break;
      }
      case "link.proposed":
        if (!l.links.has(e.linkId)) {
          l.links.set(e.linkId, {
            linkId: e.linkId,
            batchId: e.batchId,
            inputId: e.inputId,
            target: e.target,
            score: e.score,
            reasons: e.reasons,
            source: e.source,
            status: "proposed",
            decidedBy: null,
          });
        }
        break;
      case "link.confirmed": {
        const target = l.links.get(e.linkId);
        if (!target) break;
        target.status = "confirmed";
        target.decidedBy = e.actor;
        // One input comes from one lot, so the sibling proposals fall away.
        for (const other of l.links.values()) {
          if (
            other.linkId !== target.linkId &&
            other.batchId === target.batchId &&
            other.inputId === target.inputId &&
            other.status !== "rejected"
          ) {
            other.status = "rejected";
            other.decidedBy = e.actor;
          }
        }
        l.batches.get(target.batchId)?.sourceUnknown.delete(target.inputId);
        break;
      }
      case "link.rejected": {
        const target = l.links.get(e.linkId);
        if (target) {
          target.status = "rejected";
          target.decidedBy = e.actor;
        }
        break;
      }
      case "link.reopened": {
        const target = l.links.get(e.linkId);
        if (!target) break;
        target.status = "proposed";
        target.decidedBy = null;
        for (const other of l.links.values()) {
          if (other.batchId === target.batchId && other.inputId === target.inputId) {
            other.status = "proposed";
            other.decidedBy = null;
          }
        }
        break;
      }
      case "input.source_unknown": {
        l.batches.get(e.batchId)?.sourceUnknown.add(e.inputId);
        for (const link of l.links.values()) {
          if (link.batchId === e.batchId && link.inputId === e.inputId) {
            link.status = "rejected";
            link.decidedBy = e.actor;
          }
        }
        break;
      }
      case "stock.counted":
        l.stock.set(subjectKey(e.subject), e.qty);
        break;
      case "loss.recorded": {
        const key = subjectKey(e.subject);
        l.losses.set(key, [...(l.losses.get(key) ?? []), e.qty]);
        break;
      }
    }
  }
  return l;
}

export function sum(quantities: Qty[], like: Qty): { total: number; incomparable: number } {
  let total = 0;
  let incomparable = 0;
  for (const q of quantities) {
    if (comparable(q, like)) total += toBase(q);
    else incomparable += 1;
  }
  return { total, incomparable };
}
