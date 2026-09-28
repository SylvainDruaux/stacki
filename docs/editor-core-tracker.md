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
- **Steps 1 and 2 landed (2026-09-28); steps 3–10 have not started.** The
  contract layer, parser spans, hostile corpus, large fixtures, simulator
  skeleton, adapter ratchet and lint fences exist (Step 1), and so do the byte
  diff, the span mapper and the pure `set-attribute` planner (Step 2); nothing
  in the app submits intents yet.
- **Step 0 landed (2026-09-28).** The legacy
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
- Since step 1: `shared/intent.ts`, `ref.ts`, `snapshot.ts`, `span.ts`,
  `capability.ts` and `source-projection.ts` exist; since step 2, `diff.ts`,
  `mapSpan.ts` and `planner.ts`. The shipping actor and its bounded queue do
  not (the simulator's step-wise actor in `test/simulator/actor.ts` is the
  reference the step-5 actor must match); the simulator still plans with the
  step-1 reference planner — wiring the step-2 planner in is step 3.
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

**Landed 2026-09-28** on `refactor/architecture-consolidation` in `d10e9c5`. Gate `env -u ELECTRON_RUN_AS_NODE npm test`: 153/153
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

### Step 1 — Contracts and simulator skeleton ✅

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

**Landed 2026-09-28** on `refactor/architecture-consolidation` in `2be1fb3`.
Gate `env -u ELECTRON_RUN_AS_NODE npm test`: 154/154
test commands, 200.0 s, exit 0 (static gates: tsc, eslint 0 errors, `ratchet-check` 0,
`adapter-surface` at baseline). Where each deliverable lives:

- Contracts (`shared/`): `span.ts` (`ByteSpan`, `Utf16Span`, `ByteString`,
  the single conversion `utf16ToByteOffsets`, strict `decodeUtf8`); brands
  `ByteOffset`, `Utf16Offset`, `IntentId` (`brand.ts`); `ref.ts` (`AnchorRef` =
  byte span + structural path + expected kind; `NODE_KINDS` compile-checked
  against `PageNode['kind']`); `intent.ts` (nine operations incl. migration-only
  `replace-source`, `SubmissionResult`, `Outcome`, nine `REJECTION_REASONS`
  with notice text, anchor/operation pairing, multi-span site rules, UTF-8
  payload bound); `capability.ts`; `source-projection.ts` (`Projection` =
  `valid` | `parse-error`, byte spans, paths, per-node and per-attribute
  capability); `snapshot.ts` (checksum computed from the bytes, no version).
  Limits: `sourceBytesMax` merged up from `MAIN_LIMITS`; added
  `intentsPendingMax` 64, `intentPayloadBytesMax` 10 MB, `splicesPerIntentMax`
  4 096, `diffWorkMax` 5·10⁷, `parseTasksInFlightMax` 2, `snapshotsRetainedMax`
  2, `watcherFilesPerTickMax` 1 024, `previewMarkersMax` 20 000,
  `diagnosticsMax` 64, `diagnosticCharsMax` 4 096. Projection nodes and depth
  reuse `treeNodesMax` / `treeDepthMax` (one name, one meaning).
- Parser spans: `electron/astroParser.ts` emits `attrSpans` (whole, name,
  value; one regex scan with match indices feeds both props and spans) and
  now places branch nodes, else-if conditions and inline-run gap spaces, which
  had no offsets. `shared/page-node.ts` validates the spans against the node
  range and the props record. Tests: `test/contracts/span-integrity.test.ts`
  (50 corpus/round-trip/editor-core files, 350 nodes, 152 attribute spans,
  UTF-16 and byte slices; plus all six large fixtures), `page-node.test.ts`
  (15 malformed `attrSpans` shapes), `span.test.ts` (conversion vs a
  brute-force `Buffer.byteLength` reference at every offset).
- Hostile corpus: `test/fixtures/editor-core/` — loop rename (multi-span, with
  a shadowing second loop and substring decoys), strip bindings
  (kind-changing move out of a loop), page + stylesheet (multi-file,
  outcome-gated), frontmatter slot, identical siblings (wrong-site), BOM + CRLF
  + astral text (encoding), conditionals with duplicate attributes and
  `set:html`, inline-run gaps, a malformed page — each with a hand-written
  `*.expected.*`. `test/simulator/oracles.ts` holds the hand-derived byte
  splices; `oracles.test.ts` checks witnesses, exact results, post-kinds, and
  that the reference planner reproduces every splice it plans exactly (the
  move is pinned as `unsupported-operation` until step 6).
