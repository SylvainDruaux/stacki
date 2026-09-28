# Editor-Core Handoff — for the developer taking over this workstream

**Status: handoff written 2026-09-18 at `7053ccf` on `refactor/architecture-consolidation`.**
Working tree clean. Read `docs/editor-core-prompts.md` and
`docs/editor-core-tracker.md` before touching anything.

## What this workstream is

Stacki's write path is being replaced: today the renderer mutates a cloned
model and re-serializes the whole file (`page:write` → `serializePage` →
`fs.writeFileSync`), which can overwrite external edits. The adopted plan
(`docs/stacki-editor-core-plan.md`) replaces that with a source-editing
engine: intents with expected-byte witnesses, span mapping through a diff,
a per-file document actor, atomic writes with checksum verification, and a
deterministic simulator as the arbiter. No code for it exists yet; the
artifacts and the executor workflow are committed.

## Artifacts (all committed in `7053ccf`)

| File | Role |
|---|---|
| `docs/stacki-editor-core-plan.md` | Normative design. §11 is the step sequence, §10 the simulator, §11.4 pre-registered thresholds. |
| `docs/editor-core-tracker.md` | Status per step + limits work + adapter-surface ratchet + open questions + verification record. |
| `docs/editor-core-prompts.md` | The executor workflow: PROMPT-0 (pre-flight) through PROMPT-9, then PROMPT-ALIGN. One prompt per session, in order. |
| `docs/migration-tracker.md`, `docs/codebase.md`, `docs/ts-migration-plan.md` | Updated cross-links; `docs/diff-mapping-editor-core.md` was deleted (merged into the plan). |

## Where the work stands

- **2026-09-28:** the plan was re-verified against the code at `6c2f1a2` and
  rewritten. New **step 0** ships a checksum guard and an atomic write on the
  legacy `page:*` path first, closing the live overwrite bug; steps 1–10
  (including diff-mapping) follow unchanged in intent. Corrections are
  listed in plan §13.
- Zero plan code. Steps 0–10 all ⬜ in the tracker. Run PROMPT-0A after
  PROMPT-0.
- The plan requires the determinism gate (no real timers in the simulator) and
  the hostile corpus (multi-span loop rename, kind-changing strip-bindings,
  multi-file CSS, frontmatter slots) from day one.
- Pre-registered thresholds: intent→applied p95 ≤ 50 ms; keystroke→disk p95
  ≤ 150 ms; zero wrong-site applications. These may not move between the
  spike and the step-4 decision without a written reason.

## Rules of the road

1. Order matters: run the prompts strictly sequentially, never in parallel —
   each step's contracts are the next step's input.
2. Every step ends with the full gate and a tracker update. AGENTS.md is
   normative; the gate command is `env -u ELECTRON_RUN_AS_NODE npm test`.
3. The adapter surface (hand-measured 2026-09-28: 67 direct node-mutation
   sites, 10 prop-index writes, 28 `mutateModel` + 4 `applyEdit` call sites)
   is a ratchet: scripted at step 1, down only from step 6.
4. Verify before claiming: record what you actually ran in the tracker's
   verification record, with the commit sha.

## First actions (PROMPT-0)

1. Re-verify the tracker's handoff facts.
2. Confirm `shared/dist/` is still absent (it was gone by 2026-09-28).
3. Resolve or record the `app-builder-lib` typing failure below, checking the
   tracker's latest verification record first.
4. Start step 0 (PROMPT-0A) only when the contract suite is green.

## Known environment facts (re-verified 2026-09-18 at `7053ccf`)

**Update 2026-09-28 at `6c2f1a2`:** the full gate passes (153/153) and
`shared/dist/` is gone; the two blockers below are historical.

- `npm run build:scripts` fails: `scripts/afterPack.ts` TS2307 on
  `app-builder-lib` (installed but extraneous — declared in no
  `package.json`). This blocks every `npm test` run. Fix: declare it a
  devDependency at the locked version — nothing else.
- `npm run test:contracts`: 159/160 while `shared/dist/` exists; the single
  failure is the build-layout gate. Expected to go fully green after the
  deletion above.
- Measured at `21efec2` (code unchanged since; the docs commit touched docs
  only): `npm run build:electron` passed; renderer-core 9/9; outside-edit
  13/13; self-writes 12/12.

## Gotchas already paid for

Live (pinned in `.ripwire_notes`, surface automatically):
- `scripts/afterPack.ts` — the `app-builder-lib` TS2307 trap above.
- `shared/tsconfig.json` — emits to `dist/shared`; `shared/dist/` is stale.
- `electron/preload.ts` — tsc emits 4-space indent and expands inline
  `{stmt}` blocks; text-slicing test regexes must stay whitespace-tolerant.
- `shared/scan.ts` — wire shape is the truth: `schema` travels as an array of
  `PropField`; Maps collapse under IPC serialization and reject every real
  payload.

Resolved — ignore the notes on `electron/astroParser.js` and
`electron/scratch2-7.js`: both belong to the completed TypeScript migration.

## Files to treat carefully

Hotspots measured at `21efec2` (churn × complexity): `EmbedEditor.tsx`
(ccx 1182, churn 16), `ClipPath.tsx` (ccx 3300), `App.tsx` (ccx 1451), and
`electron/astroParser.ts`'s `parsePropSchema` — the plan's step 6 and step 9
will touch around them. The spike's adapter count decides how invasive step 6
really is.

## Suggested next session for the recipient

1. Read this file, then `docs/editor-core-prompts.md` and the tracker.
2. Run PROMPT-0. It ends with a definition of done: clean tree, green
   contract suite, blockers resolved or recorded, step order named back.
3. Run PROMPT-1 and stop. Nothing else in the same session.