# Editor-Core Tracker — the consolidated editor-core plan, tracked item by item

Living status document for `docs/stacki-editor-core-plan.md`, the adopted,
consolidated plan. It supersedes `docs/diff-mapping-editor-core.md`, which is
removed from the tree; nothing in the old file that contradicts the new one
survives. Run the full gate (`npm test`) after every step, then update the
counts below. No item is "done" until its gate passes on the commit that
lands it.

## Handoff state (read this first)

- TypeScript migration complete (Phases 0–4). First tracker stamp: `v0.1.28`,
  HEAD `21efec2`. Current: `v0.1.34`, HEAD `b642efa` (2026-09-28, pre-flight).
- **Re-verified 2026-09-28 at `6c2f1a2` (v0.1.34).** The plan was rewritten
  against the code that day: new step 0 (overwrite guard), corrected facts
  in plan §13. Since `d515fcc`, commit `3686761` added `src/modelAdoption.ts`
  (positional id adoption across reparse — UI keying only, see plan §4).
- **Step 0 landed (2026-09-28); steps 1–10 have not started.** The legacy
  write path still serializes whole files (`mutateModel` → `page:write` →
  `serializePage`), but every page write now names the checksum it was
  authored against and main refuses a stale one with `conflict`; all page,
  chunk, style and property writes go through `electron/atomicWrite.ts`.
  Still legacy: watcher echo via `selfWrites`, the renderer rescan chain,
  saver acks by `WeakMap` object identity.
- **A partial precedent landed in the window (v0.1.29).**
  `electron/componentProperties.ts` validates a whole-file expected-source
  (`source.value !== request.source` → typed `conflict` rejection), then
  commits a multi-file batch through temp-file writes with mode preservation
  and rollback. This is a legacy-layer prototype of the plan's §3.4 witness
  and §5 atomic write — absorb it at step 9, and include the
  `component:editProperties` gesture in step-5 parity runs. Two write paths
  now exist (`page:*` and `component:editProperties`), and two new IPC
  channels arrived (`component:properties`, `component:editProperties`).
- Nothing of the new core exists as named modules: no `intent.ts`, `ref.ts`,
  `snapshot.ts`, `projection.ts`, `diff.ts`, `mapSpan.ts`, capability model,
  actor rejection enum, or bounded intent queue (verified by `rg`, 2026-09-18;
  re-verified at `b642efa`, 2026-09-28).
- What the plan builds on: the `shared/` contract parsers and bounds; the
  parser's internal source offsets (`electron/astroParser.ts` `start`/`end`);
  `serialQueue`, `selfWrites`, `projectWatcher`; `shared/limits.ts` plus
  `electron/main.bounds.ts` and `shared/component-properties.ts` (`PROPERTY_LIMITS`).
- The plan, tracker, prompt pack and cross-links are committed (`40817fb`,
  `b642efa`); step 0 starts from a clean docs tree.

## Steps

Gates are per the plan's implementation sequence (§11). Ratchet counters
(adapter surface) go down only; nothing grows a cap or retries forever.

### Step 0 — Overwrite guard on the legacy path ✅

**Deliverables.** SHA-256 `checksum` on `page:read` / `page:write` /
`page:writeRaw` results and `baseChecksum` on the write payloads; main
re-reads and returns a typed `conflict` on mismatch without writing;
`electron/atomicWrite.ts` extracted from `writePropertyFile`
(`electron/componentProperties.ts`) and used by page, chunk, style
re-write, and component-properties writes; renderer `SaveState` union
(`clean` | `dirty` | `saving` | `conflicted`) replacing `dirty?: boolean`, with
autosave off while `conflicted` and a notice that never discards input;
every page type covered (`.astro`, Markdown, MDX, raw); BOM detection and
preservation. Also (decided 2026-09-28): the watcher hot reload drops page
undo snapshots (today Undo after an external reload reverts the external
edit); `component:editProperties` rollback checks each file before restoring
and a read-back race becomes a `write-race` result, not an `assert`; `.md` /
`.mdx` fixtures with byte-exact round-trip tests.

