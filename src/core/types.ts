/**
 * Domain model. The ledger is an append-only list of events. Everything else
 * (lots, batches, balances, conclusions) is a pure projection of that list,
 * so any past state can be rebuilt and any conclusion can be re-derived.
 */
export type Id = string;
export type Unit = "g" | "kg" | "ml" | "l" | "jar" | "piece";
export interface Qty {
  value: number;
  unit: Unit;
}
export type Role = "kitchen" | "supplier" | "buyer" | "coordinator";

export interface EventBase {
  /** Assigned by the store. Order of the log, never reused. */
  seq: number;
  id: Id;
  /** Business date of the fact, YYYY-MM-DD. */
  at: string;
  actor: Id;
  /** Evidence records (voice note, photo, message) this event rests on. */
  evidence: Id[];
}

export interface PartyRegistered extends EventBase {
  type: "party.registered";
  partyId: Id;
  role: Role;
  name: string;
  phone?: string;
  address?: string;
}
export interface PartyUpdated extends EventBase {
  type: "party.updated";
  partyId: Id;
  phone?: string;
  address?: string;
}
export interface IngredientDefined extends EventBase {
  type: "ingredient.defined";
  ingredientId: Id;
  name: string;
  aliases: string[];
}
export interface ProductDefined extends EventBase {
  type: "product.defined";
  productId: Id;
  name: string;
  aliases?: string[];
  /** Ingredients the recipe expects. A batch missing one has a record gap. */
  recipe: Id[];
  shelfLifeDays?: number;
}
export interface LotReceived extends EventBase {
  type: "lot.received";
  lotId: Id;
  ingredientId: Id;
  supplierId: Id | null;
  /** The supplier's own code, exactly as printed. Recall notices use this. */
  supplierLotCode: string | null;
  qty: Qty;
  costPerUnit?: number;
}
export interface LotIssued extends EventBase {
  type: "lot.issued";
  lotId: Id;
  kitchenId: Id;
  qty: Qty;
}

export type InputRef =
  | { kind: "lot"; lotId: Id }
  | { kind: "batch"; batchId: Id }
  | { kind: "none" };

export interface BatchInput {
  inputId: Id;
  /** The words used, unchanged. */
  text: string;
  ingredientId: Id | null;
  qty: Qty | null;
  ref: InputRef;
  supplierHint?: string;
  lotCodeHint?: string;
}
export interface BatchLogged extends EventBase {
  type: "batch.logged";
  batchId: Id;
  kitchenId: Id;
  productId: Id;
  batchCode: string | null;
  made: Qty | null;
  inputs: BatchInput[];
}
export interface BatchCorrected extends EventBase {
  type: "batch.corrected";
  batchId: Id;
  made?: Qty | null;
  batchCode?: string | null;
  /** Replaces or adds inputs by inputId. */
  inputs?: BatchInput[];
  removeInputs?: Id[];
  reason: string;
}
export interface BatchVoided extends EventBase {
  type: "batch.voided";
  batchId: Id;
  reason: string;
}
export interface BatchAccepted extends EventBase {
  type: "batch.accepted";
  batchId: Id;
  accepted: Qty;
  rejected: Qty;
  ratePerJar: number;
}
export interface DispatchRecorded extends EventBase {
  type: "dispatch.recorded";
  dispatchId: Id;
  batchId: Id;
  /** null means the words did not identify a known buyer. */
  buyerId: Id | null;
  buyerText: string;
  qty: Qty;
}
export interface DispatchCorrected extends EventBase {
  type: "dispatch.corrected";
  dispatchId: Id;
  buyerId?: Id | null;
  qty?: Qty;
  reason: string;
}
export interface DispatchVoided extends EventBase {
  type: "dispatch.voided";
  dispatchId: Id;
  reason: string;
}
/** An unconfirmed claim can point at a supplier lot or at an earlier batch. */
export type LinkTarget = { kind: "lot"; id: Id } | { kind: "batch"; id: Id };

