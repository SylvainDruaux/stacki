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
- **Steps 1–4 landed (2026-09-28); steps 5–10 have not started.** The
  contract layer, parser spans, hostile corpus, large fixtures, simulator
  skeleton, adapter ratchet and lint fences exist (Step 1), and so do the byte
  diff, the span mapper and the pure `set-attribute` planner (Step 2); nothing
  in the app submits intents yet. **The step-3 spike missed every
  pre-registered threshold** — two wrong-site applications in 400 seeds, and
  intent→applied p95 of 147–1 728 ms against 50 ms (see Step 3). **Step 4
  decided fail (2026-09-28)**: step 0's guarded legacy path stays the shipped
  write path, and step 5 does not start without a written plan revision.
  **Revision A** (registered `d3b825b`, measured at `2982961`) **also failed**,
  on keystroke → disk only (400.8 / 470.9 ms against 350). Every other
  threshold passed. See Thresholds, "Revision A decision".
  **Revision B** (registered `a1ceffa` with A's thresholds unchanged, measured
  at `3352742`) **passed every threshold: go** (2026-09-28). See Thresholds,
  "Revision B decision". **Step 5 landed (2026-09-28)**: every write of
  project text goes through a document actor (see Step 5). **Step 6 landed
  (2026-09-29)**: the planner plans every operation; attribute, prop,
  insert/remove, move, inline CSS, frontmatter and loop-rename gestures reach
  disk as edit requests (`page:edit`) spliced by the actor; Undo reverts them on
  the engine; property batches are undoable (see Step 6). **Step 7 landed
  (2026-09-29)**: capabilities are shown beside the selection and a node a loop
  repeats edits its one source node; canvas events carry a preview token and a
  stale rendering never selects; the canvas patch is capped and reloads, saying
  why, past the cap (see Step 7). Steps 8–10 have not started.
- **Step 0 landed (2026-09-28).** The legacy
  write path still serializes whole files (`mutateModel` → `page:write` →
  `serializePage`), but every page write now names the checksum it was
  authored against and main refuses a stale one with `conflict`. Since step 5
  that write is a `replace-source` intent to the page's document actor, and
  so is every other write of project text. Still legacy: watcher echo via
  `selfWrites`, the renderer rescan chain, saver acks by `WeakMap` object
  identity.
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
  `mapSpan.ts` and `planner.ts`; since step 5, `splice.ts` and
  `documentActor.ts` — the shipping actor, which the simulator now drives
  (`test/simulator/actor.ts` is gone). Since step 3 the simulator's actor
  plans `set-attribute` with `shared/planner.ts` and judges every remap against
  recorded byte origins; the other operations still use the step-1 reference
  planner.
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

**Landed 2026-09-28** on `refactor/architecture-consolidation` in `d10e9c5`.
Gate `env -u ELECTRON_RUN_AS_NODE npm test`: 153/153 test commands, 336.1 s,
exit 0. Where each deliverable lives:

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

### Step 3 — Spike ✅ (report recorded; thresholds missed)

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

**Landed 2026-09-28** on `refactor/architecture-consolidation` in `46e9fc6`.
Gate `env -u ELECTRON_RUN_AS_NODE npm test`: 154/154 test commands, 235.2 s,
exit 0. Report: `npm run spike:editor-core` (after `npm run fixtures:large`);
the numbers below are one run of it on an Intel i7-4820K (2013, 8 threads),
Node 24.18.0, WSL2 ext4, the machine otherwise idle.

**Verdict against the pre-registered thresholds: every one missed.**

| Threshold (§11.4) | Registered | Spike | Result |
|---|---|---|---|
| Wrong-site applications, corpus | 0 | 2 in 13 614 stale decisions | **miss** |
| Intent → applied p95 | ≤ 50 ms | 147–675 fresh, 274–1 728 stale | **miss, all 12** |
| Last keystroke → disk p95 | ≤ 350 ms | 450–1 339 ms | **miss, all 6** |
| Adapter surface recorded | — | 70 / 9 / 28 / 4 (unchanged) | recorded |

What was wired (test tree only; nothing ships to the app):

- The simulator's actor queues each intent with the snapshot it was authored
  against (`Submission`, `test/simulator/actor.ts`) and plans through
  `test/simulator/engine-planner.ts`: `shared/planner.ts` for `set-attribute`
  (the diff path when stale), the step-1 reference planner for the rest. The
  actor cannot retain authored snapshots itself: `snapshotsRetainedMax` (2) is
  spent on the current snapshot and the in-flight candidate. Carrying them is
  what the spike measured, not the step-5 decision.
- Ground truth that owes nothing to the diff: every simulated writer records
  each byte's origin (`test/simulator/provenance.ts`), and every stale
  `set-attribute` decision is judged again from those origins
  (`test/simulator/remap-judge.ts`). An element is identified by its own `<`
  byte. The judge also holds the fast mapper to the brute-force reference on
  the scenario's real bytes (files up to ~1 KB) and checks the planner's
  decision follows the mapping. Invariant 6 now allows a remap only for
  `set-attribute`; the target is located from the splice, not the anchor path.
- Two new outside writers, so the step-2 conservatism cases are exercised, not
  assumed: a copy-pasted line (a byte-identical sibling appears) and an
  attribute appended to an element in another editor.
- `wrongSite: 'fail' | 'count'`: the gate fails at the event; the report counts.

**Mapping correctness** — 400 seeds × 400 steps over the 16 simulator files:

| Verdict | Count | Meaning |
|---|---|---|
| Applied, correct | 3 123 | planned at the element the authored one became |
| **Wrong site** | **2** | seeds 36 and 240, both `duplicate-siblings.astro` |
| Conservative | 1 404 | element and value survived; mapper refused (1 201 / 203) |
| Rejected, conflict | 1 862 | another writer rewrote the very value being edited |
| Rejected, gone | 0 | no simulated writer deletes an element (gap, below) |
| Other | 6 127 | not a mapping decision (loop body, quote in value, invalid source…) |
| Unjudged | 1 096 | a git-style whole-file replace in between: no ground truth |

Conservative splits 1 201 `anchor-ambiguous` / 203 `anchor-moved`. Per file,
the stale decisions split the same way everywhere except
`map-loop.astro` (all 834 "other": every attribute sits in a loop body, which
is read-only). Fresh decisions (identity, no diff): 6 792. The brute-force
reference agreed on all 10 809 decisions it could check (2 805 skipped: file
over the table bound, or rejected before mapping) — **the mapper is exact by
its own definition, and the wrong-site plans are the definition's**.

**The wrong-site mechanism**, pinned in `test/simulator/planner.test.ts`
("KNOWN WRONG SITE", hand-derived, cross-checked with the brute-force
reference): retitle the hero `Old` → `New`, then paste a copy of the footer
line below it. A stale "retitle the footer" intent is planned at byte 59, the
copy, not 36, the original. The true history costs 29 byte edits; inserting
`New" />\n<Footer title="` after `<Hero title="` explains the same bytes for
23, and it is the only minimum script — so the mapper, which refuses ties but
not minimal mis-explanations, resolves. Without the edit above, the paste alone
is a tie and rejects `anchor-ambiguous`, as step 2 pinned. The minimum edit
script is not the edit history. The §12 fingerprint verifier does not catch
this: the copy is byte-identical. The test pins the wrong result so a fix turns
it red.

**Engine latency** — the §5.2 pipeline on a real disk: read + hash, rebuild
the snapshot if the bytes changed, plan (diffing when stale), witnesses,
splice, reparse + reproject the candidate, re-read + hash, write through
`electron/atomicWrite.ts` (temp, fsync, rename, read-back). 30 samples per
series after 2 warm-ups, nearest-rank p95; edits keep byte length (bytes-100
sits exactly at `sourceBytesMax`). `stale`: another attribute was changed on
disk first. Every intent in every series applied.

| Fixture | Scenario | p50 | p95 | refresh | plan | reproject | write |
|---|---|---|---|---|---|---|---|
| nodes-25 | fresh | 131.7 | 147.1 | — | 3.2 | 115.4 | 10.1 |
| nodes-25 | stale | 241.1 | 273.8 | 113.5 | 2.1 | 113.7 | 9.6 |
| nodes-50 | fresh | 256.8 | 278.3 | — | 6.5 | 234.3 | 13.3 |
| nodes-50 | stale | 528.6 | 639.5 | 253.8 | 4.4 | 250.7 | 14.1 |
| nodes-100 | fresh | 542.8 | 675.2 | — | 13.4 | 500.7 | 21.0 |
| nodes-100 | stale | 1 045.2 | 1 198.1 | 496.8 | 8.9 | 510.3 | 21.1 |
| bytes-25 | fresh | 311.7 | 334.0 | — | 41.4 | 185.0 | 60.0 |
| bytes-25 | stale | 479.5 | 507.9 | 182.4 | 24.4 | 179.5 | 64.5 |
| bytes-50 | fresh | 604.5 | 751.3 | — | 88.4 | 317.6 | 134.4 |
| bytes-50 | stale | 789.8 | 942.0 | 279.9 | 49.8 | 286.7 | 120.1 |
| bytes-100 | fresh | 1 003.1 | 1 061.1 | — | 164.5 | 502.5 | 243.7 |
| bytes-100 | stale | 1 451.5 | 1 727.5 | 492.4 | 106.0 | 498.7 | 254.6 |

Milliseconds; stage columns are p50. Where the reprojection goes (p50 of 5):
`parsePage` 72–310 ms, `parsePageResult` 12–85 ms, `projectPage` 23–178 ms,
decode ≤ 29 ms, SHA-256 ≤ 38 ms. **Reparse + reproject alone is 115–510 ms, so
no diff-side lever reaches 50 ms**; §12's cached diff addresses a cost the
spike did not find (plan is ≤ 165 ms, and only on bytes-*). Incremental
reparse is the only §12 lever aimed at the dominant stage, and at 25 % of the
node bound one full reprojection is already 2.3× the whole budget. A stale
intent pays the reparse twice (refresh + candidate).

**Last keystroke → disk** — the 300 ms typing batch as a real timer, then the
fresh pipeline; 20 samples per fixture: p95 450.4 / 659.5 / 892.2 (nodes-25,
-50, -100) and 710.2 / 1 037.9 / 1 339.0 ms (bytes-25, -50, -100). Timer
lateness p95 ≤ 19 ms, so the result is 300 ms + the engine number above.

**Adapter surface** (`scripts/adapter-surface.ts`, gate run): 70 / 9 / 28 / 4,
unchanged from the step-1 baseline — the spike touches nothing in `src/`.

Found by step 3 and fixed:

- **`ByteString` aliased Node `Buffer`s.** `toByteString` (`shared/span.ts`)
  copied with `slice()`, which on a `Buffer` is a view; `diffBytes`'s
  `reversed()` (`shared/diff.ts`) then reversed the caller's snapshot bytes in
  place. The simulator never saw it (its bytes come from `TextEncoder`); the
  first stale intent on bytes read with `fs.readFileSync` — the step-5 actor's
  input — tripped the planner's assertions. Both now copy with
  `new Uint8Array` and assert the copy shares no memory. Pinned in
  `test/contracts/span.test.ts` and a new `diff.test.ts` case; both fail on the
  old code.

Found and left open (inputs to step 4; not fixed, so the spike measures the
engine as step 2 shipped it):

- **The two wrong-site applications** (above). A fix is a design question for
  step 4 — for example, refusing a remap when the authored element's bytes
  also occur elsewhere near the mapped site — not a spike change.
- **`byteStringsEqual` costs ~200 ms per 10 MB** (`every` with a closure). The
  identity fast path asserts equal bytes behind equal checksums with it, which
  is most of `plan` on the fresh bytes-* rows (164.5 ms on bytes-100). Removing
  it would not change a single verdict.
- **Corpus gaps**: no simulated writer deletes an element, so "rejected, gone"
  is never reached; no text-edit operation exists yet, so `set-attribute`
  stands in for typing in both latency measures; renderer → main IPC is not
  modelled.
- **`lastKnownBytes`**: of 13 614 stale decisions, the authored snapshot was 1
  actor snapshot old in 8 024, 2 in 2 930, 3 or more in 1 699, and never held
  by the actor in 961 (the client read the disk itself). An actor keeping one
  earlier snapshot would have covered 59 %.
- `test:simulator` now takes 13 s alone, 43 s in the parallel gate (was 2.6 s):
  the stale diffs and the brute-force reference on every judgeable remap.

Deviations, with reasons: the report is a bench (`test/simulator/spike.bench.ts`,
`npm run spike:editor-core`), not a gate test, because it measures latency and
asserts no threshold; the fixture loader moved to `fixtures.entry.ts` so the
gate suite and the bench run the same scenarios, and the simulator lint fence
now also excepts `*.bench.ts` and `*.entry.ts`.

### Step 4 — Threshold decision ✅ (**fail**; revision A **fail** on U2; revision B **go**)

**Deliverables.** A recorded decision, not code.

**Gate proof.** Zero wrong-site applications across the corpus; adapter
count recorded; intent→applied and last keystroke→disk within the
Thresholds below. Fail → report; step 0's guarded
legacy path remains the shipped write path.

**Decision record — 2026-09-28, HEAD `b387086`: FAIL. No-go.**

Decided against the thresholds exactly as pre-registered (see Thresholds
below). No number moved between the spike and this decision, so no reason
for a move is owed; none is offered after the fact.

Evidence: the step-3 report (`46e9fc6`) and a confirming re-run of
`npm run spike:editor-core` at `b387086` on the same machine (i7-4820K,
Node 24.18.0, WSL2 ext4), after `npm run fixtures:large` (manifest
unchanged).

| Criterion | Registered | Step 3 (`46e9fc6`) | Re-run (`b387086`) | Result |
|---|---|---|---|---|
| Wrong-site applications, corpus | 0 | 2 / 13 614 stale | 2 / 13 614 stale | **fail** |
| Intent → applied p95, fresh | ≤ 50 ms | 147.1–1 061.1 | 153.0–1 117.4 | **fail, 6 of 6** |
| Intent → applied p95, stale | ≤ 50 ms | 273.8–1 727.5 | 290.7–1 679.9 | **fail, 6 of 6** |
| Last keystroke → disk p95 | ≤ 350 ms | 450.4–1 339.0 | 492.9–1 590.9 | **fail, 6 of 6** |
| Adapter surface | recorded | 70 / 9 / 28 / 4 | 70 / 9 / 28 / 4 | recorded |

The wrong-site plans reproduce exactly (deterministic simulator): seed 36,
`i177` planned at byte 128, element at 107; seed 240, `i92` planned at byte
51, element at 28 — both `duplicate-siblings.astro`. The re-run's p95 per
fixture, milliseconds (intent → applied fresh / stale; keystroke → disk):

| Fixture | Fresh | Stale | Keystroke → disk |
|---|---|---|---|
| nodes-25 | 153.0 | 290.7 | 492.9 |
| nodes-50 | 428.2 | 628.6 | 652.0 |
| nodes-100 | 816.8 | 1 312.2 | 931.1 |
| bytes-25 | 378.8 | 547.5 | 644.9 |
| bytes-50 | 602.8 | 896.3 | 928.5 |
| bytes-100 | 1 117.4 | 1 679.9 | 1 590.9 |

Run-to-run spread is wide (nodes-50 fresh p95 278 → 428 ms) but never
approaches a threshold: the closest misses are 3.1× the engine budget
(nodes-25 fresh) and 1.4× the keystroke budget (nodes-25).

