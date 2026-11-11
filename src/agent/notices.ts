import type { ImpactReport } from "@/core/impact";
import type { ImpactClass } from "@/core/lineage";
import type { Id, Ledger } from "@/core/types";
import { sha256 } from "@/server/store";

export interface NoticeDraft {
  id: Id;
  recipient: Id;
  recipientName: string;
  phone: string | null;
  worst: ImpactClass;
  facts: { batchCode: string; product: string; madeOn: string; jars: number; status: ImpactClass }[];
  body: string;
  bodyHash: string;
}

const WORDING: Record<ImpactClass, string> = {
  confirmed: "Records show these jars contain an ingredient lot under investigation.",
  conditional: "These jars may contain an ingredient lot under investigation. This is not yet confirmed.",
  undetermined: "Our records for these jars are incomplete, so we cannot yet rule them in or out.",
  no_recorded_link: "",
};

/** Notice text is built from recorded facts only. No model writes it, and it never says food is safe. */
export function draftNotices(ledger: Ledger, report: ImpactReport, brand: string, contact: string): NoticeDraft[] {
  const rank: ImpactClass[] = ["confirmed", "conditional", "undetermined"];
  return report.recipients.map((r) => {
    const facts = r.dispatches
      .filter((d) => d.status !== "no_recorded_link")
      .map((d) => {
        const b = ledger.batches.get(d.batchId);
        return {
          batchCode: b?.batchCode ?? d.batchId,
          product: (b && ledger.products.get(b.productId)?.name) ?? "product",
          madeOn: b?.madeOn ?? "",
          jars: d.jars,
          status: d.status,
        };
      });
    const worst = rank.find((s) => facts.some((f) => f.status === s)) ?? "undetermined";
    // Each line sits under the statement that is true for it, so no line is overstated.
    const groups = rank.flatMap((status) => {
      const lines = facts.filter((f) => f.status === status).map((f) => `- ${f.product}, batch ${f.batchCode}, made ${f.madeOn}: ${f.jars} jars`);
      return lines.length ? [WORDING[status], ...lines] : [];
    });
    const body = [
      `${brand}: please stop selling the jars below and keep them aside until we contact you.`,
      ...groups,
      `Questions: ${contact}. Reply OK when you have kept them aside.`,
    ].join("\n");
    const bodyHash = sha256(body);
    return { id: `ntc-${sha256(`${r.buyerId}\n${body}`).slice(0, 12)}`, recipient: r.buyerId, recipientName: r.name, phone: r.phone ?? null, worst, facts, body, bodyHash };
  });
}

/**
 * Fields the recall form asks for, filled from records. Anything the records
 * do not hold says so. A person enters this into FoSCoS; nothing is filed here.
 */
export function draftScheduleI(ledger: Ledger, report: ImpactReport, reason: string) {
  const unknown = "Not in records. Must be entered by the food business.";
  const affected = report.batches.filter((b) => b.status === "confirmed" || b.status === "conditional");
  return {
    note: "Draft for a person to review and enter. Not submitted anywhere.",
    identityOfFood: affected.map((b) => ({
      product: ledger.products.get(b.productId)?.name ?? b.productId,
      batch: b.batchCode ?? b.batchId,
      manufactured: b.madeOn,
      quantityMade: b.balance.made,
      status: b.status,
    })),
    reasonForRecall: reason,
    totalQuantityProduced: affected.reduce((n, b) => n + (b.balance.made ?? 0), 0),
    quantityDistributed: affected.reduce((n, b) => n + b.balance.dispatchedKnown + b.balance.dispatchedUnknownBuyer, 0),
    distributionListComplete: report.recipientListComplete ? "Complete against records held" : "Incomplete. See open blockers.",
    openBlockers: report.blockers.map((b) => b.message),
    fboNameAndAddress: unknown,
    fssaiLicence: unknown,
    testingDetails: unknown,
  };
}
