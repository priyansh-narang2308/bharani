import type { LedgerEvent, NewEvent } from "./types";

/** Assigns sequence numbers. The server store does the same inside a transaction. */
export function sequence(events: readonly NewEvent[], startAt = 0): LedgerEvent[] {
  return events.map((e, i) => ({ ...e, evidence: e.evidence ?? [], seq: startAt + i + 1 }) as LedgerEvent);
}
/** The log as it stood at a past revision. Corrections never erase history. */
export function asOf(events: readonly LedgerEvent[], rev: number): LedgerEvent[] {
  return events.filter((e) => e.seq <= rev);
}