**Gate proof.** Contract tests for good and bad checksum shapes; external
edit between read and write returns `conflict` with disk bytes unchanged
(`test/outside-edit.js`); failed atomic write leaves no temp file; BOM +
CRLF fixtures round-trip; every `SaveState` transition pinned; external
reload leaves no snapshot to undo into; externally changed batch file is
reported, not restored; markdown round-trips byte-exact; manual in-app
check recorded. Step 0 is also the
fallback if step 4 fails.

**Landed 2026-09-28** on `refactor/architecture-consolidation` (commit in the
verification record). Gate `env -u ELECTRON_RUN_AS_NODE npm test`: 153/153
test commands, 336.1 s, exit 0. Where each deliverable lives:

- Contract: `Digest` (`shared/brand.ts`), `digest` parser (`shared/boundary.ts`),
  `shared/page-save.ts` (`parsePageDiskRead`, `parsePageWriteResult`;
  `conflict` | `missing` | `filesystem` | `write-race`), payloads and results
  in `shared/ipc-payloads.ts` / `shared/ipc-results.ts`. Tests:
  `test/contracts/page-save.test.ts` (10 tests).
- Main: `checkPageBase` guard and BOM restore in `electron/main.ts`
  (`page:read` / `page:write` / `page:writeRaw`); `electron/atomicWrite.ts`
  (`wx` temp in the same directory, `fchmod` to the target's mode, fsync,
  rename, read-back → `write-race`, symlinks written through, strict UTF-8
  snapshot reads). Page, chunk, style re-write (now compares checksums) and
  property writes all use it. Tests: `test/atomic-write.test.js` (8 tests).
- Renderer: `src/saveState.ts` (`SaveState` union, pure transitions),
  `src/pagePersistence.ts` (saver names each write's base; a lineage step
  keeps it from conflicting with its own writes; `conflicted` stops autosave;
  explicit flushes — navigation, git, copy, close — fail loudly instead of
  discarding the edits), `src/panels/SaveConflictNotice.tsx`, watcher
  dirty-page branch surfaces the conflict, hot reload calls
  `dropPageHistory`. Tests: `test/save-state.test.js` (8, every transition
  and refused transition pinned), `test/renderer-core.test.js` saver cases,
  `test/page-navigation.test.js` App-level conflict flow.