- Large fixtures: `scripts/large-fixtures.ts` builds `nodes-25/50/100`
  (5 000 / 10 000 / 20 000 nodes; 176 648 / 355 403 / 712 786 bytes) and
  `bytes-25/50/100` (2 621 440 / 5 242 880 / 10 485 760 bytes; 3 490 nodes)
  from corpus pieces, deterministically; `test/fixtures/large/manifest.json`
  pins sizes and SHA-256; `npm run fixtures:large` writes the files
  (gitignored, 17.5 MB).
- Simulator: `test/simulator/` — xoshiro128** PRNG (pinned stream), fake disk
  with write generations, identity-mapping reference planner, step-wise actor
  (idle → planned → written, §5.2 steps 1–10), twelve event kinds (visual,
  stale preview, oracle gesture, code save, manual edit, AI rewrite, git
  replace, watcher tick, actor step, crash, write failure, backpressure
  burst), invariants 1–8 checked from outside after every event, invariant 9
  by running each seed twice. Gate: 24 seeds × 400 steps; the seeds must reach
  12 outcome classes or the suite fails. Long run:
  `STACKI_SIMULATOR_SEEDS=400` — 400 seeds, 27.6 s, green.
- Ratchet: `scripts/adapter-surface.ts` in the gate's static checks, method in
  its header, unit-tested in `test/contracts/adapter-surface.test.ts`.
- Lint: `serializePage` / `serializeNodes` / `serializeMarkdownPage` may be
  imported or called only in `electron/astroParser.ts`, `main.ts`,
  `markdownParser.ts`, `componentFile.ts` and tests; `test/simulator/**`
  (entry points excepted) and the six engine contract modules may not use
  timers, `Date`, `performance`, `process`, promises, async, `Math.random` or
  I/O modules. Both fences were checked against probe files.

Found by step 1 and fixed:

- `parseProps` (`shared/page-node.ts`) assigned `out[name]`, so an attribute
  named `__proto__` hit the inherited setter and vanished at the IPC boundary;
  the attrSpans cross-check caught it on `test/corpus/prototype-attribute.astro`.
- Branch nodes, else-if conditions and inline-run gap spaces had no source
  offsets; the gap case reached the simulator only through an external edit.
- The simulator's first run found a planner bug class: a new attribute value
  containing its own quote re-parses as a different tree. The reference
  planner now refuses it (`unsupported-operation`); step 6 owns re-quoting.

Found and left open (outside step 1): the wire parser drops `source` on
`text` and `cond` nodes (`parseByKind`, `shared/page-node.ts`), so a model that
crosses `parsePageReadResult` serializes a hand-wrapped paragraph onto one line,
`&copy;` as `©`, and `{x && <p/>}` reflowed. Reproduced with
`serializePage(parsePageResult(parsePage(src)).model)`; not yet confirmed
through the app's save path. Whole-file regeneration is the legacy path until
step 9, so this matters now.

Deviations, with reasons: the actor, planner and splice primitive live in the
test tree as step-1 references, not in `shared/` or `electron/` — steps 2–5
design the shipping ones and must pass the same invariants; the large fixture
files are generated, not committed (the manifest pins them); adapter counts
are the script's (70 / 9 / 28 / 4), not the hand count (67 / 10 / 28 / 4) —
see the table below.

### Step 2 — Diff and mapping ✅

**Deliverables.** `diff.ts`, `mapSpan.ts`, `set-attribute` only.

**Gate proof.** Ambiguity resolves to a typed rejection, never a fallback to
"the third matching node"; a missing node is a rejection, never a guess.

**Landed 2026-09-28** on `refactor/architecture-consolidation` in `4eb4815`.
Gate `env -u ELECTRON_RUN_AS_NODE npm
test`: 154/154 test commands, 229.6 s, exit 0. Where each deliverable lives:

- Line-diff evaluation (plan §11 step 2): `electron/conflicts.ts:54` does not
  generalize — it fills an n·m table and, past 250 000 cells, silently returns
  the region whole. Replaced for this purpose, not reused.
- `shared/diff.ts`: Myers' O(ND) byte diff, run forward and over the reversed
  bytes, keeping every frontier row, so `distanceBefore(x, y)` /
  `distanceAfter(x, y)` give exact prefix and suffix edit distances at any grid
  point (binary search over rows, O(log D)); `diffHunks` prints one minimum
  script. Budget at the entry point: `LIMITS.diffWorkMax` (now defined: one
  unit per byte comparison or frontier cell) and the new
  `LIMITS.diffDistanceMax` 2 048 (frontier memory 2·(D + 1)² cells, ≈ 34 MB at
  the bound; a size change past it is refused without searching). Exhaustion is
  `too-costly`, never a partial diff. No recursion.