Consequences, per plan §11 step 4 ("Fail → keep step 0's guarded legacy
path, report, and stop"):

- **Step 0's guarded legacy path remains the shipped write path.** Whole-file
  `serializePage` behind the checksum guard and `atomicWrite.ts`; an
  external edit is a visible `conflict`, never an overwrite. Nothing the
  steps 1–3 work added ships to the app.
- **Step 5 is not started, nor anything after it.** Steps 5–10 stay ⬜ and
  are blocked on a written plan revision, not on more work under this plan.
- Steps 1–3 stay in the tree as test-only contracts, simulator and bench;
  they gate nothing in `src/` and cost 43 s of gate time (`test:simulator`).

What §12 says fires, and what the evidence says about it (inputs for the
revision; nothing below is decided or built here):

- **Fingerprint verifier** — its trigger (a simulated wrong-site
  application) has fired, but it would not catch either case: the pasted
  copy is byte-identical to the target, so a hash of the mapped slice
  matches (Step 3). A fix must reason about the minimum edit script's
  choice, not the mapped bytes.
- **Incremental reparse** — its trigger (a failed latency threshold) has
  fired, and it is the only §12 lever aimed at the dominant stage: reparse
  + reproject is 120–644 ms p50 in the re-run, and one full reprojection of
  nodes-25 alone is 2.4× the whole 50 ms budget. It would have to replace
  the full reparse, not trim it.
- **Cached diffs** — trigger fired, but the diff is not the cost: `plan` is
  ≤ 172 ms p50 and only on bytes-*, most of it `byteStringsEqual` on the
  fresh identity path (Step 3). Low value against these numbers.
- Unmeasured, and needed before any threshold is re-registered: the legacy
  path's own save latency on the same six fixtures. Without it there is no
  evidence whether 50 ms was reachable by any path that reparses.

Any continuation is a new plan revision: pick the mechanism, re-register
thresholds with their written reason **before** the next measurement, then
re-run step 3's bench. This record does not choose among those.

#### Revision proposal — 2026-09-28, branch `editor-core/step4-revision` (awaiting the owner)

The decision above stands. This proposal is input for the plan revision that
decision calls for, and it moves no threshold. The thresholds under
"Proposed re-registration" are proposals: the owner registers them, with
their reasons, before the next measurement counts. **Disclosure:** they were
written after the prototype numbers below were seen. Their reasons were
chosen to hold without those numbers: the disk floor, the legacy baseline and
real page sizes. Judge them on that basis.

**1. Baselines, measured with no editor-core code**
(`node test/simulator/baseline.bench.ts`; same machine as step 3).

| Fixture | §5.2 disk floor p95 | Legacy `page:write` p95 | Legacy round trip |
|---|---|---|---|
| nodes-25 | 12.3 | 133.3 | changed, 176 648 → 188 373 B |
| nodes-50 | 18.9 | 204.0 | changed, 355 403 → 379 012 B |
| nodes-100 | 33.6 | 430.0 | changed, 712 786 → 760 148 B |
| bytes-25 | 91.7 | 191.8 | changed, +6 368 B |
| bytes-50 | 157.1 | 302.2 | changed, +6 368 B |
| bytes-100 | 312.2 | cannot write | grows past `sourceBytesMax` |

- **Floor.** Read + SHA-256, then `writeFileAtomic` (temp, fsync, rename,
  read-back): the work §5.2 mandates, and nothing else. On bytes-* it exceeds
  50 ms before any engine code runs. A second run measured 76 / 137 / 263 ms
  on bytes-25/50/100: this is WSL2 disk variance.
- **Legacy.** The path that ships today misses the same thresholds, and it
  does not round-trip these fixtures. On nodes-25 it rewrites 5 368 lines. It
  re-indents every line, and it splits `&copy; {expr}. All rights reserved.`
  onto three lines, which adds a visible space before the period. This is on
  the generated fixtures; it was not checked on real pages. It is a lower
  bound: chunk writes and IPC are excluded.
- **Real page sizes.** The 1 052 `.astro` files on the development machine
  outside `node_modules` and `test/` have a median of 1.6 KB, a p95 of
  15 KB and a max of 93 KB. The smallest named fixture (nodes-25, 176 KB) is
  about 2× the largest real page.

**2. Correctness: the uniqueness guard** (`shared/byteSearch.ts`,
`shared/planner.ts`). The rule: when the diff is non-empty and the mapper
resolves, refuse with `anchor-ambiguous` unless the resolved bytes occur
exactly once in the current file. The identity fast path is untouched.

| Variant | Seeds | Wrong site | Applied, correct | Conservative |
|---|---|---|---|---|
| Step-2 mapper | 400 | 2 | 3 123 | 1 404 |
| Step-2 mapper | 2 000 | **14** (3 files) | 16 181 | 7 319 |
| Count-increase guard | 400 | 1 | 3 123 | 1 417 |
| **Uniqueness guard** | 400 | **0** | 2 682 (−14 %) | 1 986 |
| **Uniqueness guard** | 2 000 | **0** | 14 122 (−13 %) | 10 059 |

- **The 400-seed corpus hid 12 of 14 wrong-site plans**, in two more files
  (`nested-components`, `slots-named`). The gate should run 2 000 seeds;
  it passes there with `wrongSite: 'fail'` (1 014 s).
- **Invariant.** A resolved region's bytes equal the authored identity
  region. If the true element's region survives, it is an occurrence of those
  bytes, so a unique occurrence is the true element.
- **Residual, not closable from bytes.** A copy of the target is pasted while
  another writer rewrites the original. Identical bytes arise from an
  insertion above an untouched target, where the plan would be right. It is
  pinned as "BYTES CANNOT TELL" in `planner.test.ts` and was never produced in
  2 000 seeds. Only history closes it: see the step-5 splice log (4 below).
- **Cost on repetitive pages.** On the large fixtures a stale edit is refused
  29–30 / 30 times on nodes-* and 17 / 30 on bytes-*: generated pages repeat
  identical elements. The refusal is typed and visible; the next edit,
  authored on the fresh snapshot, applies.

**3. Latency: the projection patch, parser fixes and word-wise compare.**
- **Projection patch** (`shared/projection-patch.ts`). It derives the
  candidate projection of a quoted-value splice by shifting spans, instead of
  reparsing. The rule is a positive allowlist, argued from `astroParser.ts`
  in its header. Anything outside it falls back to a full reparse.
- **Checked against the full reparse:** 384 patched candidates on the large
  fixtures and every patched candidate in the simulator. Every one was
  deep-equal.
- **Parser** (`astroParser.ts`, `source-projection.ts`, `span.ts`). One
  attribute scan per tag, a cached close-tag regex, a typed-array span
  converter, and a cheaper whitespace collapse. Full parse is 1.2–2.0×
  faster. The digests of the parser, projection and serializer output are
  identical on all 1 250 `.astro` files on the machine.
- **`byteStringsEqual`** now compares word by word: 167 → 5.4 ms on 10 MB.

`node test/simulator/patch.bench.ts` interleaves the two variants on one
file. "Engine" is intent → applied minus the refresh and the §5.2 disk work
(read, verify re-read, atomic write). All values are p95 in milliseconds:

| Fixture | Fresh, reparse | Fresh, patch | Engine, fresh | Stale − refresh, patch | Engine, stale |
|---|---|---|---|---|---|
| nodes-25 | 158.1 | **31.6** | 6.2 | 34.3 | 11.1 |
| nodes-50 | 226.1 | **32.5** | 7.7 | 32.3 | 14.7 |
| nodes-100 | 485.4 | 52.3 | 20.4 | 425.5 | 399.5 |
| bytes-25 | 276.6 | 122.6 | 18.7 | 193.4 | 80.8 |
| bytes-50 | 517.8 | 225.2 | 42.0 | 369.8 | 173.4 |
| bytes-100 | 1 141.0 | 560.3 | 128.1 | 761.1 | 357.5 |

The "reparse" column already includes the parser fixes. The stale refresh (a
full reparse of the other writer's bytes) is 104–620 ms p50 and is excluded.

**4. What remains, by stage (p50 from the same run)**
- **bytes-* disk work:** read 10–49 ms, verify 11–63 ms, write 75–288 ms.
  That is the floor.
- **bytes-100 engine: 128 ms.**
  - 45 ms is an exact UTF-16 recount, because the file is over
    `ipcFieldCharsMax`. The projection can carry its unit count instead.
  - 41 ms is the candidate SHA-256, which `writeFileAtomic` computes again
    on read-back. Reuse that one.
- **nodes-100 stale tail:** two refused patches (the hosts sit inside `{…}`)
  paid a full reparse.
- **Stale plan:** 5–16 ms on nodes-*, 51–226 ms on bytes-*. That is the diff
  plus the occurrence count. The count asserts per byte in its hot loop; move
  those checks out of the data plane.

**5. Proposed re-registration: options for the owner.**

- **A. Recommended.** Separate what the engine controls from what the disk
  imposes, and add a realistic-size tier. Each item changes a registered
  number or its definition, so each carries its reason:
  - **W — correctness.** Zero wrong-site plans across the corpus at
    **2 000 seeds**, where 400 was registered. Stricter than before, because
    400 seeds hid 12 of 14.
  - **E — engine.** Engine p95 ≤ 50 ms, fresh, on all six named fixtures.
    - This changes the definition. §11.4 labels intent → applied "the engine"
      but measures it end to end, disk included.
    - The disk floor alone is 92–312 ms p95 on bytes-*, so no engine can meet
      the old definition there on this machine.
    - Prototype status: 5 of 6 pass. bytes-100 fails at 128 ms (see 4).
  - **U — user-visible.** Intent → applied p95 ≤ 50 ms end to end, and last
    keystroke → disk ≤ 350 ms, on nodes-25 and nodes-50.
    - These are 2–4× the largest real page, and they are where the typing
      experience is judged.
    - Prototype status: intent → applied passes (31.6, 32.5). Keystroke →
      disk was not measured with the patch.
  - **S — stale.** The owner chooses either of these:
    - (i) No latency number until step 5 moves the refresh to the watcher
      tick. The stale engine p95 above is recorded, and correctness stays
      gated.
    - (ii) Engine, stale ≤ 50 ms on nodes-25/50 (prototype: 11, 15).
    Dropping a latency number is a negotiation, so it must be the owner's call.
- **B. Keep the registered numbers verbatim.** bytes-* cannot pass on this
  hardware, so B is a permanent no-go. The project stays on the legacy path.
- **C. Stop the engine.** Land the parser fixes on the legacy path only.
  Legacy stays at 133–430 ms p95 and keeps rewriting formatting on these
  fixtures.

**6. Inputs for step 5 (if A).**
- **Splice log.** The actor maps an intent authored against one of its own
  earlier snapshots through the splices it applied. The mapping is exact,
  runs no diff and needs no guard. It closes the residual for self-caused
  staleness and recovers the guard's conservatism there. The share of stale
  intents that are self-caused has not been measured; measure it in the
  simulator first.
- **Refresh on the watcher tick**, off the intent's path.
- **The renderer's model after an applied intent.** The patch keeps the
  engine's projection off the reparse path, but the UI still consumes the
  legacy `PageModel` that `parsePageSource` builds. Step 5 must say how that
  tree updates, or the reparse returns on the save path.
- **Four full SHA-256 passes per intent.** Deduplicate the candidate hash.
- **Contingent, on telemetry (§9a):**
  - Extend the patch allowlist to hosts inside expressions.
  - Context-extended uniqueness, if `anchor-ambiguous` rejections are
    frequent in the field.

**Branch `editor-core/step4-revision`** (on top of `6b0f7a8`; not merged,
nothing ships to the app except the output-identical parser fixes):
- `shared/byteSearch.ts` and the guard in `shared/planner.ts`.
- `shared/projection-patch.ts`, and the word-wise compare in `shared/span.ts`.
- The parser fixes.
- Tests: `byte-search.test.ts`, `projection-patch.test.ts`, and the flipped
  and extended `planner.test.ts`. The simulator actor checks every patched
  candidate against a full reparse.
- Benches: `patch.bench.ts` and `baseline.bench.ts`.
- Gate: 154/154 test commands, 248.8 s, exit 0. `test:simulator` 50/50.
  2 000 seeds with `wrongSite: 'fail'`: pass.

### Step 5 — Actor and write protocol ✅

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

**Landed 2026-09-28** on `editor-core/step4-revision` in `0411fe6`.
Gate `env -u ELECTRON_RUN_AS_NODE npm test`: 155/155
test commands, 213.6 s, exit 0 (154 + the new `test:platform`; static checks
tsc, eslint 0 errors, `ratchet-check` 0, `adapter-surface` at baseline). Simulator long run
(`STACKI_SIMULATOR_SEEDS=2000`, `wrongSite: 'fail'`): 2 000 seeds × 400
steps, every seed twice, 0 wrong-site plans, 702 s — W still holds with the
shipped actor and the new lock and replace-failure events. Where each
deliverable lives:

- **The actor** (`shared/documentActor.ts`, engine-fenced like the planner):
  the simulator's step-wise actor promoted, so the simulator now drives the
  state machine that ships. idle → planned → written → idle over an injected
  `DocumentDisk` (read, advisory lock, atomic replace), planner and
  `Projector`. `submitIntent` returns `backpressured` at `intentsPendingMax`
  (never a drop); every accepted intent reaches one `Outcome`; the actor never
  retries or merges. New since the simulator's version: the §5.2 step-7 lock,
  held from the re-read through the verifying read; `uncertain` with the
  candidate checksum when a replace landed without a flushed directory or its
  read-back fails; `refreshActor` (the watcher-tick read); a pure
  `reconcileUncertain` (applied / not applied / changed again). The honest-
  limit product contract is the module header, at the write site.
- **Splices and planning:** `shared/splice.ts` (moved from the simulator: one
  implementation for both); `shared/planner.ts` plans `replace-source` — one
  whole-file splice witnessed by the authored bytes, never mapped — and agrees
  with the step-1 reference on all 60 fixture files, fresh, stale and with a wrong
  anchor length (`planner.test.ts`).
- **The real disk** (`electron/documentDisk.ts` over `electron/atomicWrite.ts`):
  bounded reads; the lock is a lock file beside the target (Node has no
  portable `flock`), naming pid, host and token, broken when its owner process
  is gone or it is older than 10 s; replace = `wx` temp in the target's
  directory, mode and owner kept (refused if the owner cannot be kept), fsync,
  rename, directory fsync (EIO → `not-durable`; EINVAL and kin, and Windows →
  the platform's promise); a dangling symlink is refused; creation is
  exclusive. Canonical key: directory identity (device, inode) plus the name,
  case-folded where a probe shows the directory ignores case; a key whose path
  changed replaces its idle actor (found by the suite: see below).
  `writeFileAtomic` is deleted, not left unused.
- **The host** (`electron/documentActors.ts`, `electron/documentWrites.ts`): one
  per main process, stepping each submission to its outcome before returning
  (main's handlers run one at a time; this keeps the check-to-use window as
  narrow as the protocol allows and the write order the legacy order).
  Bounded by `documentActorsMax` 512 and `documentBytesRetainedMax` 64 MB
  (new, `shared/limits.ts`; least recently used idle actors dropped). The
  watcher's outside changes mark actors dirty and refresh them on the next
  tick, off the intent path (§7; carried from step 4). `withLeases` takes a
  batch's actors in sorted canonical order.
- **Single writer.** `page:write` / `page:writeRaw` submit `replace-source`
  witnessed by the renderer's `baseChecksum`, and the style re-write is one
  more, witnessed by the checksum just written; every chunk file has its own
  actor. Beyond the plan's page / chunk / stylesheet, every other writer of
  project text moved too — `style:writeFile`, `src:writeText`,
  `assets:writeText`, the CMS and asset handlers that edit pages, `cms:delete`
  importer rewrites, `cssVars` (9 sites), content entries, git conflict
  resolution — through `writeProjectText` (witnessed by the bytes on disk at
  that moment) or `createProjectText` (`page:create`, `page:move`,
  `component:create`, `cms:create`: never overwrites). Reason: any of them
  writing a page outside the actor is the two-writer hole of §3.3.
  `test/contracts/single-writer.test.ts` inventories every file-writing call
  in `electron/` against an allowlist with a reason per entry (userData state,
  `.stacki` metadata, the generated preview harness, new-project scaffolding,
  moves) and pins one owner each for the write primitives, the disk and the
  host. Every `applied` outcome returns the checksum the renderer's saver
  already adopts as its next baseline (`src/App.tsx` `pageWriteOutcome`).
- **Property batches** (`electron/componentProperties.ts`): leased in sorted
  canonical order, each file witnessed by its `before` checksum, bounded by
  `PROPERTY_LIMITS.filesMax`; the checked rollback is intents too, witnessed
  by the batch's own bytes, so a file changed since is named, not restored.
- **Wire contract:** `page:write` errors gain `uncertain` (the host reconciles
  at once; only an unreadable file reaches the renderer) and `backpressured`
  (`shared/page-save.ts`, `shared/ipc-results.ts`); the renderer keeps the
  edits unsaved for both, so a write that did land returns as a visible
  conflict on the next save.
- **Telemetry** (`electron/documentTelemetry.ts`, §9a): one counter and one
  JSON line on stdout per outcome, backpressure, save-guard conflict and
  leaked lock — event, 16-hex path hash, intent id, outcome, reason, running
  count; no path, no bytes (pinned in `test/document-actors.test.js`).
- **Adapter surface:** a fifth ratchet counter, `replace-source` submission
  sites in `electron/` (plan §3.3), baseline **23**; the other four unchanged
  at 70 / 9 / 28 / 4.

**Platform suite** (`test/platform/`, `npm run test:platform`, in the gate):
12 tests, 0 skipped on this machine — WSL2 ext4, and NTFS through drvfs with
Windows interop.

- `filesystem.test.js`: permission bits kept (0644, 0600, 0755, 0640, 0664)
  under umask 077, owner and group kept, a new inode; flush order — fsync of
  the staged file, the rename, fsync of the directory; the directory entry
  replaced in place with nothing staged left; a symlink written through with
  the link kept, a symlinked folder reaching one actor, a dangling link
  refused; a second process reading continuously through 60 saves sees only
  whole versions; two names differing in case are two files on ext4.
- `processes.test.js`: 4 processes × 40 rounds lose no update, and every
  refusal is a race; SIGKILL after the rename reconciles to `applied`, before
  it to `not-applied`, and after an outside write to `changed-again`; the dead
  writer's lock is broken by the next writer.
- `windows.test.js`: on NTFS, a file held open by a Windows process without
  delete sharing makes the save `write-failed` with the target untouched and
  nothing left behind; with delete sharing it applies; every spelling of a
  name is one actor and one lock.

A cooperating-writers run for the record: 34 applied, 126 refused of 160
rounds (a held lock is `write-race`; the actor never retries).

**Parity run** (`test/legacy-parity.bench.js`, not in the gate: it needs the
legacy build). The legacy main process of `a881aee` compiled in a scratch
worktree, loaded by the windowless harness beside the current one; each
gesture runs through both builds' real IPC handlers on twin project copies,
then every file is compared byte for byte, and the replies by outcome.
**213 of 213 gestures identical**: 52 fixtures (corpus, round-trip,
editor-core; `.astro`, `.md`, `.mdx`) × save / raw save / stale save / no-op
save, plus a chunk page edited inside its `.html` chunk, a stylesheet save, a
code-window save, and `component:editProperties` (a prop rename across a
component and two consumers, and an option rename). What they did: 42 saves
and 52 raw saves changed bytes, 52 stale saves were refused as conflicts
alike, 10 saves and 46 no-op saves changed nothing, 6 no-op saves reformatted
(the legacy serializer, reproduced identically by both), and the five project
scenarios all changed bytes.

**Save latency** (`test/save-latency.bench.js`, `page:write` through both
builds, interleaved, 20 samples, load 1.23 at start), p50 / p95 ms:

| File | Legacy | Actor |
|---|---|---|
| largest corpus page (2.7 KB) | 6.8 / 10.7 | 11.9 / 14.2 |
| nodes-25 | 101.6 / 111.6 | 108.3 / 119.6 |
| nodes-50 | 198.2 / 206.8 | 208.0 / 226.1 |

The first version cost 2× (nodes-25 246.6 p50): the actor projected every
candidate, which nothing reads for a `replace-source`. Snapshots in the app now
derive their projection on first read (`createLazySnapshot`,
`shared/snapshot.ts`; a visual intent's planner reads it and pays as before).
The remaining difference is the directory flush, the lock file and the extra
reads — the protocol's durability and exclusion.

Found by step 5 and fixed:

- **Actor identity across a reused inode.** The component-properties suite
  deletes each temp project; the next `mkdtemp` directory reused the inode, so
  a directory-identity key reached an actor for the deleted path. A key whose
  path changed now replaces its idle actor (the actor holds only a cache).
- **No directory flush.** The step-0 write fsynced the file but not the
  directory, so the rename itself could be lost to a power cut.
- **Ownership and dangling links.** A rename-replace silently gave another
  user's file to the saver, and a dangling symlink was replaced by a regular
  file; both are now refused.
- **Raw writers.** The style panel's stylesheet save, code windows, CMS and
  asset edits into pages, and `cssVars` wrote with truncating `writeFileSync`,
  unguarded; `page:create` checked existence, then wrote. All go through
  actors now; creation is exclusive.

Deviations, with reasons:
- The single-writer rule covers all project text, not only page / chunk /
  stylesheet (above). Moves, renames and deletes stay outside the actors: they
  write no bytes; a moved file's next write re-keys its actor.
- `lastKnownBytes`, decided: the renderer sends no bytes; the actor keeps its
  current snapshot only, and a stale intent without authored bytes is refused
  with its operation's stale reason. The simulator still sends authored
  snapshots (`Submission.authored` is optional) so stale visual intents stay
  mapped there. The splice log is not built (no mapped intent ships yet).
- The host is synchronous, so production never queues; backpressure is
  reached by the simulator and by the host's deferred mode in tests.
- No lint fence on the write primitives: `no-restricted-syntax` lists replace
  each other per block; the static inventory enforces more (every write API,
  every file) and names its reasons.
- Files over `sourceBytesMax` are no longer written by git conflict resolution
  or the CMS editors (the actor's bounded read refuses them); the legacy
  writers had no bound.
- Bench write stages now include the directory flush
  (`test/simulator/verified-write.entry.ts`); re-runs are not comparable
  one-to-one with the step-3/4 numbers.
- `cssVars.renameVariables` lost its `markWrite` option: `writeProjectText`
  notes the self-write itself.

Left open, carried to step 6 and later:
- Chunk files are witnessed by their bytes at write time, not by a renderer
  checksum; an outside edit to a chunk since the page opened is still replaced.
- The save path reparses for its reply (the legacy `PageModel`), as before.
- SHA-256 passes per save grew (guard, refresh, lock re-read, verify,
  candidate); measured cheap above; dedupe carried.
- A crash before the rename leaves an inert `.stacki-write-*.tmp` (ignored by
  the watcher); nothing sweeps it.
- The platform suite ran on Linux (ext4) and NTFS via WSL; macOS and native
  Windows are unrun here. macOS `fsync` does not reach the drive cache
  (`F_FULLFSYNC` is not exposed by Node).
- Telemetry counts live in the process and its log; nothing aggregates them.
- The stale-plan per-byte assertions and code-mode `/ ? :` hosts (step 4) are
  untouched.

### Step 6 — Gesture expansion ✅

**Deliverables.** Single-file operations ship in order: attribute → prop →
insert/remove → move → inline CSS → frontmatter slots. Stylesheet intents
(multi-file) follow the §3.3 outcome-gated composition rule once a real
gesture needs them. New features enter through intents only. Undo on the
engine: each `applied` outcome records inverse splices; Undo submits them as an
intent against the post-apply checksum; `LIMITS.undoEntriesMax` (100) bounds the
stack. The property batch gains an inverse batch.

**Gate proof.** Adapter surface shrinks monotonically. Undo after an external
edit maps through the diff or rejects — never reverts the external change
(simulator scenario).

**Landed 2026-09-29** on `refactor/architecture-consolidation`, eleven commits
`ff030a5`..`a3456ba` (listed below) plus the printer fix and this record.
Every commit gated: `env -u ELECTRON_RUN_AS_NODE npm test` 155/155 (the gate's
command count is unchanged; the new suites run inside `test:contracts`,
`test:simulator` and `test:roundtrip`).

How a gesture reaches disk now (the design; plan §2 layer 3, §4, §7):

- **The engine plans every operation** (`ff030a5`). `shared/planner.ts` (dispatch
  and the attribute family), `planTree.ts` (insert, remove, move),
  `planText.ts` (rename sites, frontmatter slots, code patches, reverts,
  replace-source), `planSupport.ts` (anchor resolution, generalized from step
  2: a tag with attributes is identified by its name through its last
  attribute, anything else — a bare tag included — by its whole span),
  `loopScope.ts` (loop parameters, rename sites, the byte form of
  `stripLostBindings`), `inlineStyle.ts` (one declaration edited in place, the
  same code on both sides). Two operations join the union: `remove-node` (the
  initial list had no removal) and `revert-splices` (Undo's inverse: restores
  bytes, keeps a parsing file parsing; stale → `region-externally-modified`).
  Insertions are zero-width splices, so inverses are exact and later rebases
  never cut through a neighbour. Stale intents of every operation map through
  the diff with the step-2 uniqueness guard; hunks map with 64 bytes of context.
- **`page:edit` and the compat adapter's electron half** (`127b818`,
  `shared/edit-request.ts`, `electron/editRequests.ts`). The renderer states a
  gesture in the terms of the page it shows — node references are the path,
  kind and UTF-16 range of its parse — against that parse's checksum. Main
  checks each reference against its own projection of the same bytes, converts
  ranges to bytes, prints only what an edit adds (new nodes at their
  indentation, the frontmatter block of which only the differing slot is
  written), finds a loop rename's sites, and submits the intent. The reply is
  the page as written plus the inverse hunks. `page:read` now reads through
  the page's actor, so the host holds the bytes the renderer authors against.
- **Staleness the app caused itself is rebased exactly; an outside write is
  mapped.** The host keeps per actor a commit log (`commitLogEntriesMax` 16:
  from, to, minimal splices — a whole-file save logged as the region it
  changed) and earlier snapshots (`authoredSnapshotsMax` 16,
  `authoredBytesRetainedMax` 16 MB). An edit authored before the actor's own
  commits is restated against the current bytes through them
  (`shared/rebase.ts`: a span a commit cut through has no image and is
  refused); one authored before an outside write goes to the planner with its
  authored snapshot and maps through the diff; one whose bytes are gone is
  refused, never guessed. A frontmatter request states the whole block's
  meaning, so after the app's own commits it is compared with the block on
  disk now (`EditBase.history`, `buildEdit`), or it would do their part twice.
- **The persistence layer** (`e964f57`, `src/pageEdits.ts`, successor of the
  whole-model saver). The page state keeps its origin — the disk parse the
  shown model was cloned from — and requests name the origin's nodes (ids are
  shared by cloning, never by reparse: `modelAdoption.ts` still only keys UI).
  `EditDrafts` queues requests per page and origin: a burst in one stream of
  one undo step coalesces while unsent (a set is idempotent), structural
  requests never do, a gesture without an intent form turns the queue into
  whole-model saves until the page is clean, and the queue is bounded by
  `intentsPendingMax`. `sendDrafts` sends them one at a time (the host rebases
  each later one), falls back to the whole-model save for an unsupported
  request or a refusal over unchanged bytes, turns a refusal over changed bytes
  into the conflict notice — which now names the actor's reason — and sends
  again only what was refused before anything was written (never a write that
  may have landed). The saver gains an `advanced` outcome: requests that reached
  disk before a later one failed make their bytes the next base. The watcher no
  longer raises a page-wide conflict over unsent requests: they map through an
  outside change, or are refused one by one.
- **Gestures** (`src/editGestures.ts`): each is its requests against the origin
  and its effect on the shown model — a new model, never one edited in place,
  so the adapter's edits are centralized and the ratchet counts none of them.
  `commitEdit` in `App.tsx` sends a gesture as requests when it can be stated,
  else saves the whole model exactly as `mutateModel` does.

The gestures, in the §11.6 order, with the adapter surface after each
(mutations / prop-index writes / `mutateModel` / `applyEdit` / replace-source):

| Step | Commit | Surface after it |
|---|---|---|
| (step 5) | `0411fe6` | 70 / 9 / 28 / 4 / 23 |
| attribute | `e964f57` | 67 / 4 / 25 / 4 / 23 |
| prop | `06bbc6c` | 67 / 4 / 25 / 4 / 23 |
| insert/remove | `e14012e` | 55 / 4 / 22 / 4 / 23 |
| move | `c07db4c` | 53 / 3 / 21 / 4 / 23 |
| inline CSS | `d49b426` | 53 / 3 / 21 / 4 / 23 |
| frontmatter | `6da4741` | 48 / 2 / 15 / 4 / 23 |

What each step sends as requests:
- attribute: `setProp`/`setProps` string values and removals; `addClassToNode`.
- prop: expression and bare values, and type changes.
- insert/remove: palette inserts; component and asset inserts already
  imported; duplicate (the node's own bytes); delete with its note; notes
  created and cleared.
- move: `moveNode` — relocated bytes, the note with it, a stale `slot` dropped
  first, loop references stripped when it leaves a loop.
- inline CSS: a Style edit of one declaration, as `set-inline-style`.
- frontmatter: the frontmatter and declarations editors; imports added by
  inserts; a delete's pruning; asset imports; the dead-query cleanup; loop
  renames (multi-span `rename-binding`).

Why two steps left the surface unchanged: prop and inline CSS share
`setProp`'s call site with the attribute step, so they widen what that site
sends as requests rather than removing a site. No step grew it. `applyEdit`
(the style panel's rule writes) and the replace-source sites in `electron/`
are later steps' (8, 9).

**Parity vs the legacy path** (`test/gesture-parity.test.js`, in the gate):
every gesture over every node of every `.astro` fixture, once through the
legacy path (the adapter's effect on the model, reprinted by `serializePage`)
and once through the engine (the adapter's requests through main's translator
and the shipping planner, later requests rebased as the host does), both
parsed and compared with layout metadata removed. **3 933 compared, all the
same page, 2 078 byte-identical**; requests the planner refuses fall back to
the whole-model save in the app and are counted, not compared.

| Gestures | Compared | Byte-identical | Refused (fallback) |
|---|---|---|---|
| attribute | 510 | 357 | 140 |
| prop | 664 | 462 | 228 |
| insert/remove | 1 296 | 668 | 321 |
| move | 1 226 | 418 | 347 (+68 with nothing to stand beside) |
| inline CSS | 16 (11 one declaration in place) | 0 | 0 |
| frontmatter | 211 | 173 | 0 |
| loop rename | 10 | 0 | 2 |

The comparison merges adjacent text and ignores whitespace inside it, and reads
`&quot;` as `"`: the legacy printer reflows an inline run a node per line (a
duplicated `.` renders `. .` there, `..` through the engine), and rewrites a
double quote inside any value it reprints, even on a tag no gesture touched.
Inline CSS and loop renames are never byte-identical because the legacy side
always reprints the tag or the loop.

Found by the parity sweep and fixed:
- **Legacy printer: an emptied element wrote its removed child back.** The
  printer reused an element's stored inner source whenever its children list
  was empty, so a delete or a move of an element's last child through the
  whole-model path left the child in place (a move wrote it twice). The
  adapter's effects drop the stale source (`e14012e`/`c07db4c`), and the printer
  now reuses only a whitespace inner (`electron/astroParser.ts`), which fixes the
  gestures still on the whole-model path too. Round-trip 470/470 with it.
- **Code around markup.** Removing the only node of a condition's branch or a
  loop body leaves `cond && ( )`, and inserting beside a node in a branch can
  land outside its parentheses (`: <p/>other ? …`): both parse, neither runs.
  The planner refuses both; the app saves those whole.

**Undo on the engine — the decision on record** (plan §11 step 6, decided
2026-09-28, landed here):
- A gesture sent as requests pushes an edits entry whose record collects each
  applied request's inverse (`inverseEdits`: same ranges, expected and
  replacement swapped). Undo reverts them newest first as `revert-splices`
  requests, each authored against the checksum it came back with, and pushes
  the inverses of the reverts as the redo step. A file changed since maps
  through the diff (64 bytes of context per hunk) or the revert is refused with
  its reason — an outside edit is never reverted. A refusal stops there and
  keeps what is left undone.
- Where a whole-model save carried the gesture (no intent form, or a queue in
  whole-model mode), its snapshot undoes it, as before; snapshot entries are
  step 9's to delete.
- Applied edits entries survive an outside reload (`dropPageHistory`); snapshot
  entries still do not (step 0's rule).
- `LIMITS.undoEntriesMax` (100) bounds the history (was a literal).
- **The property batch's inverse batch** (`d396033`): each applied
  `component:editProperties` batch leaves its inverse in main
  (`PropertyUndoStore`, bounded by `undoEntriesMax`); `component:revertProperties`
  applies it as a batch — leased in sorted order, every file checked against
  the bytes the batch left before any is written, the checked rollback on a
  failure — so a changed file refuses the whole undo, naming it. The renderer
  holds tokens, never batches. Property edits were not undoable before.

**Simulator scenario** (`4d62807`): an `undo` event reverts one of the eight
most recent applied edits, authored against the bytes that edit left, whatever
happened since. A planned revert is judged against byte provenance: it must
replace the edit's own bytes, not a copy of them while the originals survive
elsewhere. Gate seeds must reach `undo:planned`, `undo:mapped` and
`undo:rejected region-externally-modified`; over the 24 gate seeds 415 undo
events: 45 planned on unchanged bytes, 17 mapped through other writes, 88
refused, 6 source-invalid, the rest unjudged or with nothing to undo — none
reverting an outside write. Every stale oracle gesture is judged the same way
(`judgeOracleRemap`): the result must be the oracle's edit on the surviving
bytes.

**Stylesheet intents, outcome-gated** (`a3456ba`): typing a lone class in the
style panel's selector box puts it on the element as a page request; the rule
the panel then writes for it waits for that request's outcome — written with
its own file's witness once the class applied, never submitted when it was
refused, and each file's outcome shown (the page's notice, the panel's error).

Deviations, with reasons:
- Gestures with no operation stay on the whole-model save: text and content
  edits (there is no set-text operation in the plan's list), tag and component
  renames, attribute renames (`renameProp`), the else-branch toggle, layout
  wrap/unwrap, paste, extract-to-component, rewording a note. 15 `mutateModel`
  sites remain for them.
- Nodes a loop repeats accept only a move (the gesture exists to take a node
  out of its loop); other gestures on them save the whole model until step 7
  decides how the canvas addresses them. Nodes inside chunk files, Markdown and
  MDX pages (step 10), and pages whose model descends from typed code keep the
  whole-model save.
- The renderer sends no bytes (step 5's decision stands): the host keeps what
  it needs. The "splice log for self-caused staleness" of step 5's open
  question is the commit log above.
- A frontmatter block that does not exist yet is not created by a request
  (it would be a whole-file change); such a page saves whole.

Left open, carried:
- Text editing as an operation (plan §3.3 lists none; a `set-text` would move
  the largest remaining group of gestures).
- `modelAdoption.ts` still keys UI after every reply; it feeds no anchor.
- Morph move-blindness (open questions): moves now ship; the canvas still
  morphs from the page's re-render. Step 7.
- The simulator generates set-attribute, replace-source, oracle gestures and
  undo; a random generator for every operation is not built (the corpus sweep
  in `operations.test.ts` covers each operation fresh and stale instead).

### Step 7 — Capabilities and preview bridge ✅

**Deliverables.** Read-only fallbacks visible, never silent; dev-only source
markers injected in memory; the preview token (digest over the sorted
dependency manifest of the rendering chain); stale-token rejection;
morph-without-reload from a projection diff, capped by a limit, honest
reload past the cap.

**Gate proof.** A preview event is accepted only if the source file and
dependency state that produced it are still current; no marker that could
change observable project behavior is ever written into the project.

**Landed 2026-09-29** on `refactor/architecture-consolidation`: `2fa3f0f`
(capabilities), `3af4dbd` (the preview token), `a625992` (the capped patch),
`28bb8bb` (the suites the first gate run caught), then this record. The full
gate ran on the result (Verification record).

**Capabilities — the step-6 question decided** (`2fa3f0f`). The canvas
addresses a node a loop repeats as its one source node: a click on any rendered
copy selects that node, and the occurrence only picks which copy is outlined —
no instance identity is minted (plan §6). An edit of it is an edit of the
source, and so of every copy; the engine can do that, so refusing it would be
the read-only downgrade the prompt forbids, and `repeated-source-node` now
accepts visual intents (`shared/capability.ts`). Placing nodes beside it or
removing it stays refused: the list it sits in is the loop body's code, and a
second root there does not build. Moving it out works as in step 6.
- New guard, found by the simulator's oracle for "the footer moved into a loop
  outside Stacki": the same bytes then mean one source node rendered many
  times, and an edit authored against one element would change every copy.
  `resolveTarget` refuses a stale intent whose node's capability changed since
  it was authored, `region-externally-modified` (`shared/planSupport.ts`).
- The renderer classifies the selection with the projection's own
  `classifyNode` (`src/nodeCapability.ts`; the test compares both on every node
  of every corpus page) and shows every capability but `editable` beside the
  selection's panels (`CapabilityNotice`): repeated ("an edit here changes every
  item"), opaque code, runtime aggregates, and Markdown/MDX as `unsupported` —
  never `read-only`, since the whole-page save still edits them until step 10.
- Parity (`test/gesture-parity.test.js`) after the decision: **4 207 gestures
  compared, all the same page, 2 083 byte-identical** (step 6: 3 933 / 2 078).
  Attribute gestures refused 140 → 40, prop 228 → 63: the repeated nodes.

| Gestures | Compared | Byte-identical | Refused (fallback) |
|---|---|---|---|
| attribute | 610 | 357 | 40 |
| prop | 829 | 462 | 63 |
| insert/remove | 1 297 | 668 | 320 |
| move | 1 234 | 423 | 339 (+68 with nothing to stand beside) |
| inline CSS | 16 | 0 | 0 |
| frontmatter | 211 | 173 | 0 |
| loop rename | 10 | 0 | 2 |

**The preview token** (`3af4dbd`, `shared/preview-token.ts`). A click names a
node by its index path in the rendering the frame shows; the editor selected
that path in the model it shows, and the next edit — authored against the
editor's page — applied to whatever node now sat there. That is invariant 6's
silent remap. Now:
- *Stamps.* Every `.astro` file the dev plugin marks carries one stamp comment,
  `<!--avb-d:<sha256>:<project-relative path>-->`, for the exact bytes it was
  marked from, at the end of its template (after `</html>` on a page, so the
  doctype is untouched). A stamp is part of its own file's compiled module, so
  it changes exactly when the dev server re-loads that file: a component edit
  restamps the component, and the page's next rendering carries the new stamp
  though the page's bytes never changed. A page-level manifest computed at load
  time would not: Vite soft-invalidates importers and does not re-run their
  load, so it would name the old component forever.
- *Manifest and token.* The frame reads the stamps of the rendering it shows
  (anywhere in the document) into a manifest — sorted by path, one entry per
  file, at most `previewManifestFilesMax` (512); one file with two checksums is
  a rendering of two versions and has no manifest — and its token is the
  SHA-256 of `canonicalManifest`, by Web Crypto. The sandboxed preload cannot
  require `shared/`, so it keeps a mirror that `test/preview-token-frame.test.js`
  pins to the original. It announces `avb:render` `{ token, stamps }`; hover,
  click and double-click carry `token` (null until the digest is known).
- *Acceptance* (`src/previewGate.ts`). A click or double-click selects only
  when (1) its token is the frame's latest; (2) the open file's stamp is the
  bytes the editor shows — a clean page's checksum, or its origin while unsaved
  edits leave every path the same node (text typed, not a node moved); and (3)
  `preview:check` answers `current`: main re-derives the token from the
  manifest and reads every stamped file from disk (`electron/previewCheck.ts`;
  never the watcher; a path outside the project is missing, a file past
  `sourceBytesMax` changed). The page is judged again after main answers. A
  refusal is a notice naming the reason, never a silent drop. Hover is a
  picture, not a selection: it needs (1) only.
- *Markers stay in memory.* The generated plugin's `load` hook now calls
  `electron/previewMarkers.ts`, which reads project files and returns strings;
  nothing imports it (the dev server requires it by path, unpacked beside the
  archive) and only it calls the marked serializers. The morph client gathers
  each new rendering's stamps at the document's end, so no stamp outlives the
  rendering it named.
- *Tests* (`test/contracts/preview-bridge.test.ts`): the real generated config,
  imported as Astro would, over a temporary project; every project byte
  compared before and after, and no project file holds a marker. Stale-token
  rejection both ways, through the real handler: a component edit makes the
  page's rendering `file-changed` with the page's bytes unchanged; an unrelated
  page's edit leaves it `current`. Plus forged tokens, forged paths, missing
  files, the parsers' negative space, and the fence.

**The capped patch** (`a625992`). The canvas still morphs from the difference
between the server's previous and new renderings — the projection of a
rendering is its marker-delimited nodes, and this is the diff of two of them.
Nothing bounded it: each child list builds an LCS matrix of its lengths. Two
caps, both in `LIMITS`, handed to the patcher at the bridge boundary (main
prepends `AVB_PREVIEW_LIMITS` to the source it serves; the patcher declares it
and defines no numbers): `previewMarkersMax` (20 000) node markers per
rendering, and `previewMorphWorkMax` (4·10⁶ matrix cells, 16 MB) per patch,
drawn before a matrix is allocated. Past either, the page reloads and first
posts `avb:preview-reload` with its reason; the app shows the cap reasons, and
the reloads a patch never could avoid (a changed script, a failed patch) stay
quiet, as before. `test/morph.js` pins both edges with a shrunken patcher and
checks the served source carries the `LIMITS` values.

Deviations, with reasons:
- The morph diff is between two renderings, not between two engine
  projections of the source. The engine's projection diff would count source
  nodes, but what the patch spends is DOM work; a second, engine-side bound
  would duplicate the one that measures the actual cost.
- Markdown and MDX pages carry no stamp (their markers come from a Markdown
  processor plugin, not the `.astro` load hook): the open-file check is skipped
  for them until step 10; their layouts' stamps are still checked on disk.
- A file the plugin cannot parse renders unmarked, with no stamp and no
  addressable node, so no event can name a node inside it; its changes do not
  make the rendering stale.
- Stylesheets, content and config carry no stamp: they change no index path,
  and events address nodes only by path. A content change that alters how many
  copies a loop renders changes only which copy is outlined.

Left open, carried:
- The moved-node case (open question, "Morph move-blindness"), confirmed: a
  move patches without a reload, the page ends up exactly as the new rendering,
  the siblings that stayed are the same live elements, and the moved element is
  rebuilt — its client state is not carried. Carrying it would need the
  engine's move to reach the patcher; not built.
- Placement beside a repeated node (insert, duplicate, remove) is refused and
  falls back to the whole-page save; a fragment-wrapping insert would lift it.

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

**Spike result (2026-09-28, Step 3): all three missed** — 2 wrong-site
applications; intent→applied p95 147–1 728 ms; last keystroke→disk p95
450–1 339 ms. Not renegotiated.

**Step-4 decision (2026-09-28): fail, no-go** — confirmed by a re-run at
`b387086`; the thresholds did not move. See Step 4.

### Re-registered 2026-09-28 — revision A (owner's decision), before measurement

The owner chose option A of the step-4 revision proposal (Step 4). For the
stale path the owner chose (ii). The candidate checksum counts as protocol
work. The thresholds above are superseded, not deleted: they were measured,
and they failed.

These numbers, their definitions and the protocol are committed before any
measurement under them counts. The prototype numbers in the proposal were seen
first. That is disclosed there, and it is why each reason below is one that
does not depend on them.

**Stage terms.** Stages are the columns of `test/simulator/patch.bench.ts`.
- **Disk work:** read, verify and write, as §5.2 mandates.
- **Protocol work:** the disk work plus `hash`, the candidate's SHA-256. The
  snapshot contract (§3.1, `shared/snapshot.ts`) computes that hash from the
  full bytes.
- **Engine:** plan + splice + project, summed per sample. This is everything
  the engine decides, and nothing the protocol mandates.
- **End to end:** every stage, including the refresh on a stale intent.

| Id | Threshold | Fixtures |
|---|---|---|
| W | 0 wrong-site plans | simulator corpus, 2 000 seeds |
| E | engine p95 ≤ 50 ms, fresh | all six named |
| U1 | end-to-end intent → applied p95 ≤ 50 ms, fresh | nodes-25, nodes-50 |
| U2 | last keystroke → disk p95 ≤ 350 ms | nodes-25, nodes-50 |
| S | engine p95 ≤ 50 ms, stale | nodes-25, nodes-50 |
| P | every patched candidate equals its full reparse | every measured run |

Reasons, in full:
- **W.** The 400-seed corpus produced 2 wrong-site plans. The same code
  produced 14 at 2 000 seeds, in two more files. A count that grows with
  seeds is not measured by the smaller run.
- **E.** The old number was intent → applied, labelled "the engine" but
  measured end to end. With no engine code at all, the protocol costs more
  than 50 ms on bytes-*:
  - Disk floor: 92–312 ms p95 (`baseline.bench.ts`).
  - SHA-256 of 10 MB: 37.5 ms p50 and 46 ms p95 on this CPU.
  No engine can meet the old definition there on this machine. The engine's
  own share is what the engine's design can change, so that is what E gates.
- **U1 and U2.** Ungating the disk must not hide what a user waits for on
  real pages. The 1 052 real `.astro` files on the development machine have a
  p95 of 15 KB and a max of 93 KB. nodes-25 and nodes-50 (176 and 355 KB)
  are the named fixtures closest above them. The budgets are the old ones,
  unchanged.
- **S.** Stale intents were in the old intent → applied number. The owner
  kept a latency gate for them, not a recorded-only figure, on the same
  realistic tier. The refresh (a full reparse of another writer's bytes) is
  excluded: step 5 moves it to the watcher tick.

**Recorded, not gated:**
- Protocol stages, and the hash, per fixture.
- End to end on nodes-100 and bytes-*.
- Stale end to end.
- Stale engine on nodes-100 and bytes-*.
- Patch refusals per series.
- `anchor-ambiguous` counts.
- The adapter surface.

**Protocol, fixed before measuring:**
1. **Code under test.** The implementation commit that follows this one.
   Only the harness and the fixes named in the proposal (§4 there) land in
   it.
2. **Machine.** The i7-4820K, Node 24.18.0, WSL2 ext4, after
   `npm run fixtures:large` (manifest unchanged).
3. **Harness.**
   - E, U1, S and P: `node test/simulator/patch.bench.ts`, patch variant. The
     seeds are the ones in the file at `aa2fe2f` (fresh 1, stale 2). There
     are 30 samples per series after 2 warm-ups, and p95 is nearest-rank.
     Stale targets are elements whose identity region is unique in the file.
     The uniqueness guard refuses the others by design; their refusal is
     counted under W's corpus instead.
   - U2: the same file's keystroke section. It runs the 300 ms batch as a
     real timer, then the fresh patch pipeline, with 20 samples per fixture,
     as in step 3.
   - W: `STACKI_SIMULATOR_SEEDS=2000 node --test
     test/simulator/simulator.test.ts`, with `wrongSite: 'fail'`.
4. **Which run counts.** The first complete run counts. A run is void only
   if the bench's printed load average (1 minute, taken at start) is above
   1.5. The bench prints it before any result. A void run is recorded as
   void, with its load, and the next complete run counts.
5. **Decision rule.** Go only if W, E, U1, U2, S and P all pass on the run
   that counts. Otherwise the result is no-go: the legacy path stays, it is
   reported, and nothing is renegotiated.

### Revision A decision — 2026-09-28, code `2982961`: FAIL (U2). No-go.

**The run that counts.** The first complete run of `patch.bench.ts` after
`2982961`, with the load average at 1.10 at start. It ran after
`npm run fixtures:large`, which left the manifest unchanged. W ran separately
afterwards, as the protocol names it.

| Id | Measure | Result, ms | Threshold | Verdict |
|---|---|---|---|---|
| W | wrong-site plans, 2 000 seeds, `wrongSite: 'fail'` | 0 (795 s) | 0 | pass |
| E | fresh engine p95: nodes-25/50/100 | 5.1 / 4.7 / 35.3 | ≤ 50 | pass |
| E | fresh engine p95: bytes-25/50/100 | 5.2 / 17.9 / 27.2 | ≤ 50 | pass |
| U1 | fresh end to end p95: nodes-25 / nodes-50 | 30.8 / 24.1 | ≤ 50 | pass |
| U2 | last keystroke → disk p95: nodes-25 / nodes-50 | **400.8 / 470.9** | ≤ 350 | **FAIL** |
| S | stale engine p95: nodes-25 / nodes-50 | 7.9 / 13.6 | ≤ 50 | pass |
| P | patch-variant candidates equal to a full reparse | 428 of 428 | all | pass |
| — | adapter surface | 70 / 9 / 28 / 4 | recorded | — |

**Recorded, not gated** (p95 unless marked):
- Fresh end to end on bytes-25/50/100: 117.2 / 192.6 / 443.2. Of the
  bytes-100 figure, protocol work at p50 is read 38.0, hash 33.7, verify
  52.9 and write 247.4.
- Stale engine on nodes-100: 339.2. On bytes-*: 51.9 / 119.2 / 229.9.
- Patch refusals: 9 of 428 candidates, all hosts inside `{…}`.

**Cause.** This was diagnosed after the verdict, in a run that timed nothing
and does not count.
- The keystroke series (seed 3) drew targets inside `{…}` expressions: at
  samples 13 and 14 on nodes-25, and at 9 and 13 on nodes-50.
- The patch refuses those hosts, so the pipeline falls back to a full
  reparse: 85 / 154 ms p50 on these fixtures.
- Two refused samples in 20 put a reparse at the nearest-rank p95, the 19th
  value. So U2 measures the fallback, not the patch.
- U1 passed on the same edge. Its series had 1 refusal in 30, and the p95 of
  30 is the 29th value.
- The engine is not the cost: the fresh end-to-end p95 is 24–31 ms. The
  refusal rate is. Across the 428 draws it was 2.1 %, but it was 10 % in
  each keystroke series.

**Consequences, per the rule:**
- Step 0's guarded legacy path remains the shipped write path.
- Step 5 does not start.
- The numbers do not move.

**Inputs for a revision B** (not decided here):
- **Take the fallback off the p95.** Extend the patch to hosts inside
  expressions. It needs its own argument from the JavaScript scanners (the
  header of `projection-patch.ts` names what they react to) and the same
  brute-force reference.
- **Measure how often real edits hit such hosts** on real pages. The
  fixtures' rate is a property of the generator, not of users.

**Found after the verdict and fixed separately:** `projectPage` asserted
instead of returning `parse-error` on text over `ipcFieldCharsMax` units but
under `sourceBytesMax` bytes. No fixture reaches that size, so it could not
affect any number above.

### Re-registered 2026-09-28 — revision B (owner's decision), before measurement

The owner chose revision B: extend the projection patch to hosts inside
`{…}` expressions, the one cause of revision A's failure.

**Thresholds: identical to revision A. No number, fixture or definition
moves.** W, E, U1, U2, S and P keep A's thresholds and fixtures. The harness,
the seeds, the sample counts, the void rule (load above 1.5 at start) and the
decision rule are all A's. A's failure stands in the record; B is a new
attempt, measured on new code.

Why nothing moves: A failed on the fallback path, not on a threshold that
was wrong. The reasons written for A (see above) still hold.

**Code under test.** The implementation commit that follows this one. Only
these land in it:
- The expression-host extension to `shared/projection-patch.ts`.
- Its argument, written in that module's header.
- Its brute-force reference: the fixture sweep, a seeded property test over
  generated pages with expressions, and the simulator's full-reparse
  comparison.
- A census script for real pages.

**Recorded, not gated:** a census of real pages. For every editable string
attribute site in the `.astro` files on the development machine, outside
`node_modules` and `test/`, it counts:
- the share of sites whose host is inside an expression;
- the share of sites the patch refuses, under A's rule and under B's rule.
Only aggregate counts are recorded; no file content or path is.

**Decision rule, unchanged.** Go only if W, E, U1, U2, S and P all pass on
the first complete run of `patch.bench.ts` after the implementation commit.
Otherwise the result is no-go: the legacy path stays, and nothing is
renegotiated.

### Revision B decision — 2026-09-28, code `3352742`: PASS. Go.

**The run that counts.** The first complete run of `patch.bench.ts` after
`3352742`, with the load average at 1.10 at start. It ran after
`npm run fixtures:large`, which left the manifest unchanged. W ran separately
afterwards.

| Id | Measure | Result, ms | Threshold | Verdict |
|---|---|---|---|---|
| W | wrong-site plans, 2 000 seeds, `wrongSite: 'fail'` | 0 (774 s) | 0 | pass |
| E | fresh engine p95: nodes-25/50/100 | 3.7 / 5.1 / 12.6 | ≤ 50 | pass |
| E | fresh engine p95: bytes-25/50/100 | 8.1 / 17.7 / 27.1 | ≤ 50 | pass |
| U1 | fresh end to end p95: nodes-25 / nodes-50 | 16.4 / 22.1 | ≤ 50 | pass |
| U2 | last keystroke → disk p95: nodes-25 / nodes-50 | 329.8 / 332.9 | ≤ 350 | pass |
| S | stale engine p95: nodes-25 / nodes-50 | 5.9 / 11.2 | ≤ 50 | pass |
| P | patch-variant candidates equal to a full reparse | 428 of 428 | all | pass |
| — | adapter surface | 70 / 9 / 28 / 4 | recorded | — |

**Recorded, not gated** (p95 unless marked):
- Patch refusals: 0 of 428. Revision A refused 9.
- Fresh end to end on nodes-100: 39.8. On bytes-25/50/100: 112.3 / 206.9 /
  422.7. Of the bytes-100 figure, protocol work at p50 is read 37.6, hash
  33.8, verify 51.3 and write 254.0.
- Stale engine on nodes-100: 22.9. On bytes-*: 55.1 / 115.0 / 198.2, mostly
  the diff plus the occurrence count. That is the stale-plan lever named in
  the proposal.
- Stale end to end, refresh included: 103.8 / 211.8 / 424.7 on nodes-*.
  Step 5 moves the refresh to the watcher tick.

**Real-page census** (`node test/simulator/census.bench.ts <roots>`, the
development machine's project directories). There are 254 distinct `.astro`
files; 292 duplicates were skipped, and every file parsed. They hold 3 851
editable string-value sites.

| Share of sites | Value |
|---|---|
| Host in markup | 58.4 % |
| Host in a condition or loop | 41.6 % |
| Falls back, `"New title"`, revision A | 41.8 % |
| Falls back, `"New title"`, revision B | 2.2 % |
| Falls back, `"/about/team?x=1"`, revision A | 41.8 % |
| Falls back, `"/about/team?x=1"`, revision B | 41.8 % |

- Real pages put far more edits in expressions than the fixtures do: 41.6 %
  of sites, against 2–10 % of draws. Revision A would have fallen back on
  almost half of real edits.
- Under B, a URL-like value in an expression host still falls back. `?` and
  `:` can split a ternary when the value sits in code mode (see the header of
  `projection-patch.ts`).
- On real pages a fallback is cheap. A full reparse per file takes 0.6 ms
  p50, 3.4 ms p95 and 21.9 ms max, against 85–154 ms on the fixtures the
  thresholds use.
- All 6 005 patches B made on real pages were equal to their full reparse.

**Correction to earlier evidence.** The proposal's size census (1 052 files:
median 1.6 KB, p95 15 KB, max 93 KB) counted duplicates. `/mnt/wslg/distro`
mirrors the WSL filesystem, and `/tmp` held test scratch copies. The distinct
set is 254 files: median 2.4 KB, p95 21 KB, max 92 750 B.
- The maximum is unchanged, so the reason given for U1 and U2 holds: nodes-25
  (176 KB) is still about 2× the largest real page.
- No threshold was set from the corrected figures.

**Consequences:**
- Step 4 is decided **go**, and step 5 is unblocked.
- The legacy path remains the shipped write path until step 5's actor
  replaces it. Nothing in this step ships to the app except the parser fixes,
  which have identical output.

**Carried into step 5** (from the proposal, §6, updated):
- **The splice log** for self-caused staleness. It closes the "BYTES CANNOT
  TELL" residual for the app's own edits.
- **The refresh on the watcher tick.**
- **How the renderer's `PageModel` updates without a reparse.** Otherwise the
  legacy reparse returns on the save path.
- **Deduplicate the full SHA-256 passes per intent.**
- **The stale-plan cost on bytes-*:** move the per-byte assertions in the
  occurrence count out of its hot loop.
- **Contingent, on telemetry:**
  - Code-mode-safe handling of `/ ? :` in expression hosts.
  - Context-extended uniqueness, if `anchor-ambiguous` is frequent.

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
`treeDepthMax`. Step 5 added `documentActorsMax` (512) and
`documentBytesRetainedMax` (64 MB): the host's actor count and retained
snapshot bytes. Step 6 added `undoEntriesMax` (100, the history bound, a
literal in `App.tsx` before), `commitLogEntriesMax` (16, commits the host
remembers per actor for exact rebases), `authoredSnapshotsMax` (16) and
`authoredBytesRetainedMax` (16 MB) (earlier snapshots per actor, so an edit
authored before an outside write can still be mapped). Step 7 added
`previewManifestFilesMax` (512, files one canvas rendering's manifest names),
`previewStampPathCharsMax` (1 024) and `previewMorphWorkMax` (4·10⁶ matrix
cells one canvas patch may spend); `previewMarkersMax` (step 1) now bounds the
stamps a frame reads and the markers a patched rendering may carry.

## Adapter surface (ratchet, scripted at step 1)

| Point | Mutations | Prop-index | `mutateModel(` | `applyEdit(` | replace-source |
|---|---|---|---|---|---|
| Hand, 2026-09-28 | 67 (47 in `App.tsx`) | 10 | 28 | 4 | — |
| Script, step 1 (baseline) | 70 | 9 | 28 | 4 | — |
| Script, step 3 (spike) | 70 | 9 | 28 | 4 | — |
| Script, step 5 | 70 | 9 | 28 | 4 | 23 (baseline) |
| Step 6, attribute `e964f57` | 67 | 4 | 25 | 4 | 23 |
| Step 6, prop `06bbc6c` | 67 | 4 | 25 | 4 | 23 |
| Step 6, insert/remove `e14012e` | 55 | 4 | 22 | 4 | 23 |
| Step 6, move `c07db4c` | 53 | 3 | 21 | 4 | 23 |
| Step 6, inline CSS `d49b426` | 53 | 3 | 21 | 4 | 23 |
| Step 6, frontmatter `6da4741` | 48 | 2 | 15 | 4 | 23 |
| Step 7 `a625992` (no gesture moved) | 48 | 2 | 15 | 4 | 23 |

Mutations: direct node-mutation sites in `src/`; prop-index: prop-index writes;
`applyEdit(`: the style panel's; replace-source: submission sites in
`electron/`. Step 6 says why prop and inline CSS left the surface unchanged.
`scripts/adapter-surface.ts` holds the last row as its baseline.

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
- **`lastKnownBytes` chaining** — closed at step 6 (2026-09-29): the renderer
  still sends no bytes; the host keeps a commit log per actor (exact rebases
  through its own commits) and up to 16 earlier snapshots (diff mapping across
  an outside write); an edit whose authored bytes are gone is refused. See
  Step 6. Earlier: decided at step 5 (2026-09-28): the
  renderer sends no bytes and the actor keeps its current snapshot only; a
  stale intent without its authored bytes is refused with its operation's
  stale reason. `Submission.authored` stays optional so the simulator (and
  step 6's visual gestures, if they carry bytes) can still map. The splice log
  for self-caused staleness is step 6's, when a mapped intent first ships.
  History: reopened by step 2 (2026-09-28). The
  actor commits a new snapshot per applied intent (§5.10), but mapping a stale
  intent needs the *bytes* it was authored against (`PlanningBase.authored`),
  not only compact preconditions (§3.1 says the latter). Decide at step 5, with
  the simulator's interleavings: which authored snapshots the actor keeps
  (bounded by `snapshotsRetainedMax`, today 2), or whether the renderer's
  last-known bytes travel with the intent (bounded by `intentPayloadBytesMax`).
  An intent whose authored bytes are gone rejects `anchor-moved`, as today.
  Spike data (Step 3): the authored snapshot was one actor snapshot old in
  59 % of stale decisions, two in 22 %, three or more in 12 %, never held by
  the actor in 7 %.
- **Undo semantics** — resolved 2026-09-28: drop page snapshots on external
  reload at step 0; inverse splices submitted as intents at step 6; snapshot
  history deleted at step 9. **Landed at step 6** (2026-09-29): edits entries
  revert on the engine and survive an outside reload, snapshot entries remain
  for gestures a whole-model save carried, property batches undo as inverse
  batches (Step 6, "Undo on the engine").
- **Keystroke → disk threshold** — resolved 2026-09-28: split into engine
  (≤ 50 ms) and last keystroke → disk (≤ 350 ms); see Thresholds.
- **Morph move-blindness** — confirmed at step 7 (2026-09-29): the patch is
  capped with an honest reload past the cap (§9), and a moved node patches
  without a reload into exactly the new rendering, its unmoved siblings the
  same live elements; the moved element itself is rebuilt, so its client state
  is lost. Carrying it would need the engine's move to reach the patcher — not
  built, no user report asks for it. `test/morph.js` pins the behaviour.
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

**In place since step 5** (`electron/documentTelemetry.ts`): one JSON line on
main's stdout per terminal outcome, backpressured submission, save-guard
conflict and leaked lock — `{"event":"stacki.document","file":<16 hex of
SHA-256(path)>,"intent":…,"outcome":…,"reason":…,"count":…}`, where `count`
is the running total for that outcome or reason. Pinned: no path, no bytes
(`test/document-actors.test.js`).

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

- 2026-09-28, step 3 (PROMPT-3), `46e9fc6` on top of `43c9739`:
  - `env -u ELECTRON_RUN_AS_NODE npm test` — **pass, 154/154 test commands in
    235.2 s, exit 0** (static checks: tsc, eslint 0 errors, `ratchet-check` 0,
    `adapter-surface` 70 / 9 / 28 / 4 at baseline). The first gate run failed
    `test:simulator` on a required tally that no longer exists after the
    judge's redesign (`rejected-gone`); the list was corrected, not the judge.
  - `npm run test:contracts` — **206/206**. `npm run test:simulator` —
    **36/36** (34 + the `Buffer` diff case + the known wrong-site case).
  - `npm run spike:editor-core` — the report in Step 3, one full run on an idle
    machine. An earlier run found a false wrong-site from the judge itself (an
    element whose attribute was rewritten counted as gone); the rule became
    "an element is its own `<` byte", and seeds 36 and 240 remained.
  - Fixtures regenerated with `npm run fixtures:large`; manifest unchanged.
  - Formatting: new modules through Prettier 3.9.9 (npx cache, as step 2);
    every added line ≤ 100 columns.

- 2026-09-28, step 4 (PROMPT-4), decision recorded on top of `b387086`; no
  source changed:
  - `npm run fixtures:large` then `npm run spike:editor-core` — one full
    re-run, exit 0: wrong-site 2 (seeds 36, 240, identical to step 3); every
    latency series FAIL; numbers in Step 4.
  - `node dist/scripts/adapter-surface.js` — 70 / 9 / 28 / 4, at baseline.
  - `env -u ELECTRON_RUN_AS_NODE npm test` — **pass, 154/154 test commands in
    232.7 s, exit 0.**
  - Every line of this file ≤ 100 columns (one step-0 line rewrapped).

- 2026-09-28, step 5 (PROMPT-5), `0411fe6` on top of `a881aee`:
  - `env -u ELECTRON_RUN_AS_NODE npm test` — **pass, 155/155 test commands in
    213.6 s, exit 0** (static checks: tsc, eslint 0 errors, `ratchet-check` 0,
    `adapter-surface` 70 / 9 / 28 / 4 and the new replace-source counter at
    its baseline, 23). A first gate run failed three commands (151/154): the
    harness loads main twice per process (the host install now replaces an
    idle host), and two tests pinned the watcher's text before the new hint.
  - `npm run test:contracts` **211/211**, `npm run test:simulator` **64/64**,
    `npm run test:platform` **12/12, 0 skipped** (ext4 and NTFS via WSL
    interop). `STACKI_SIMULATOR_SEEDS=2000 node --test
    test/simulator/simulator.test.ts` — green in 702 s, `wrongSite: 'fail'`.
  - Parallel run: `STACKI_LEGACY_DIST=<worktree at a881aee>/dist node
    test/legacy-parity.bench.js` — 213 of 213 gestures identical. The legacy
    build: `git worktree add --detach <dir> a881aee`, `node_modules`
    symlinked, `tsc -p shared/tsconfig.json` and `tsc -p
    electron/tsconfig.json` there. `test/save-latency.bench.js` against the
    same build, twice (before and after lazy projections), numbers in Step 5.
  - Formatting: new modules through Prettier 3.9.9 (npx cache, as step 2);
    every added line ≤ 100 columns.

- 2026-09-29, step 6 (PROMPT-6), `ff030a5`..HEAD on top of `ddda134`:
  - Commits: `ff030a5` (the planner plans every operation), `127b818`
    (`page:edit`, commit log, retained snapshots), `e964f57` (attribute),
    `06bbc6c` (prop), `e14012e` (insert/remove), `c07db4c` (move), `d49b426`
    (inline CSS), `6da4741` (frontmatter slots, loop rename), `4d62807`
    (simulator undo scenario), `d396033` (property inverse batch), `a3456ba`
    (outcome-gated class and rule), then the printer fix and this record.
  - `env -u ELECTRON_RUN_AS_NODE npm test` on every commit: **155/155**. Final
    run: **155/155 test commands in 220.0 s, exit 0** (tsc, eslint 0 errors,
    `ratchet-check` 0, `adapter-surface` 48 / 2 / 15 / 4 / 23 at its lowered
    baseline). Three commits needed a second run for source-pinning tests that
    followed code into new modules (`test:frontmattermove`, `test:slotmove`,
    `test:selfwrites`) or a fake main without an undo token
    (`component-properties-panel`); each second run is the one recorded.
  - Suites: `test:simulator` 82/82 (with `operations.test.ts`, 18 tests: seven
    corpus sweeps, each candidate parsing and its inverse restoring the input);
    `test:contracts` 221/221 (with `page-edit.test.ts`, 11 end-to-end tests
    through main's handlers); `test:roundtrip` 470/470 (with
    `page-edits.test.js` and `gesture-parity.test.js`: 3 933 gestures, all the
    same page, 2 078 byte-identical).
  - Long run: `STACKI_SIMULATOR_SEEDS=2000 node --test
    test/simulator/simulator.test.ts` — green in 14 min 49 s, `wrongSite:
    'fail'`, every seed twice. A first long run failed at seed 38: the undo
    judge flagged a revert whose bytes had been rewritten, identical, by a later
    edit; the planner was right, and the judge now fails only a revert that
    hits a copy while the edit's own bytes survive elsewhere (Step 6).
  - Formatting: new modules through Prettier 3.9.9 (npx cache, as step 2);
    every added line ≤ 100 columns.

- 2026-09-29, step 7 (PROMPT-7), `2fa3f0f`..HEAD on top of `5af4177`:
  - Baseline at `5af4177` before any change: `env -u ELECTRON_RUN_AS_NODE npm
    test` 155/155 in 230.3 s.
  - Commits: `2fa3f0f` (capabilities; repeated nodes edit their source),
    `3af4dbd` (stamps, token, `preview:check`, the gate), `a625992` (capped
    patch, honest reload), `28bb8bb` (suites that load the patcher or drive the
    canvas), then this record.
  - The first gate run on `a625992` failed four commands (151/155): three
    suites lifted or bundled the patcher without the bounds main now prepends,
    one pinned the plugin's old load line, and two app suites sent canvas
    events without a token (`28bb8bb` says how each was fixed). Second run:
    **155/155 test commands in 204.8 s, exit 0** — tsc, eslint 0 errors (115
    warnings, the baseline's count, after `28bb8bb` pulled `startOutlines` back
    under 70 lines), `ratchet-check` 0, `adapter-surface` 48 / 2 / 15 / 4 / 23.
    Final run on `28bb8bb` plus this record: **155/155 in 220.0 s, exit 0**,
    115 warnings.
  - Suites: `test:contracts` 232/232 (with `preview-bridge.test.ts`, 8 tests:
    the real generated config over a temporary project, stale-token rejection
    both ways through the real handler); `test:simulator` 82/82;
    `test:roundtrip` 482/482 (with `node-capability`, `preview-gate`,
    `preview-token-frame`, and `gesture-parity`: 4 207 gestures, all the same
    page, 2 083 byte-identical); `test:morph` 61 checks (the caps, stamp sync,
    the moved node).
  - Long run: `STACKI_SIMULATOR_SEEDS=2000 node --test
    test/simulator/simulator.test.ts` — green in 14 min 51 s, 2/2 tests,
    exit 0.
  - Formatting: new modules through Prettier (`--print-width 100
    --single-quote`, which every file this step touched and that was clean
    before still passes); every added line ≤ 100 columns.

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