- Property batch: checked rollback (restores only files still holding the
  batch's bytes, names the rest) and `write-race` instead of the read-back
  `assert` (`electron/componentProperties.ts`). Tests: two new cases in
  `test/component-properties.test.js`.
- BOM, Markdown, MDX: parsers read past a leading BOM; model writes restore
  it. `test/fixtures/round-trip/` (4 `.md`, 3 `.mdx`, 2 `.astro`: CRLF, BOM,
  lists, fences, setext, JSX blocks) round-trips byte for byte through
  `page:read` → `page:write`. The fixtures found a live bug, now fixed: a
  CRLF Markdown page with a multi-line frontmatter gained a CR per
  frontmatter line on every save (`serializeMarkdownPage` split on LF only).
- `test/outside-edit.js` gains the external-edit-while-dirty case (6 checks).

Deviations, with reasons: a new channel `page:serialize` (main handlers
114 → 115) — "Review in code" must show the unsaved local text, and an
editable page's `source` is the last text written, not the model; the
notice's accept action is "Save this version", shown once the code panel is
open (the plan's "accepts a merged text"). Left for later steps, by design:
chunk files are written atomically but not checksum-guarded (their own
actors, step 5); "Review in code" shows the local text only, not the disk
text beside it; there is still no flush on app quit (pre-existing).

### Step 1 — Contracts and simulator skeleton ⬜

**Deliverables.** `shared/intent.ts`, `shared/ref.ts`, `shared/snapshot.ts`,
the capability model, the rejection enum, the extended limits, and the
hostile fixture corpus. The parser emits attribute name and value spans
(today it has none: `shared/page-node.ts:12-16`), with a span-integrity
contract test on every corpus and large fixture. A deterministic generator
builds named large fixtures (about 25/50/100 % of `sourceBytesMax` and
`treeNodesMax`) for the step-4 thresholds. The deterministic
simulator skeleton lands with the determinism constraint (§10): the actor is
driven as pure steps by a deterministic scheduler — no real timers, no OS
async, disk I/O behind an interface the simulator fakes, a hand-rolled
seeded PRNG. New projection types take a name that cannot collide with
`shared/page-node.ts` (no `shared/projection.ts` exists; nothing to
rename). `scripts/adapter-surface.ts` joins the gate as a ratchet. A lint rule bans
whole-file regeneration calls (mechanically enforces the no-`toSource()`
invariant; today that means confining `serializePage` / `serializeNodes`
call sites to the writer boundary).

**Corpus gate.** The hard intent classes are in from day one, in the
simulator even where shipping is deferred: multi-span (loop rename),
kind-changing (`stripLostBindings`), multi-file (CSS write to a stylesheet),
frontmatter slot edits. Hostile fixtures target wrong-site mapping, not
anchor survival; oracle scenarios carry hand-derived expected splices.

**Gate proof.** Contract tests green; deterministic scheduler in place;
corpus diversity is a failed gate if it is thin, not a passed one.

### Step 2 — Diff and mapping ⬜

**Deliverables.** `diff.ts`, `mapSpan.ts`, `set-attribute` only.

**Gate proof.** Ambiguity resolves to a typed rejection, never a fallback to
"the third matching node"; a missing node is a rejection, never a guess.

### Step 3 — Spike ⬜

**Deliverables.** Intent → map → witness-check → splice → reparse →
reproject against the simulator's seeded scenarios. Record mapping
correctness, reproject-plus-diff latency, and the **adapter surface** from
`scripts/adapter-surface.ts` (step 1). Hand-measured baseline 2026-09-28:
67 direct mutation sites, 10 prop-index writes, 28 `mutateModel` and 4
`applyEdit` call sites. The keystroke→disk threshold is reconciled with the
300 ms typing save delay before the spike starts.

**Gate proof.** Results published against the pre-registered numbers (§11.4,
see Thresholds below). The numbers may not change between the spike and the
step-4 decision without a written reason.

### Step 4 — Threshold decision ⬜

**Deliverables.** A recorded decision, not code.

**Gate proof.** Zero wrong-site applications across the corpus; adapter
count recorded; intent→applied and last keystroke→disk within the
Thresholds below. Fail → report; step 0's guarded
legacy path remains the shipped write path.

### Step 5 — Actor and write protocol ⬜

**Deliverables.** Bounded intent queue, per-intent typed outcomes
(`accepted` / `backpressured`; terminal `applied` / `rejected` /
`uncertain`), expected-bytes witnesses, atomic write (temp file in the same
directory, flush, atomic replace), re-read-and-verify, new snapshot commit.
**Single writer:** the legacy save path submits the migration-only
`ReplaceSource` intent through the actor; one actor per chunk file (plan
§3.3, §5.2). Platform integration suite against real filesystems — the simulator cannot
test the real write protocol. Single-gesture parallel run with parity checks
against the legacy path.

**Gate proof.** Nine simulator invariants hold (§10); the platform suite
covers temp-file permissions/ownership, flush semantics, directory
durability, Windows replacement semantics, symlinks, writer interference,
and the crash-between-replace-and-verify reconciliation that produces
`uncertain`. The OS-facing contract is pinned: what "flush" means, how mode
and metadata are preserved, symlink policy, canonical paths on
case-insensitive filesystems. `component:editProperties` runs through the
actors as a batch, acquired in sorted canonical-path order.

### Step 6 — Gesture expansion ⬜

**Deliverables.** Single-file operations ship in order: attribute → prop →
insert/remove → move → inline CSS → frontmatter slots. Stylesheet intents
(multi-file) follow the §3.3 outcome-gated composition rule once a real
gesture needs them. New features enter through intents only. Undo on the
engine: each `applied` outcome records inverse splices; Undo submits them as
an intent against the post-apply checksum; `LIMITS.undoEntriesMax` (100)
bounds the stack. The property batch gains an inverse batch.

**Gate proof.** Adapter surface shrinks monotonically. Undo after an
external edit maps through the diff or rejects — never reverts the external
change (simulator scenario).

### Step 7 — Capabilities and preview bridge ⬜

**Deliverables.** Read-only fallbacks visible, never silent; dev-only source
markers injected in memory; the preview token (digest over the sorted
dependency manifest of the rendering chain); stale-token rejection;
morph-without-reload from a projection diff, capped by a limit, honest
reload past the cap.

**Gate proof.** A preview event is accepted only if the source file and
dependency state that produced it are still current; no marker that could
change observable project behavior is ever written into the project.

### Step 8 — Code editor on the actor ⬜

**Deliverables.** Diff-based patches through the same actor; `parse-error`
projections persist invalid intermediates; overlapping external changes
surface a visible `merge-conflict`, never an overwrite; visual intents
reject with `source-invalid` while the file stays broken, and visual editing
resumes automatically once it parses again.

### Step 9 — Deletion ⬜

**Deliverables.** Compat adapter, legacy mutable tree
(`shared/editor-model.ts`), `WeakMap` acks (`src/pagePersistence.ts`),
version counters, `n<N>` parser ids and `c<N>` renderer ids,
`src/modelAdoption.ts`, `PageSnapshot` and the snapshot branch of
`AppHistory`, `ReplaceSource` for `.astro` (Markdown and MDX keep it until
step 10) — plus three special cases the actor dissolves:

- `electron/selfWrites.ts` — the actor's own write is a watcher tick whose
  read matches the committed checksum; the suppression machinery evaporates.
- `LIMITS.saveDrainMax` — the bounded queue replaces drain semantics.
- `LIMITS.rescanChainMax` — one read plus one parse per tick removes the
  chain.

**End state.** Snapshots, projections, intents, splices. The file on disk is
the only persisted state.

### Step 10 — Markdown and MDX on the engine ⬜

**Deliverables.** Spans with the span-integrity property in
`electron/markdownParser.ts`; markdown gestures as intents; `ReplaceSource`
and `serializeMarkdownPage` retired as write paths.

**Gate proof.** Same simulator and gate rules as steps 1–6, run against the
step-0 markdown fixtures.

## Thresholds (pre-registered, §11.4)

- Intent → applied p95 ≤ 50 ms on the named large fixtures (the engine).
- Last keystroke → disk p95 ≤ 350 ms on the same fixtures: 300 ms typing
  batch + 50 ms engine. Re-registered 2026-09-28 from ≤ 150 ms. Reason: the
  batch exists because every save costs the preview a server re-render,
  fetch, and DOM diff (`src/App.tsx:1498-1507`); it is persistence-layer
  policy, not engine cost (plan §7).
- Zero wrong-site applications across the corpus.

Published before the spike; may not move between the spike and the step-4
decision; revising them later requires a written reason.

## Limits work (§8)

Every bound lives in `shared/limits.ts`. Existing and usable:
`treeNodesMax`, `treeDepthMax`, `tagNameCharsMax`, `attrCharsMax`,
`attrsPerNodeMax`, `nodeValueCharsMax`, `scanEntriesMax`, `propSchema*`,
`importsMax`, `ipcFieldCharsMax`; `electron/main.bounds.ts` adds
`sourceBytesMax` and friends at the electron layer.

To add at step 1: max file bytes (merge up from `MAIN_LIMITS.sourceBytesMax`),
max projection nodes, max nesting depth, max pending intents, max intent
payload bytes, max diff work, max parse tasks in flight, max retained
snapshots, max watcher work per tick, max preview markers; at step 6,
`undoEntriesMax` (100, today's `AppHistory` cap). Exceeding a limit
returns `resource-limit` or `queue-full` — the system never grows a drain
cap, retries forever, or reduces fidelity to cope.

## Adapter surface (ratchet, scripted at step 1)

| Point | Count | State |
|---|---|---|
| Direct node-mutation sites in `src/` | 67 (47 in `App.tsx`) | hand-measured 2026-09-28 |
| Prop-index writes | 10 | hand-measured 2026-09-28 |
| `mutateModel(` call sites | 28 | hand-measured 2026-09-28 |
| `applyEdit(` call sites | 4 | hand-measured 2026-09-28 |

Method (to be encoded in `scripts/adapter-surface.ts`): grep `src/**/*.ts{,x}`
excluding `src/style-panel/` for field assignments, array mutators and
`delete` on node fields (`props`, `children`, `attrOrder`, `attrSource`,
`kind`, `name`, `value`, `id`, `dynamicTag`, `slots`, `body`, `test`,
`nodes`, `mdRaw`, `mdSource`), plus aliased-list mutators. The earlier
~123 + ~15 estimate likely counted wrapper call sites. From step 6 the
count goes down only.

## Open questions

Carried from the removed diff-mapping plan; resolved or still open per the
consolidated plan:

- **Threshold timing** — resolved: pre-registered at §11.4, decided at step 4.
- **`lastKnownBytes` chaining** — addressed by design: the actor commits a
  new snapshot per applied intent (§5.10); pending intents carry compact
  authored preconditions (§3.1). Confirm the interleaving behavior in the
  step-5 simulator runs.
- **Undo semantics** — resolved 2026-09-28: drop page snapshots on external
  reload at step 0; inverse splices submitted as intents at step 6; snapshot
  history deleted at step 9.
- **Keystroke → disk threshold** — resolved 2026-09-28: split into engine
  (≤ 50 ms) and last keystroke → disk (≤ 350 ms); see Thresholds.
- **Morph move-blindness** — partially addressed: morph-without-reload from
  a projection diff capped by a limit, honest reload past the cap (§9).
  Confirm the moved-node case at steps 6–7.
- **`component:editProperties`** — resolved 2026-09-28: hardened batch
  (checked rollback and `write-race` at step 0; actors in sorted path order
  at step 5; inverse batch at step 6). Best-effort rollback goes in product
  requirements.
- **Markdown and MDX** — resolved 2026-09-28: guarded and round-trip tested
  at step 0; on the engine at step 10.

## Telemetry (§9a)

One counter and one structured log line in production: rejection counts by
reason, emitted with the intent id and a hashed or redacted file path. No
source bytes ever enter logs. No metrics pipeline, no dashboard, no new
dependency. The rejection distribution is the production signal for
everything the corpus cannot cover.

## Verification record

Factual record of checks run while building this tracker (first entry —
update on every step):

- 2026-09-17, HEAD `21efec2` + untracked plan:
  - `npm run build:electron` — pass (tsc, morph, preload, stage-runtime).
  - `node test/renderer-core.test.js` — 9/9 pass.
  - `node test/outside-edit.js` — 13/13 pass.
  - `node test/self-writes.js` — 12/12 pass.
  - `npm run test:contracts` — 159/160. The one failure is the build-layout
    gate flagging `shared/dist/` as generated output inside an authored
    tree: a stale artifact from an earlier compiler config (`shared/tsconfig.json`
    now emits to `dist/shared`; `shared/dist` is gitignored). Delete
    `shared/dist` before the step-1 commit.
  - `npm test` — blocked before the gate: `scripts/afterPack.ts` fails tsc
    with TS2307 on `app-builder-lib` (module present in this node_modules but
    extraneous — not declared in `package.json`). Environment/tooling issue,
    unrelated to the plan; record when fixed. Persists at `d515fcc` (v0.1.30),
    where `afterPack.ts` also grew an `builder-util` import.
- 2026-09-18, HEAD `d515fcc` (v0.1.30), after the 24h window advanced
  `21efec2 → d515fcc` (dropdown loop fix, windows hardening, component
  property management, v0.1.29/v0.1.30 releases):
  - Re-verified the contract suite after rebuilding `dist/electron` for the
    new channels: **161/162 pass**, sole failure the known build-layout
    `shared/dist` stale-artifact flag (unchanged).
  - The window added `component:properties` and `component:editProperties`;
    main-channel count is now **113** (+2), total invoke channels **117**
    (contract test asserts `harness.handlers.size === 113`).
  - New write path and limits home verified and folded into Handoff state
    above (`electron/componentProperties.ts`, `shared/component-properties.ts`).
  - `npm run build:scripts` still fails on `app-builder-lib`/`builder-util`
    TS2307. Blocker unchanged by the window.
- 2026-09-28, HEAD `6c2f1a2` (v0.1.34), plan rewrite (docs only):
  - `env -u ELECTRON_RUN_AS_NODE npm test` — **pass, 153/153 test commands
    in 341.9 s, exit 0.** The `app-builder-lib` blocker no longer reproduces;
    `shared/dist/` is absent.
  - Plan facts re-verified by reading the cited `file:line`s (plan §13).
    Adapter surface hand-measured (table above).
  - Same day, after reviewing an external architecture chat (Doom, database
    and SpacetimeDB techniques): spatial and B-tree indexes rejected (plan
    §12); plan amended for the step-5 two-writer hole (`ReplaceSource`), the
    step-0 `SaveState` union, multi-file writes, Markdown/MDX scope, large
    fixtures, parser decision, pure planner, brute-force oracle rule. Checked
    `electron/preload.ts:1524` (hit-testing via `elementFromPoint`) and corpus
    sizes (max 2.7 KB). Docs only; no gate re-run.
  - Same day, open decisions settled with the owner (plan §14): latency
    split, hardened property batch, undo as inverse splices, Markdown at
    step 10. Found and scheduled into step 0: undo reverting external edits
    after a watcher reload (`src/App.tsx:1600-1671` lacks `dropPageHistory`),
    blind batch rollback and assert-on-race
    (`electron/componentProperties.ts:249,253-276`), missing markdown
    round-trip tests. Docs only.
- 2026-09-28, HEAD `b642efa` (v0.1.34), PROMPT-0 pre-flight (no source change):
  - Handoff facts re-verified: no `shared/{intent,ref,snapshot,projection,
    diff,mapSpan}.ts` and no such module anywhere in the tree; no capability
    model, rejection enum or intent queue. The legacy path is present:
    `WeakMap` acks (`src/pagePersistence.ts:33`), `serializePage` in
    `page:write` (`electron/main.ts:3067-3076`, direct write via
    `writePageText`), `electron/selfWrites.ts`, `LIMITS.rescanChainMax`
    (`shared/limits.ts:31`, used at `src/App.tsx:816`), the dirty-page
    watcher drop (`src/App.tsx:1636`), and `writePropertyFile`
    (`electron/componentProperties.ts:309-328`). One stale fact fixed: the
    plan revision was already committed in `b642efa`.
  - `shared/dist/` absent. `npm run test:contracts` — **163/163 pass**;
    build-layout suite 3/3 (`all compiler output lives under dist` green).
  - `app-builder-lib` TS2307: **does not reproduce.** `npm run build:scripts`
    exits 0; `npm ls` shows `app-builder-lib@25.1.8` and `builder-util@25.1.7`
    under the declared devDependency `electron-builder@25.1.8`, zero
    extraneous packages. The lockfile held the same versions at `21efec2` and
    `d515fcc`, so the 2026-09-17/18 failure was local `node_modules` drift
    (the "extraneous" report means the tree no longer required the package),
    not a manifest defect. No `package.json` or lockfile change. Latent risk
    left open: `scripts/afterPack.ts:6-7` imports both packages without
    declaring them, relying on npm hoisting; if it recurs, declare them as
    exact devDependencies pinned to the `electron-builder` versions.
- 2026-09-28, step 0 (PROMPT-0A), on top of `1172b31`:
  - `env -u ELECTRON_RUN_AS_NODE npm test` — **pass, 153/153 test commands in
    336.1 s, exit 0** (static gates: tsc, eslint 0 errors, ratchet 0).
  - `npm run test:contracts` includes `page-save.test.ts` (10/10) and the
    channel inventory at 115 main handlers.
  - In-app check on the real Electron app (WSLg display), driven over the
    Chrome DevTools protocol from a throwaway script rather than by hand:
    scratch project open on `index.astro`, code panel focused, text typed in
    the app and the same file written by an outside process in the same tick.
    Result: the notice "index.astro changed on disk while you were editing"
    appeared; the file kept the outside bytes (sha256 unchanged after more
    typing, local text never written); "Reload from disk" showed the outside
    version and cleared the notice; the next edit saved normally; no
    `.stacki-write-*` file remained. Screenshot evidence was inspected, not
    committed.

## How to work this tracker

The executor's workflow lives in `docs/editor-core-prompts.md` — one prompt
per step, PROMPT-0 first, PROMPT-ALIGN last. This tracker is the audit trail
the prompts update.

Update the step rows as work lands, always with the gate evidence and the
test counts at the commit that did it. Keep the plan document as the
normative design; this tracker answers "where are we", the migration-tracker
answers "how the TypeScript conversion closed", and `docs/codebase.md` stays
the architecture overview. Standing rules unchanged: AGENTS.md normative,
gate green per step, behavior preservation proven by parity, verify before
claiming, zero new dependencies without a written justification, improve
only touched code.