- `shared/mapSpan.ts`: `resolved` only when **every** minimum edit script keeps
  the span whole at the same place; `gone` when none keeps it whole;
  `ambiguous` otherwise; `too-costly` on the budget. Decided exactly from two
  columns (the span's first and last byte, via the distance sums) — a proof in
  the module header, and the brute-force reference
  `test/simulator/reference-diff.ts` checks every column instead.
- `shared/planner.ts`: `Splice`, `Plan` (moved from the simulator, which now
  imports them), and the pure `planIntent({ authored, current }, intent)` →
  `Result<Plan, RejectionReason>`. `set-attribute` resolves the anchor in the
  authored bytes, maps the element's **name-through-last-attribute** region
  (`Hero title="Old"`) through the diff, re-finds the node there in the current
  projection, and splices the mapped value with the authored value as its
  witness. `ambiguous` → `anchor-ambiguous`, `gone` → `anchor-moved`,
  `too-costly` → `resource-limit`; every other operation is
  `unsupported-operation` until its step. Equal checksums skip the diff (the
  fast path); `planIntentThroughDiff` is its reference.
- Tests (`test/simulator/`, in `test:simulator`): `diff.test.ts` (6: exact
  distances at every grid point and valid hunks vs full DP tables on 1 500
  seeded inputs, edge cases, each budget at / under / past its bound, pinned
  assertion messages, a 1 MB file); `map-span.test.ts` (9: fast vs reference on
  every span of 2 000 seeded inputs, each outcome > 1 000 times; pinned
  hand-derived ranges for hero/footer sharing `title="Old"`, identical
  siblings, moved and duplicated blocks, edits around and inside the span, a
  wrapped and re-indented page); `planner.test.ts` (8: the three set-attribute
  oracles exactly, through both paths and the step-1 reference; the wrong-site
  fixture against hand-edited current files with hand-written expected output
  and offsets; every rejection reason; a sweep of 49 `.astro` fixtures where
  all 81 planned attributes agree across fast path, reference and diff path,
  and re-plan at exactly the shifted range after an insertion above). Type
  level: `editor-core-types.test.ts` gains 6 `@ts-expect-error` checks (no span
  on a non-resolved mapping, no diff on `too-costly`, private frontiers,
  immutable diff and plan, planning needs the authored snapshot).

Found by step 2 and settled in the design:

- Mapping the whole opening tag is too strict: every tag starts with `<`, so
  inserting `<div>` before `<Hero` ties a script that matches Hero's `<` to the
  div's, and the tag is `ambiguous`. The planner maps the name through the last
  attribute instead; the `<div>` case is pinned both ways in `map-span.test.ts`.
  Loosening the mapper's rule instead ("one place keeps it whole") would map
  both of two identical cards onto the survivor after one is deleted — the
  wrong-site case the rule exists for.
- Byte-level conservatism the simulator must judge (plan §14), pinned as
  rejections: a near-copy block inserted above the target (other text or
  class), a heading that spells the target's tag name (`<h1>Cards</h1>` above
  `<Card`), and an attribute appended after the target's last attribute
  (`anchor-ambiguous`); any external edit inside the region (`anchor-moved`).

Handed to step 3:

- **The planner needs the authored snapshot** (`PlanningBase.authored`), not
  only the current one — the §4 resolution function takes last-known bytes.
  Which snapshots the actor retains for pending intents is the open
  `lastKnownBytes` chaining question below; `snapshotsRetainedMax` (2) may not
  cover an intent authored two commits back.
- **Diff latency on the largest fixture.** Measured by hand with a throwaway
  script (not committed): a small edit in a 1 MB page diffs in ≈ 12 ms, in a
  10 MB page in ≈ 90–115 ms (both directions scan the whole file once). Only a
  stale intent pays it — equal checksums skip the diff — but the step-4
  intent→applied p95 (≤ 50 ms) is measured on the large fixtures, so step 3
  must report it. A search that exhausts `diffDistanceMax` costs ≈ 150–250 ms
  before rejecting. Plan §12's cached-diff upgrade is the lever if it fails.

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
returns `resource-limit`, or `backpressured` at submission (there is no
`queue-full` reason) — the system never grows a drain cap, retries forever, or
reduces fidelity to cope. **Step 1 added all of them except `undoEntriesMax`**
(see Step 1 above); projection nodes and depth reuse `treeNodesMax` and
`treeDepthMax`.

## Adapter surface (ratchet, scripted at step 1)

