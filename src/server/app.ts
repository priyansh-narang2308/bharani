import { mkdirSync, rmSync } from "node:fs";
import { SimulatedGateway } from "@/agent/gateway";
import { openInvestigation, RUNTIME_DEFAULTS, ToolRuntime } from "@/agent/runtime";
import { DEMO_REASON, FLAGGED_LOT, scenario } from "@/demo/scenario";
import { ClaudeExtractor } from "@/extract/claude";
import { RuleExtractor } from "@/extract/rules";
import type { Extractor } from "@/extract/schema";
import { openDb, type Db } from "./db";
import { EventStore } from "./store";

export const INVESTIGATION = "inv-demo";
const DATA = process.env.BHARANI_DATA ?? ".data/pg";

export interface App {
  db: Db;
  gateway: SimulatedGateway;
  runtime: ToolRuntime;
  extractor: Extractor;
}

const g = globalThis as unknown as { __bharani?: Promise<App> };

async function boot(): Promise<App> {
  mkdirSync(DATA, { recursive: true });
  const db = await openDb(DATA);
  const store = new EventStore(db);
  if ((await store.all()).length === 0) {
    await store.append(scenario());
    await openInvestigation(db, INVESTIGATION, [FLAGGED_LOT], DEMO_REASON, "coord-asha");
  }
  const gateway = new SimulatedGateway();
  const runtime = new ToolRuntime(db, gateway, { ...RUNTIME_DEFAULTS, brand: "Sakhi Pickles (demo)", contact: "Asha, +91-90000-00001" });
  const extractor: Extractor = process.env.BHARANI_EXTRACTOR === "model" ? new ClaudeExtractor() : new RuleExtractor();
  return { db, gateway, runtime, extractor };
}

export function app(): Promise<App> {
  g.__bharani ??= boot();
  return g.__bharani;
}

/** Wipes the demo database and reseeds it. */
export async function reset() {
  const current = g.__bharani ? await g.__bharani : null;
  await current?.db.close();
  g.__bharani = undefined;
  rmSync(DATA, { recursive: true, force: true });
  return app();
}