export interface LinkProposed extends EventBase {
  type: "link.proposed";
  linkId: Id;
  batchId: Id;
  inputId: Id;
  target: LinkTarget;
  score: number;
  reasons: string[];
  source: "rules" | "model";
}
export interface LinkConfirmed extends EventBase {
  type: "link.confirmed";
  linkId: Id;
}
export interface LinkRejected extends EventBase {
  type: "link.rejected";
  linkId: Id;
}
export interface LinkReopened extends EventBase {
  type: "link.reopened";
  linkId: Id;
  reason: string;
}
/** A person says this input is from none of the proposed lots. */
export interface InputSourceUnknown extends EventBase {
  type: "input.source_unknown";
  batchId: Id;
  inputId: Id;
}
export interface StockCounted extends EventBase {
  type: "stock.counted";
  subject: { kind: "lot" | "batch"; id: Id };
  qty: Qty;
}
export interface LossRecorded extends EventBase {
  type: "loss.recorded";
  subject: { kind: "lot" | "batch"; id: Id };
  qty: Qty;
  reason: string;
}

export type LedgerEvent =
  | PartyRegistered
  | PartyUpdated
  | IngredientDefined
  | ProductDefined
  | LotReceived
  | LotIssued
  | BatchLogged
  | BatchCorrected
  | BatchVoided
  | BatchAccepted
  | DispatchRecorded
  | DispatchCorrected
  | DispatchVoided
  | LinkProposed
  | LinkConfirmed
  | LinkRejected
  | LinkReopened
  | InputSourceUnknown
  | StockCounted
  | LossRecorded;

export type NewEvent = LedgerEvent extends infer E
  ? E extends LedgerEvent
    ? Omit<E, "seq" | "evidence"> & { evidence?: Id[] }
    : never
  : never;

// Projection ---------------------------------------------------------------

export interface Party {
  partyId: Id;
  role: Role;
  name: string;
  phone?: string;
  address?: string;
}
export interface Ingredient {
  ingredientId: Id;
  name: string;
  aliases: string[];
}
export interface Product {
  productId: Id;
  name: string;
  aliases?: string[];
  recipe: Id[];
  shelfLifeDays?: number;
}
export interface Lot {
  lotId: Id;
  ingredientId: Id;
  supplierId: Id | null;
  supplierLotCode: string | null;
  qty: Qty;
  receivedOn: string;
  costPerUnit?: number;
  issuedTo: { kitchenId: Id; qty: Qty; at: string }[];
  evidence: Id[];
}
export interface Batch {
  batchId: Id;
  kitchenId: Id;
  productId: Id;
  batchCode: string | null;
  made: Qty | null;
  madeOn: string;
  inputs: BatchInput[];
  voided: boolean;
  acceptance: BatchAccepted | null;
  sourceUnknown: Set<Id>;
  evidence: Id[];
}
export interface Dispatch {
  dispatchId: Id;
  batchId: Id;
  buyerId: Id | null;
  buyerText: string;
  qty: Qty;
  at: string;
  voided: boolean;
  evidence: Id[];
}
export type LinkStatus = "proposed" | "confirmed" | "rejected";
export interface Link {
  linkId: Id;
  batchId: Id;
  inputId: Id;
  target: LinkTarget;
  score: number;
  reasons: string[];
  source: "rules" | "model";
  status: LinkStatus;
  decidedBy: Id | null;
}
export interface Contradiction {
  code:
    | "duplicate_batch_code"
    | "lot_overdrawn"
    | "dispatched_more_than_made"
    | "used_before_received"
    | "lineage_cycle"
    | "unit_mismatch";
  subject: Id[];
  detail: string;
}
export interface Ledger {
  rev: number;
  parties: Map<Id, Party>;
  ingredients: Map<Id, Ingredient>;
  products: Map<Id, Product>;
  lots: Map<Id, Lot>;
  batches: Map<Id, Batch>;
  dispatches: Map<Id, Dispatch>;
  links: Map<Id, Link>;
  stock: Map<string, Qty>;
  losses: Map<string, Qty[]>;
}