| Point | Hand, 2026-09-28 | Script, step 1 (baseline) |
|---|---|---|
| Direct node-mutation sites in `src/` | 67 (47 in `App.tsx`) | 70 |
| Prop-index writes | 10 | 9 |
| `mutateModel(` call sites | 28 | 28 |
| `applyEdit(` call sites (style panel) | 4 | 4 |

`node dist/scripts/adapter-surface.js --files` prints the per-file split
(step 1: `App.tsx` 58, `loopBindings.ts` 12, `dataSuggest.ts` 6,
`attrOrder.ts` 2, `ui/richContentModel.ts` 1, mutations and prop-index writes
together). The script is the authority from step 1; the hand count's exact
rules were not written down, so the small differences are not reconcilable
line by line.

Method (encoded in `scripts/adapter-surface.ts` at step 1, which adds the
`findParentList` sibling-list alias and a written receiver exclusion list for
DOM and CMS objects): grep `src/**/*.ts{,x}`
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
- **`lastKnownBytes` chaining** — reopened by step 2 (2026-09-28). The
  actor commits a new snapshot per applied intent (§5.10), but mapping a stale
  intent needs the *bytes* it was authored against (`PlanningBase.authored`),
  not only compact preconditions (§3.1 says the latter). Decide at step 5, with
  the simulator's interleavings: which authored snapshots the actor keeps
  (bounded by `snapshotsRetainedMax`, today 2), or whether the renderer's
  last-known bytes travel with the intent (bounded by `intentPayloadBytesMax`).
  An intent whose authored bytes are gone rejects `anchor-moved`, as today.
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
- 2026-09-28, step 0 (PROMPT-0A), `d10e9c5` on top of `1172b31`:
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
- 2026-09-28, gate runner (not an editor-core step): test commands now run in
  a bounded parallel pool and the static checks side by side
  (`scripts/test-pool.ts`, `docs/contracts.md` Required gate). Full gate
  336.1 s serial → 195.9 / 203.6 / 197.8 s on three consecutive green runs
  (8 CPUs, 7 jobs). `test:selectorwell` failed twice under load (a stale
  stylesheet read restored `red` after an edit), so it runs alone until that
  read-ordering race is understood; open question for the style panel, not
  for this program.

- 2026-09-28, step 1 (PROMPT-1), `2be1fb3` on top of `c5ca3c9`:
  - `env -u ELECTRON_RUN_AS_NODE npm test` — **pass, 154/154 test commands in
    200.0 s, exit 0** (153 + the new `test:simulator`; static checks tsc, eslint
    0 errors, `ratchet-check` 0, `adapter-surface` 70 / 9 / 28 / 4 at baseline).
  - `npm run test:contracts` — **203/203** (163 before): new suites
    `span`, `intent`, `source-projection`, `span-integrity`, `editor-core-types`
    (14 `@ts-expect-error` brand and exhaustiveness checks), `adapter-surface`,
    plus `attrSpans` and `__proto__` cases in `page-node`.
  - `npm run test:simulator` — oracle suite 9/9; seeded suite 24 seeds × 400
    steps, each run twice with identical trace digests, 2.6 s.
    `STACKI_SIMULATOR_SEEDS=400` — green in 27.6 s.
  - Lint fences probed with throwaway files (a `serializePage` import in `src/`;
    `setTimeout`, `Date`, `Math.random`, `await`, `Promise`, `node:fs` under
    `test/simulator/`): every one reported, probes deleted.
  - `node dist/scripts/large-fixtures.js` — six fixtures in 2.1 s, targets hit
    exactly; manifest committed.

- 2026-09-28, step 2 (PROMPT-2), `4eb4815` on top of `164e323`:
  - `env -u ELECTRON_RUN_AS_NODE npm test` — **pass, 154/154 test commands in
    229.6 s, exit 0** (static checks: tsc, eslint 0 errors, `ratchet-check` 0,
    `adapter-surface` 70 / 9 / 28 / 4 at baseline).
  - `npm run test:contracts` — **206/206** (incl. the 6 new type-level checks).
  - `npm run test:simulator` — **34/34** (11 before + `diff` 6, `map-span` 9,
    `planner` 8). `STACKI_SIMULATOR_SEEDS=400 npm run test:simulator` — green
    in 31 s.
  - Diff timing by hand (see Step 2): 1 MB ≈ 12 ms, 10 MB ≈ 90–115 ms per
    stale-intent diff.
  - Formatting: the new modules and suites were run through Prettier 3.9.9
    (npx cache, `--print-width 100 --single-quote --trailing-comma all`; no
    dependency added); every new line is ≤ 100 columns.

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