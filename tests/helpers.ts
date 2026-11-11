import { sequence } from "@/core/log";
import type { BatchInput, InputRef, LedgerEvent, LinkTarget, NewEvent, Qty } from "@/core/types";

export const kg = (value: number): Qty => ({ value, unit: "kg" });
export const jars = (value: number): Qty => ({ value, unit: "jar" });

let n = 0;
const nid = (p: string) => `${p}-${++n}`;

export function input(inputId: string, text: string, ingredientId: string | null, qty: Qty | null, ref: InputRef = { kind: "none" }): BatchInput {
  return { inputId, text, ingredientId, qty, ref };
}

/** Compact way to write a ledger in a test. Events keep the order they are added. */
export class Book {
  events: NewEvent[] = [];
  add(e: NewEvent) {
    this.events.push(e);
    return this;
  }
  party(partyId: string, role: "kitchen" | "supplier" | "buyer" | "coordinator", phone?: string) {
    return this.add({ type: "party.registered", id: nid("e"), at: "2026-09-01", actor: "t", partyId, role, name: partyId, phone });
  }
  ingredient(ingredientId: string, aliases: string[] = []) {
    return this.add({ type: "ingredient.defined", id: nid("e"), at: "2026-09-01", actor: "t", ingredientId, name: ingredientId, aliases });
  }
  product(productId: string, recipe: string[] = []) {
    return this.add({ type: "product.defined", id: nid("e"), at: "2026-09-01", actor: "t", productId, name: productId, recipe });
  }
  lot(lotId: string, ingredientId: string, qty: Qty, at = "2026-09-02", supplierId: string | null = "sup", code: string | null = lotId) {
    return this.add({ type: "lot.received", id: nid("e"), at, actor: "t", lotId, ingredientId, supplierId, supplierLotCode: code, qty });
  }
  batch(batchId: string, inputs: BatchInput[], made: Qty | null = jars(100), at = "2026-09-10", kitchenId = "k1", productId = "pickle", batchCode: string | null = batchId) {
    return this.add({ type: "batch.logged", id: nid("e"), at, actor: kitchenId, batchId, kitchenId, productId, batchCode, made, inputs });
  }
  ship(dispatchId: string, batchId: string, buyerId: string | null, qty: Qty, at = "2026-09-12") {
    return this.add({ type: "dispatch.recorded", id: nid("e"), at, actor: "t", dispatchId, batchId, buyerId, buyerText: buyerId ?? "someone at the mela", qty });
  }
  propose(linkId: string, batchId: string, inputId: string, target: LinkTarget) {
    return this.add({ type: "link.proposed", id: nid("e"), at: "2026-09-13", actor: "rules", linkId, batchId, inputId, target, score: 0.5, reasons: [], source: "rules" });
  }
  confirm(linkId: string) {
    return this.add({ type: "link.confirmed", id: nid("e"), at: "2026-09-14", actor: "coord", linkId });
  }
  reject(linkId: string) {
    return this.add({ type: "link.rejected", id: nid("e"), at: "2026-09-14", actor: "coord", linkId });
  }
  log(): LedgerEvent[] {
    return sequence(this.events);
  }
  /** Parties and master data most tests share. */
  static base() {
    return new Book()
      .party("sup", "supplier", "1")
      .party("k1", "kitchen", "2")
      .party("k2", "kitchen", "3")
      .party("shop", "buyer", "4")
      .party("hostel", "buyer", "5")
      .ingredient("chilli", ["mirchi", "lal mirch"])
      .ingredient("salt")
      .ingredient("mustard oil", ["sarson tel"])
      .product("pickle", ["chilli"]);
  }
}
export const lotRef = (lotId: string): InputRef => ({ kind: "lot", lotId });
export const batchRef = (batchId: string): InputRef => ({ kind: "batch", batchId });
