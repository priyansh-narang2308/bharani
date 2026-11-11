import { batchBalance, DEFAULTS, findContradictions, lotBalance, type BalanceOptions, type BatchBalance, type LotBalance } from "./balance";
import { computeLineage, type BatchLineage, type Dnf, type Gap, type ImpactClass } from "./lineage";
import type { Contradiction, Id, Ledger } from "./types";

export interface BatchImpact extends BatchLineage {
  kitchenId: Id;
  productId: Id;
  batchCode: string | null;
  madeOn: string;
  balance: BatchBalance;
}
export interface RecipientExposure {
  buyerId: Id;
  name: string;
  phone?: string;
  address?: string;
  contactable: boolean;
  jars: Record<ImpactClass, number>;
  dispatches: { dispatchId: Id; batchId: Id; jars: number; at: string; status: ImpactClass }[];
}
export type BlockerCode =
  | "conditional_batches"
  | "undetermined_batches"
  | "lot_unexplained"
  | "batch_unaccounted"
  | "recipient_unknown"
  | "recipient_no_contact"
  | "contradiction";
export interface Blocker {
  code: BlockerCode;
  subject: Id[];
  message: string;
}
export interface ImpactReport {
  rev: number;
  flagged: Id[];
  batches: BatchImpact[];
  recipients: RecipientExposure[];
  lots: LotBalance[];
  contradictions: Contradiction[];
  jars: Record<ImpactClass, number>;
  unknownRecipientJars: number;
  unaccountedJars: number;
  gaps: Gap[];
  blockers: Blocker[];
  /**
   * True only if nothing blocks the claim. Even then it means complete against
   * the records held, which says nothing about food never written down.
   */
  recipientListComplete: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const amount = (base: number, unit: "g" | "ml" | "count") =>
  unit === "count" ? `${base}` : base >= 1000 || base === 0 ? `${base / 1000} ${unit === "g" ? "kg" : "litres"}` : `${base} ${unit}`;

const ZERO = (): Record<ImpactClass, number> => ({
  confirmed: 0,
  conditional: 0,
  undetermined: 0,
  no_recorded_link: 0,
});

export function traceImpact(ledger: Ledger, flagged: readonly Id[], opts: BalanceOptions = DEFAULTS): ImpactReport {
  for (const id of flagged) {
    if (!ledger.lots.has(id)) throw new Error(`Unknown lot ${id}`);
  }
  const lineage = computeLineage(ledger, flagged);
  const batches: BatchImpact[] = [];
  for (const line of lineage.values()) {
    const b = ledger.batches.get(line.batchId);
    if (!b || b.voided) continue;
    batches.push({
      ...line,
      kitchenId: b.kitchenId,
      productId: b.productId,
      batchCode: b.batchCode,
      madeOn: b.madeOn,
      balance: batchBalance(ledger, b.batchId),
    });
  }
  batches.sort((a, b) => a.madeOn.localeCompare(b.madeOn) || a.batchId.localeCompare(b.batchId));

  const jars = ZERO();
  let unaccountedJars = 0;
  let unknownRecipientJars = 0;
  const recipients = new Map<Id, RecipientExposure>();
  const blockers: Blocker[] = [];
  const gaps: Gap[] = [];

  for (const b of batches) {
    if (b.balance.unit === "jar" && b.balance.made !== null) jars[b.status] += b.balance.made;
    if (b.status === "no_recorded_link") continue;
    gaps.push(...b.gaps);
    if (b.balance.unit === "jar") {
      unaccountedJars += Math.max(0, b.balance.unaccounted ?? 0);
      unknownRecipientJars += b.balance.dispatchedUnknownBuyer;
    }
    for (const d of ledger.dispatches.values()) {
      if (d.batchId !== b.batchId || d.voided || d.buyerId === null) continue;
      const party = ledger.parties.get(d.buyerId);
      const entry = recipients.get(d.buyerId) ?? {
        buyerId: d.buyerId,
        name: party?.name ?? d.buyerText,
        phone: party?.phone,
        address: party?.address,
        contactable: !!party?.phone,
        jars: ZERO(),
        dispatches: [],
      };
      entry.jars[b.status] += d.qty.value;
      entry.dispatches.push({
        dispatchId: d.dispatchId,
        batchId: d.batchId,
        jars: d.qty.value,
        at: d.at,
        status: b.status,
      });
      recipients.set(d.buyerId, entry);
    }
  }

  const of = (status: ImpactClass) => batches.filter((b) => b.status === status).map((b) => b.batchId);
  if (of("conditional").length > 0) {
    blockers.push({
      code: "conditional_batches",
      subject: of("conditional"),
      message: `${plural(of("conditional").length, "batch depends", "batches depend")} on unconfirmed links`,
    });
  }
  if (of("undetermined").length > 0) {
    blockers.push({
      code: "undetermined_batches",
      subject: of("undetermined"),
      message: `${plural(of("undetermined").length, "batch has", "batches have")} records that cannot rule this lot in or out`,
    });
  }
  const lots = flagged.map((id) => lotBalance(ledger, id, opts));
  for (const lot of lots) {
    if (!lot.withinTolerance) {
      blockers.push({
        code: "lot_unexplained",
        subject: [lot.lotId],
        message:
          lot.usesWithoutQuantity > 0
            ? `${plural(lot.usesWithoutQuantity, "use", "uses")} of this lot ${lot.usesWithoutQuantity === 1 ? "has" : "have"} no quantity`
            : lot.unexplainedMin === lot.unexplainedMax
              ? `${amount(lot.unexplainedMax, lot.unit)} of this lot is not explained by the records`
              : `Between ${amount(lot.unexplainedMin, lot.unit)} and ${amount(lot.unexplainedMax, lot.unit)} of this lot is not explained by the records`,
      });
    }
  }
  const unaccounted = batches.filter(
    (b) => b.status !== "no_recorded_link" && (b.balance.unaccounted === null || b.balance.unaccounted > 0),
  );
  if (unaccounted.length > 0) {
    blockers.push({
      code: "batch_unaccounted",
      subject: unaccounted.map((b) => b.batchId),
      message: `${plural(unaccountedJars, "jar has", "jars have")} no recorded destination`,
    });
  }
  if (unknownRecipientJars > 0) {
    blockers.push({
      code: "recipient_unknown",
      subject: [],
      message: `${unknownRecipientJars} dispatched jars went to a buyer the records do not identify`,
    });
  }
  const noContact = [...recipients.values()].filter((r) => !r.contactable);
  if (noContact.length > 0) {
    blockers.push({
      code: "recipient_no_contact",
      subject: noContact.map((r) => r.buyerId),
      message: `${plural(noContact.length, "recipient has", "recipients have")} no phone number on record`,
    });
  }
  const involved = new Set([...flagged, ...batches.filter((b) => b.status !== "no_recorded_link").map((b) => b.batchId)]);
  const contradictions = findContradictions(ledger, opts).filter((c) => c.subject.some((s) => involved.has(s)));
  if (contradictions.length > 0) {
    blockers.push({
      code: "contradiction",
      subject: contradictions.flatMap((c) => c.subject),
      message: `${plural(contradictions.length, "contradiction", "contradictions")} between records`,
    });
  }

  return {
    rev: ledger.rev,
    flagged: [...flagged],
    batches,
    recipients: [...recipients.values()].sort((a, b) => a.name.localeCompare(b.name)),
    lots,
    contradictions,
    jars,
    unknownRecipientJars,
    unaccountedJars,
    gaps,
    blockers,
    recipientListComplete: blockers.length === 0,
  };
}

/** Link ids still open anywhere in a report's conditions. */
export function openLinks(conditions: Dnf[]): Id[] {
  return [...new Set(conditions.flat(2))].sort();
}
