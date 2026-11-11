# Bharani

**Recall traceability for small food makers that says what the records show, what they cannot show, and who to ask next.**

When a supplier flags an ingredient lot, Bharani finds every batch and buyer it may have reached. It never calls anything "safe". Each batch and jar lands in one of four classes:

| Class | Meaning |
|---|---|
| Confirmed | A chain of confirmed links reaches the flagged lot |
| Conditional | It reaches the lot only if named, unconfirmed links are true |
| Undetermined | The records cannot rule the lot in or out |
| No recorded link | The records show no path. This is not proof of safety |

Kitchens log batches by speaking in Hindi, English or both. A deterministic engine decides lineage, and a person approves anything that leaves the building.

Built for Tech4Bharat 2026. All businesses, people and lots in the demo are fictional. Bharani is not a certified regulatory compliance system.

## Links

- Product and engineering blueprint (Parts A–K): https://claude.ai/artifact/SH9mvNS9s1496mSrZA1T4R
- Figma design (tokens, components, 8 screens, 2 prototype flows): https://www.figma.com/design/uZmx4WTZ8ksjuw04Wlhrh3
- Measured results: [`eval/results/`](eval/results)

## Run it

Requires Node 22 or later.

```bash
npm install
npm test          # 47 tests
npm run build && npm start   # http://localhost:3100
```

The app seeds a demo scenario with a flagged chilli powder lot (RT-0925) and three kitchens. Data is stored in embedded Postgres under `.data/`; the Reset button restores the scenario.

Optional model-based note reading:

```bash
export ANTHROPIC_API_KEY=...        # never commit this
BHARANI_EXTRACTOR=model npm start   # BHARANI_MODEL overrides the default model
npm run live-check                  # one live call to verify the key
```

## How it works

| Layer | What it does | Code |
|---|---|---|
| Ledger | Append-only events; the projection is a pure function of the log; corrections add events; any past revision can be replayed | `src/core/ledger.ts`, `src/core/log.ts` |
| Lineage | Each batch's condition is a minimal monotone formula over unconfirmed links; supports intermediate batches (e.g. a masala mix); cycles reported | `src/core/lineage.ts` |
| Balance | Mass balance per lot and batch; contradictions; blockers that stop a "complete list" claim | `src/core/balance.ts`, `src/core/impact.ts` |
| Questions | Replays every possible answer and ranks questions by jars settled | `src/core/questions.ts` |
| Extraction | Rule reader or Claude structured output → grounding (drops anything not in the note) → proposed links only | `src/extract/` |
| Agent | Allowlisted tools; humans alone approve and close; approvals bound to payload hash; idempotent outbox; stale-notice redraft; **simulated** gateway | `src/agent/` |
| App | Next.js: Investigation, Kitchen voice log, Lineage explorer, Audit trail | `src/app/` |

## Results (synthetic data only)

From `npm run eval`, 197 synthetic businesses with hidden ground truth:

| Method | Affected batches found | Batch precision | Claims a complete list when it is not | Wrong links auto-accepted |
|---|---|---|---|---|
| Spreadsheet of confirmed links | 0.404 | 1.0 | 0.99 | 0 |
| Batch system (confirmed only) | 0.421 | 1.0 | 0.98 | 0 |
| Auto-accept best guess | 0.953 | 0.669 | 0.706 | 0.264 |
| **Bharani** | **1.0** | 0.446 | **0** | **0** |

Ten ranked questions lift Bharani's precision from 0.447 to 0.58. Rule-based extraction scores 0.887 input recall on the 20 dev notes it was tuned on and 0.679 on a 12-note holdout.

## Known limits

- No real kitchen, customer or interview data yet.
- The Claude reader has not been measured.
- Notices go through a simulated gateway; no real SMS or WhatsApp is sent.
- Offline capture is designed in Figma, not built.
