import type { NewEvent } from "@/core/types";

/**
 * A fictional collective used for tests and the demo. Names, phone numbers,
 * suppliers and the problem with the chilli lot are all invented.
 */
export const FLAGGED_LOT = "lot-rt-0925";
export const DEMO_REASON = "Supplier Raju Traders reports that chilli powder lot RT-0925 is under investigation (fictional demo scenario)";

const at = "2026-10-01";
const sys = { at, actor: "coord-asha", evidence: [] as string[] };
let n = 0;
const id = () => `seed-${++n}`;

export function scenario(): NewEvent[] {
  n = 0;
  return [
    { ...sys, id: id(), type: "party.registered", partyId: "coord-asha", role: "coordinator", name: "Asha (coordinator)", phone: "+91-90000-00001" },
    { ...sys, id: id(), type: "party.registered", partyId: "k-meena", role: "kitchen", name: "Meena", phone: "+91-90000-00011" },
    { ...sys, id: id(), type: "party.registered", partyId: "k-farzana", role: "kitchen", name: "Farzana", phone: "+91-90000-00012" },
    { ...sys, id: id(), type: "party.registered", partyId: "k-lakshmi", role: "kitchen", name: "Lakshmi", phone: "+91-90000-00013" },
    { ...sys, id: id(), type: "party.registered", partyId: "s-raju", role: "supplier", name: "Raju Traders" },
    { ...sys, id: id(), type: "party.registered", partyId: "s-gupta", role: "supplier", name: "Gupta Masala" },
    { ...sys, id: id(), type: "party.registered", partyId: "b-sharma", role: "buyer", name: "Sharma Kirana", phone: "+91-90000-00021" },
    { ...sys, id: id(), type: "party.registered", partyId: "b-hostel", role: "buyer", name: "Girls hostel canteen", phone: "+91-90000-00022" },
    { ...sys, id: id(), type: "party.registered", partyId: "b-haat", role: "buyer", name: "Thursday haat stall" },
    { ...sys, id: id(), type: "ingredient.defined", ingredientId: "chilli", name: "chilli powder", aliases: ["lal mirch", "mirchi powder", "mirchi"] },
    { ...sys, id: id(), type: "ingredient.defined", ingredientId: "oil", name: "mustard oil", aliases: ["sarson tel", "sarson ka tel", "tel"] },
    { ...sys, id: id(), type: "ingredient.defined", ingredientId: "salt", name: "salt", aliases: ["namak"] },
    { ...sys, id: id(), type: "ingredient.defined", ingredientId: "mango", name: "raw mango", aliases: ["kairi", "kachha aam", "aam"] },
    { ...sys, id: id(), type: "product.defined", productId: "p-mango", name: "Mango pickle", recipe: ["mango", "oil", "salt", "chilli"], shelfLifeDays: 365 },
    { ...sys, id: id(), type: "product.defined", productId: "p-masala", name: "Pickle masala", aliases: ["masala"], recipe: ["chilli", "salt"] },

    { ...sys, id: id(), at: "2026-10-02", type: "lot.received", lotId: FLAGGED_LOT, ingredientId: "chilli", supplierId: "s-raju", supplierLotCode: "RT-0925", qty: { value: 10, unit: "kg" }, costPerUnit: 320 },
    { ...sys, id: id(), at: "2026-10-02", type: "lot.received", lotId: "lot-gm-118", ingredientId: "chilli", supplierId: "s-gupta", supplierLotCode: "GM-118", qty: { value: 10, unit: "kg" }, costPerUnit: 300 },
    { ...sys, id: id(), at: "2026-10-03", type: "lot.issued", lotId: FLAGGED_LOT, kitchenId: "k-meena", qty: { value: 5, unit: "kg" } },
    { ...sys, id: id(), at: "2026-10-03", type: "lot.issued", lotId: FLAGGED_LOT, kitchenId: "k-lakshmi", qty: { value: 5, unit: "kg" } },
    { ...sys, id: id(), at: "2026-10-03", type: "lot.issued", lotId: "lot-gm-118", kitchenId: "k-farzana", qty: { value: 7, unit: "kg" } },
    { ...sys, id: id(), at: "2026-10-03", type: "lot.issued", lotId: "lot-gm-118", kitchenId: "k-meena", qty: { value: 3, unit: "kg" } },

    // Meena read the code off the packet: confirmed.
    { id: id(), at: "2026-10-05", actor: "k-meena", evidence: ["note-m1"], type: "batch.logged", batchId: "b-m1101", kitchenId: "k-meena", productId: "p-mango", batchCode: "M-1101", made: { value: 40, unit: "jar" },
      inputs: [{ inputId: "i1", text: "lal mirch RT-0925", ingredientId: "chilli", qty: { value: 1, unit: "kg" }, ref: { kind: "lot", lotId: FLAGGED_LOT } }] },
    // Case A: "laal wala powder" could be either chilli lot she holds.
    { id: id(), at: "2026-10-09", actor: "k-meena", evidence: ["note-m2"], type: "batch.logged", batchId: "b-m1102", kitchenId: "k-meena", productId: "p-mango", batchCode: "M-1102", made: { value: 40, unit: "jar" },
      inputs: [{ inputId: "i1", text: "laal wala powder", ingredientId: null, qty: { value: 1, unit: "kg" }, ref: { kind: "none" } }] },
    { ...sys, id: id(), at: "2026-10-09", actor: "model", type: "link.proposed", linkId: "lk-m1102-rt", batchId: "b-m1102", inputId: "i1", target: { kind: "lot", id: FLAGGED_LOT }, score: 0.41, reasons: ["Model reads \"laal wala powder\" as chilli powder (likely); not confirmed", "Issued to this kitchen before the batch"], source: "model" },
    { ...sys, id: id(), at: "2026-10-09", actor: "model", type: "link.proposed", linkId: "lk-m1102-gm", batchId: "b-m1102", inputId: "i1", target: { kind: "lot", id: "lot-gm-118" }, score: 0.41, reasons: ["Model reads \"laal wala powder\" as chilli powder (likely); not confirmed", "Issued to this kitchen before the batch"], source: "model" },
    // Lakshmi's masala mix carries the lot into her pickle.
    { id: id(), at: "2026-10-06", actor: "k-lakshmi", evidence: ["note-l1"], type: "batch.logged", batchId: "b-lmx1", kitchenId: "k-lakshmi", productId: "p-masala", batchCode: "L-MX1", made: { value: 4, unit: "kg" },
      inputs: [{ inputId: "i1", text: "mirchi", ingredientId: "chilli", qty: { value: 3, unit: "kg" }, ref: { kind: "lot", lotId: FLAGGED_LOT } }] },
    { id: id(), at: "2026-10-08", actor: "k-lakshmi", evidence: ["note-l2"], type: "batch.logged", batchId: "b-l1103", kitchenId: "k-lakshmi", productId: "p-mango", batchCode: "L-1103", made: { value: 60, unit: "jar" },
      inputs: [{ inputId: "i1", text: "masala", ingredientId: null, qty: { value: 4, unit: "kg" }, ref: { kind: "batch", batchId: "b-lmx1" } }] },
    { id: id(), at: "2026-10-08", actor: "k-farzana", evidence: ["note-f1"], type: "batch.logged", batchId: "b-f1104", kitchenId: "k-farzana", productId: "p-mango", batchCode: "F-1104", made: { value: 50, unit: "jar" },
      inputs: [{ inputId: "i1", text: "mirchi GM-118", ingredientId: "chilli", qty: { value: 2, unit: "kg" }, ref: { kind: "lot", lotId: "lot-gm-118" } }] },
    // The log never mentions chilli, though the recipe needs it.
    { id: id(), at: "2026-10-12", actor: "k-lakshmi", evidence: ["note-l3"], type: "batch.logged", batchId: "b-l1105", kitchenId: "k-lakshmi", productId: "p-mango", batchCode: "L-1105", made: { value: 30, unit: "jar" },
      inputs: [{ inputId: "i1", text: "kairi", ingredientId: "mango", qty: { value: 9, unit: "kg" }, ref: { kind: "none" } }] },

    { ...sys, id: id(), at: "2026-10-10", type: "dispatch.recorded", dispatchId: "d1", batchId: "b-m1101", buyerId: "b-sharma", buyerText: "Sharma ji ki dukaan", qty: { value: 25, unit: "jar" } },
    { ...sys, id: id(), at: "2026-10-10", type: "dispatch.recorded", dispatchId: "d2", batchId: "b-m1101", buyerId: "b-hostel", buyerText: "hostel", qty: { value: 15, unit: "jar" } },
    { ...sys, id: id(), at: "2026-10-12", type: "dispatch.recorded", dispatchId: "d3", batchId: "b-m1102", buyerId: "b-sharma", buyerText: "Sharma ji", qty: { value: 20, unit: "jar" } },
    { ...sys, id: id(), at: "2026-10-12", type: "dispatch.recorded", dispatchId: "d4", batchId: "b-m1102", buyerId: "b-haat", buyerText: "haat wale bhaiya", qty: { value: 10, unit: "jar" } },
    // Case B: 10 jars of M-1102 have no record at all; 20 of L-1103 went to an unknown buyer.
    { ...sys, id: id(), at: "2026-10-11", type: "dispatch.recorded", dispatchId: "d5", batchId: "b-l1103", buyerId: "b-hostel", buyerText: "hostel", qty: { value: 40, unit: "jar" } },
    { ...sys, id: id(), at: "2026-10-13", type: "dispatch.recorded", dispatchId: "d6", batchId: "b-l1103", buyerId: null, buyerText: "Sunday mela mein ek aunty", qty: { value: 20, unit: "jar" } },
    { ...sys, id: id(), at: "2026-10-11", type: "dispatch.recorded", dispatchId: "d7", batchId: "b-f1104", buyerId: "b-sharma", buyerText: "Sharma", qty: { value: 50, unit: "jar" } },
    { ...sys, id: id(), at: "2026-10-14", type: "dispatch.recorded", dispatchId: "d8", batchId: "b-l1105", buyerId: "b-hostel", buyerText: "hostel", qty: { value: 30, unit: "jar" } },
    { ...sys, id: id(), at: "2026-10-20", type: "stock.counted", subject: { kind: "lot", id: FLAGGED_LOT }, qty: { value: 5, unit: "kg" } },
  ];
}
