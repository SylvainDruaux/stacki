# Stacki Editor Core — Consolidated Implementation Plan

**Status: adopted, re-verified against the code 2026-09-28 (HEAD `6c2f1a2`).** The
TypeScript migration is complete (2026-09-16); this plan is the next workstream. It merges the
diff-mapping plan with the strongest engineering from an independent architectural proposal
(expected-bytes witnesses, the atomic write protocol, the capability model, the event
simulator) and rejects that proposal's shell rewrite and stored identity mapper (§12).

**Sequencing: guard first, then the core.** Step 0 (§11) closes the live overwrite bug on the
legacy path with a checksum guard and an atomic write. Steps 1–10 then build the engine on top of
the same checksum token. Step 0 is also the fallback if the step-4 threshold decision fails.

Every claim about current code carries a `file:line` so the next review can re-verify it. No
claim about the new engine is verified until its step's gate passes (§10, §15).

## 1. Decision

The editor core is a **source-editing engine with a visual client**. The file on disk is the
only persisted state. The engine holds, per open file, one immutable snapshot: the last-known
bytes, their checksum, and a disposable projection. A UI edit is an intent referencing a span in
the last-known bytes. At apply time the engine maps that span through a diff from last-known to
current bytes and splices the edit at the mapped position. Ambiguous mapping or a missing node
is a typed rejection, never a guess.

Identity is resolved at use time by one pure function. No stored identity layer. No version
counter. No fingerprints kept between edits.

## 2. Architecture

```
external edit ──┐
                ▼
        ┌───────────────┐    push    ┌──────────────┐
        │ file on disk  │ ─────────► │ projection   │ ──► renderer
        │  (Layer 0)    │            │  (Layer 1)   │      (Layer 3)
        └───────▲───────┘            └──────────────┘
                │ atomic write
        ┌───────┴───────────┐
        │ document actor (2)│  one per canonical file
        └───────▲───────────┘
                │ intents (bounded queue)
            renderer (visual UI / code editor / preview bridge)
```

- **Layer 0 — Source.** The `.astro` file, plus the files a save writes beside it (§5.1). The
  only artifact. Owned by the write protocol.
- **Layer 1 — Projection.** Pure function `bytes → Projection`, repackaging
  `electron/astroParser.ts`. Raw spans cover everything unmodeled. No API regenerates a whole
  file from a model once step 9 lands (§11).
- **Layer 2 — Document actor.** One per canonical file. Reads, resolves, plans splices with
  witnesses, applies in memory, re-parses the candidate, writes atomically, verifies, commits a
  new snapshot. Returns one typed outcome per intent. The bounded intent queue lives here.
- **Layer 3 — Renderer.** Owns interaction state only: selection, hover, trail — each a node
  reference resolved at use time. A compat adapter translates legacy gestures during
  migration, then dies.

The watcher is a hint, not an authority. The actor trusts a direct disk read before writing,
never watcher ordering.

## 3. Data model

### 3.1 Snapshot — the only source-derived state

```ts
interface Snapshot {
  readonly path: FilePath;          // shared/brand.ts
  readonly checksum: Digest;        // SHA-256 of the exact bytes; introduced at step 0
  readonly bytes: ByteString;       // retained: writes copy untouched bytes exactly
  readonly projection: Projection;  // disposable, derived
}
```

No `version` field: the checksum already answers "which file is this?". Snapshots are
immutable; a new one replaces the old. Only the current snapshot and the compact authored
preconditions of pending intents are retained.

### 3.2 Offsets, spans and encoding

```ts
type ByteOffset  = Brand<number, 'ByteOffset'>;
type Utf16Offset = Brand<number, 'Utf16Offset'>;
```

**Today:** the parser records node `start`/`end` as JS string indices (UTF-16) and only when
called with `locs: true` (`electron/astroParser.ts:882-887`, `:1162`). **Attributes carry no
spans at all** — `Attr` is `{ type, value }` (`shared/page-node.ts:12-16`). Splices need exact
attribute name and value spans, so step 1 adds them (§11). Conversion between UTF-16 and bytes
lives in one function; mixing the two is a compile error.

**Parser decision: extend the hand-rolled `electron/astroParser.ts`.** It already owns
source-preserving round-trip. `@astrojs/compiler` is a dependency, but its attribute-value
positions are unusable here: `electron/propertyRename.ts:181,204` recovers them with `indexOf`.
**Span integrity** is a contract property from step 1: for every node and attribute in every
corpus and large fixture, slicing the source at the reported span reproduces the reported text.

Encoding contract, pinned at step 0: files are read and written as UTF-8; line endings
round-trip untouched (already true: `astroParser.ts:1177`, `:1296-1299`); a leading BOM is
detected and preserved (**today it breaks frontmatter detection**: the regex at
`astroParser.ts:1173` requires `^---`); invalid UTF-8 is a typed error, never a lossy
replacement. Unicode, BOM and CRLF fixtures are mandatory corpus members.

### 3.3 Intents — immutable commands with witnesses

```ts
interface Intent {
  readonly id: IntentId;
  readonly file: FilePath;                // canonical path; the actor is per-file
  readonly authoredChecksum: Digest;      // the bytes this intent was authored against
  readonly anchor: AnchorRef;             // span + structural path + expected kind
  readonly operation: Operation;          // closed union, see below
}
```

Operations (initial): `SetAttribute`, `RemoveAttribute`, `InsertNode`, `MoveNode`,
`RenameBinding` (multi-span), `SetInlineStyle`, `ApplyCodePatch` (code editor),
`EditFrontmatterSlot`. New operations extend the union; they never extend a writer.
Step 6 added `RemoveNode` (the list had no removal) and `RevertSplices` (Undo's
inverse of an applied outcome: not a code patch — it keeps a parsing file parsing,
and a stale one is a moved region, not a merge).

**Migration-only operation: `ReplaceSource`.** A whole-file replacement whose anchor is the
whole-file span and whose witness is `authoredChecksum` itself. From step 5 the legacy save path
submits `ReplaceSource` through the actor instead of writing directly, so **the actor is the only
writer from step 5 on** (§5.2). Without it, steps 5–8 have two writers on one file: an
unguarded legacy save clobbers actor splices, and a guarded one conflicts with the app's own
commits. Step 9 deletes it; the adapter-surface ratchet counts its call sites.

Intents are multi-span from the start: a loop rename touches many scattered spans, and
`stripLostBindings` changes node kinds. The shipped operation set is **single-file**: one actor,
one terminal result.

**Multi-file gestures** (page + stylesheet) are composed in the UI as ordered, dependent
intents. Across files there is no shared byte range, so the dependency is outcome-gated, not a
witness: the dependent intent is submitted only after the prior one returns `applied`, and it
carries only its own file's witness. If the precondition fails, the UI cancels the dependent
intent before submission. A mid-sequence failure surfaces per-file outcomes, never a fabricated
atomicity. Multi-file scenarios run in the simulator from step 1; the shipped orchestration
lands only when a real gesture needs it.

Two multi-file writes exist today, and the rule covers both:

- **Chunk files** (`.html`, written by `writeChunks`, `electron/main.ts:2973`) are documents
  with their own actors. A page save that touches chunks becomes ordered per-file intents with
  per-file outcomes.
- **`component:editProperties`** (`electron/componentProperties.ts`) is the one named
  multi-file **batch** (decided 2026-09-28). A prop rename rewrites the definition and every
  consumer; splitting it into dependent intents could leave the site half-renamed and the build
  broken, so it keeps check-all-then-write with rollback. Hardening by step:
  - Step 0: rollback verifies each file still holds the bytes Stacki wrote before restoring it
    (today it restores blindly, `:253-276`); a read-back mismatch becomes a `write-race` result
    plus rollback, not an `assert` (`:249`) — a race is an expected failure, not an invariant.
  - Step 5: the batch runs through each file's actor, acquired in sorted canonical-path order so
    two batches cannot deadlock, with each file's `before` checksum as its witness; the file
    bound stays `PROPERTY_LIMITS.filesMax`.
  - Step 6: the batch becomes undoable as an inverse batch against current checksums.
  Rollback remains best-effort, not atomic: a crash mid-batch can leave files mixed, and the
  `rollback` error names them. The product requirements say so.

### 3.4 Splices — the only write primitive

```ts
interface Splice {
  readonly range: ByteSpan;
  readonly expectedBytes: ByteString;     // witness
  readonly replacementBytes: ByteString;
}
```

The writer verifies `expectedBytes` at the resolved range before applying. Changing
`title="Old"` to `title="New"` splices `Old` only; the tag is never regenerated. Attribute
insertion is a zero-width point plus a witness range around it. A move relocates the original
byte slice; it never prints the node again.

**The witness guards staleness, not identity.** `<Hero title="Old" />` beside
`<Footer title="Old" />` holds identical bytes at both ranges, so a splice at the wrong range
passes the witness. Identity comes from unique anchor resolution with rejection on ambiguity
(§4); the witness then proves the resolved range still holds the authored bytes. Neither guard
substitutes for the other. The simulator's oracle scenarios (§10) therefore assert the exact
target range, not merely the node kind.

### 3.5 Submission and outcomes — typed and total

Submission and terminal results are separate types: backpressure is not rejection.

```ts
type SubmissionResult =
  | { readonly tag: 'accepted'; readonly intentId: IntentId }
  | { readonly tag: 'backpressured' };  // the draft stays in the persistence layer

type Outcome =
  | { readonly tag: 'applied'; readonly intentId: IntentId;
      readonly changedRanges: readonly ByteSpan[]; readonly checksum: Digest }
  | { readonly tag: 'rejected'; readonly intentId: IntentId; readonly reason: RejectionReason }
  | { readonly tag: 'uncertain'; readonly intentId: IntentId;
      readonly candidateChecksum: Digest | undefined };

const REJECTION_REASONS = [
  'anchor-moved', 'anchor-ambiguous', 'region-externally-modified', 'source-invalid',
  'unsupported-operation', 'resource-limit', 'write-failed', 'write-race', 'merge-conflict',
] as const;
type RejectionReason = (typeof REJECTION_REASONS)[number];
```

A full queue returns `backpressured`; the persistence layer holds the values and resubmits
(§7). An accepted intent is terminal: `applied`, `rejected`, or `uncertain`. The actor never
retries; a rejected intent needs a deliberate user resubmission. `SetAttribute` is idempotent,
so its reconciliation is a checksum comparison; insert and move are not, and §5 covers them.

**Crash semantics, narrowed.** "Every accepted intent reaches one terminal result" holds while
the actor can still report. A crash between the atomic replace and the verification read leaves
the edit possibly on disk with no result delivered: that is `uncertain`, carrying the
deterministic candidate checksum. On reconnect, comparing the current checksum to the candidate
resolves to "applied", "not applied", or "changed again — review required". No durable intent
journal; reconciliation is a comparison, not a guess. The step-5 platform suite tests it.

### 3.6 Invalid source — a first-class projection state

Visual intents require the candidate to parse (§5). The code editor and external writers must be
able to persist temporarily invalid bytes, so the projection is a sum:

```ts
type Projection =
  | { readonly tag: 'valid'; /* nodes, capabilities, ranges */ }
  | { readonly tag: 'parse-error'; readonly diagnostics: readonly Diagnostic[] };
```

Code-editor patches may write invalid bytes atomically; the projection becomes `parse-error`;
visual intents reject with `source-invalid`; the UI offers the code editor and Astro's own error
output. Visual editing resumes once the file parses again. The bytes live in the snapshot, not
duplicated in the projection.

## 4. Identity: resolved at use time

A node reference is a span in last-known coordinates plus a structural path. Resolution is
`(lastKnownBytes, currentBytes, ref) → resolved | ambiguous | gone`, computed by mapping the span
through the diff between the two byte strings.

- Renderer handles (selection, hover, trail, focus) resolve through the same function when
  used.
- No ids are stored between snapshots: no mapping table, no tombstones, no fingerprint rules.
- Session restart re-resolves everything from bytes. Identity written into `.astro` files is
  permanently rejected.
- The mapper never falls back to "the third matching `<div>`". **Ambiguity is a rejection** —
  the load-bearing wall the witness (§3.4) depends on.

**Today.** Parser ids are `n<N>` from a module-global counter, regenerated on every parse
(`astroParser.ts:83-89`); renderer-created nodes are `c<N>` (`src/App.tsx:207`). Since commit
`3686761`, `src/modelAdoption.ts` carries session ids onto a fresh parse by position where kind,
name and child shape agree. That is a positional heuristic of exactly the kind this section
forbids for edit targeting. It is acceptable only as UI keying (it keeps editor focus across
saves, issue #29) and **must never feed an intent anchor**. Step 9 deletes it. The preview
already addresses nodes by index path (`data-avb-p`, `App.tsx:3829-3830`), not by id.

## 5. Write protocol

### 5.1 What one save writes today

`page:write` (`electron/main.ts:3067`) serializes the whole model (`serializePage`,
`astroParser.ts:1274`), writes `.html` chunk files (`writeChunks`, `main.ts:2973`), then the page
through `writePageText` (`main.ts:3034`) with plain `fs.writeFileSync` — no disk comparison, no
temp file, no fsync. Pages with a `<style>` block are written again after 150 ms
(`STYLE_NUDGE_MS`, `main.ts:3031-3064`). While the page is dirty the watcher handler drops
external changes (`src/App.tsx:1636`), so **a pending save silently overwrites an external
edit.** Step 0 closes this. From step 5 all three writes go through actors: the page and its
style re-write through the page's actor, each chunk through its own (§3.3).

A second write path already exists: `component:editProperties`
(`electron/componentProperties.ts`) checks a whole-file expected source (`:60`, `:232`) and
writes through temp-file-plus-rename with preserved mode (`:309-328`). It is the precedent for
step 0's helper.

### 5.2 Per-intent protocol (step 5)

1. Read the file (bounded by `LIMITS.sourceBytesMax`). If its checksum differs from the
   snapshot's, parse and build a new snapshot. If a newer disk version arrived while parsing,
   discard the parse; never commit an older snapshot over a newer one.
2. Resolve the anchor against current bytes. Ambiguous or gone → reject.
3. Plan splices with witnesses.
4. Verify every witness against current bytes.
5. Apply splices in memory (descending offset, non-overlapping — asserted).
6. Re-parse the candidate; assert it parses and the target keeps its expected kind.
7. Take an advisory lock where available; re-read under it; verify checksum and witnesses again.
8. Write a temp file in the same directory, fsync, rename over the target.
9. Re-read the target; verify the checksum.
10. Commit the new snapshot; return `applied`.

**The planner is pure.** Steps 2–6 are `planIntent(snapshot, intent) → Result<readonly
Splice[]>` plus an in-memory apply and reparse: no I/O, no clock, no randomness. Only the actor
touches disk (steps 1 and 7–10). The simulator calls the planner directly, which makes invariant
9 (§10) hold by construction rather than by care.

**One writer per file.** From step 5 nothing writes a page, chunk, or stylesheet except its
actor; legacy saves arrive as `ReplaceSource` (§3.3). Every `applied` outcome carries the new
checksum, and the persistence layer adopts it as the next baseline, so the app never conflicts
with its own writes.

**Honest limit, a product contract.** A byte check cannot close the kernel check-to-use race
against an uncooperative writer; no portable API offers compare-and-swap on a pathname. Stacki
promises: it never knowingly applies an intent to stale bytes, never silently remaps an anchor,
and reports `write-race` where the OS cannot guarantee atomicity. This belongs in the product
requirements.

**Every "current" claim names its token.** A resolved range is current by its witness; a
committed snapshot by its checksum; a preview by its preview token (§9); a crash window by its
candidate checksum. A "current" claim without a token is a bug waiting for a name.

## 6. Capabilities, not silent fallbacks

```ts
const CAPABILITIES = [
  'editable', 'read-only-opaque',
  'repeated-source-node',  // one source node, many runtime instances
  'runtime-aggregate', 'unsupported',
] as const;
type Capability = (typeof CAPABILITIES)[number];
```

Initially visual-editable: native elements, component invocations, literal attributes, simple
expression attributes with exact ranges, same-file inline styles, direct child moves, scalar
props. Initially code-only: spread attributes, dynamic prop objects, `set:html`, generated lists,
conditionally repeated nodes, multi-root components, external CSS rules without their own actor,
edits that need frontmatter or import rewrites.

A loop has one source node and many rendered elements. Clicking one rendered item never mints
an identity for a runtime instance: the UI targets the source loop node or marks the region
non-addressable. The fallback is visible, never silent.

**Scope: `.astro` only.** `shared/page-node.ts` also models Markdown and MDX, and `page:write`
branches to `serializeMarkdownPage` (`main.ts:3069`). Step 0 guards every page type — the
checksum guard is format-agnostic. Steps 1–8 target `.astro`; Markdown and MDX pages save through
`ReplaceSource` until step 10 gives them spans and operations (§11). Step 9 therefore
deletes `serializePage` as an `.astro` write path only.

## 7. External writers and the persistence layer

Watcher events coalesce to a dirty flag; intermediate file states do not matter because current
bytes are the truth. One read and one parse per tick. An external editor's change becomes new
bytes, the snapshot rebuilds, and pending intents resolve against it or reject. The code editor
already shares the page save path (`changeCodeSource`, `App.tsx:1552`); at step 8 it submits a
byte diff through the same actor, and overlapping external changes produce a visible
`merge-conflict`, never an overwrite.

**Coalescing replaces the debounce.** A burst within one (file × operation) stream — a slider
drag — folds into one intent. A gesture spanning operations is several streams and several
intents; the actor never merges and never retries.

**Owner: the persistence layer**, successor to `createPageSaver` / `createFileSaver`
(`src/pagePersistence.ts`). It owns coalescing, the `backpressured` hold-and-resubmit, and a
short renderer-side flush timer so a user who goes idle mid-burst still reaches disk. The actor
never sees a timer.

**Typing batching is policy, not engine latency.** Text edits wait 300 ms before saving
(`src/App.tsx:414-422`, reason at `:1498-1507`) because every save costs the preview a server
re-render, a full-page fetch, and a DOM diff (`electron/morphClient.ts:675,785`). The engine is
measured from submission (§11 step 4); the batching window is added on top and owned here.

**Rejection UX contract** (applies from step 0 for `conflict`): a rejected write never destroys
the user's input. The panel keeps the submitted values. The rejection renders as a non-blocking
notice naming the reason. Resubmission, and "reload from disk" (which discards local edits), are
deliberate user acts, never automatic. No modals mid-typing.

**Save state is a union, not a flag** (from step 0). Today it is `dirty?: boolean`
(`src/pagePersistence.ts:10`), which cannot say "the last save was refused":

```ts
type SaveState =
  | { readonly tag: 'clean'; readonly checksum: Digest }
  | { readonly tag: 'dirty'; readonly baseChecksum: Digest }
  | { readonly tag: 'saving'; readonly baseChecksum: Digest }
  | { readonly tag: 'conflicted'; readonly baseChecksum: Digest; readonly diskChecksum: Digest };
```

While `conflicted`, autosave stops — otherwise every edit retries, conflicts again, and piles
more work onto a stale base. Edits still apply locally. Only "Reload from disk" (→ `clean`) or
"Review in code" (→ `dirty` against the disk checksum once the user accepts a merged text)
leaves the state. The step-0 tests pin every transition, including the refused ones.

## 8. Limits

Every bound lives in `shared/limits.ts` (today: tree size and depth, attribute and value
lengths, scan sizes, schema sizes, `rescanChainMax`, `saveDrainMax`, IPC field length).
`MAIN_LIMITS.sourceBytesMax` (10 MB, `electron/main.bounds.ts:8`) merges into it at step 1.
Added at step 1: max pending intents, max intent payload bytes, max splices per intent, max diff
work, max parse tasks in flight, max retained snapshots, max watcher work per tick, max preview
markers. Exceeding a limit returns `resource-limit` (or `backpressured` at submission). The
system never grows a drain cap, retries forever, or reduces fidelity to cope.

## 9. Preview

The project's own Astro dev server stays the rendering authority, in an iframe. Today Electron
starts `astro dev` with a generated config (`writeMarkerConfig`, `main.ts:3657`) whose Vite
plugin injects source markers in memory via `serializePageMarked`, and `electron/morphClient.ts`
morphs the canvas instead of reloading on Vite full-reload messages.

Target: a marker carries a **preview token** — a digest over the sorted dependency manifest of
the rendering chain (page, imported components, layouts, stylesheets, content, config). A
preview event is accepted only if the source and dependency state that produced it are still
current, so a component edit invalidates the token even when the page's bytes are unchanged.
Nodes with unreliable runtime-to-source mapping are read-only. No marker that could change
observable project behavior is ever written into the project. Morph updates the canvas from a
projection diff, capped by a limit; past the cap the preview reloads honestly.

## 9a. Telemetry — is the wall holding?

One counter and one structured log line: rejection counts by reason (and `conflict` counts from
step 0), with the intent id and a hashed file path — raw paths leak usernames. No source bytes
in logs. The simulator proves the mapper under its corpus; the rejection distribution is the
production signal for everything the corpus misses. Read the three priorities into it: safety
(rejections by reason), performance (intent→applied percentiles against §11 step 4),
developer experience (adapter surface trending down). No pipeline, no dashboard, no dependency.

## 10. Simulator — the corpus, generalized

A deterministic simulator drives the real parser, span mapper, intent planner, and writer.
Scenarios come from the corpus (`test/corpus/`, 33 `.astro` fixtures today), hand-written edge
cases (duplicate siblings, whitespace and comment variants, malformed intermediates, repeated
and conditional templates), and seeded interleavings of: visual intents, external manual edits,
AI-style rewrites, git-style atomic replacements, watcher ticks, parse completions, preview
events, code-editor saves.

After every operation, assert:

1. Every accepted intent reaches one terminal result.
2. Every applied splice matched its expected bytes.
3. Bytes outside splice ranges are unchanged.
4. No anchor resolves to the wrong node kind.
5. Ambiguous anchors never apply.
6. A stale preview cannot submit a silently remapped edit.
7. The actor never commits an older snapshot over a newer one.
8. Queue, parser, diff, and snapshot bounds hold.
9. The same seed produces the same results.

**Determinism is structural.** The actor runs as pure steps under a deterministic scheduler — no
real timers, no OS async, disk I/O behind an interface the simulator fakes. Randomness is a
hand-rolled seeded PRNG in the test tree (no fast-check: zero new dependencies). Invariant 9 is
decorative the moment anything real sneaks in.

**Oracle scenarios sit beside the invariants.** The nine invariants are self-consistency; they
cannot catch a planner that derives the wrong splice from a correct mapping. A small set of
hand-built files — a moved node, a duplicated block, a deep restructure — carries hand-derived
expected splices whose targets are unambiguous to a human.

**Every fast path has a brute-force reference.** Diff shortcuts, cached diffs, a future
incremental reparse, any lookup index: each ships beside a slow, obviously correct version, and
the simulator asserts both agree on every scenario. A fast path without a reference is a failed
gate.

**Large fixtures.** The corpus maxes out at 2.7 KB (`test/corpus/why-a-loop-exists.astro`), too
small to measure step 4. A deterministic script generates named fixtures from corpus pieces at
about 25 %, 50 % and 100 % of `sourceBytesMax` and `treeNodesMax`, and records their sizes; the
step-4 thresholds are registered against them.

The simulator fakes I/O, so it proves the actor's state machine, not the write implementation. A
**platform integration suite** at step 5 covers real filesystems: temp-file mode and ownership,
fsync semantics, directory durability, Windows replace semantics, symlinks, antivirus and
indexer interference, cooperating writers, and crash-between-replace-and-verify (`uncertain`).
It pins symlink policy and canonical paths on case-insensitive filesystems.

Tests run on `node --test` (the repo has no vitest). Small exhaustive interleavings run in the
gate; large seeded runs run nightly. Type-level tests (brand separation, exhaustiveness) are
tsc-checked files using `@ts-expect-error`.

## 11. Implementation sequence

Gate green at every step (`env -u ELECTRON_RUN_AS_NODE npm test`). Zero new dependencies.
Ratchet counts only decrease.

0. **Overwrite guard on the legacy path.** Small, shippable, independent of steps 1–10.
   - `page:read`, `page:write` and `page:writeRaw` results carry `checksum`: SHA-256 hex of the
     bytes read or written (`node:crypto`). Parsed in `shared/ipc-results.ts` as exactly 64
     lowercase hex characters.
   - `page:write` / `page:writeRaw` payloads carry `baseChecksum` (`shared/ipc-payloads.ts`).
     Main re-reads the file and returns `err({ code: 'conflict' })` on mismatch without writing.
   - Extract `writePropertyFile` (`componentProperties.ts:309-328`) into
     `electron/atomicWrite.ts`: same-directory temp file, `wx`, preserved mode, fsync, rename,
     cleanup on failure, `Result` return. Page, chunk, style re-write, and component-properties
     writes all use it. The style re-write compares checksums instead of strings.
   - Renderer: the `SaveState` union (§7) replaces `dirty?: boolean`. On `conflict`, enter
     `conflicted`, stop autosave, keep the model, and show the §7 notice with "Reload from
     disk" and "Review in code". The watcher's dirty-page branch (`App.tsx:1636`) surfaces the
     conflict instead of dropping it silently.
   - Applies to every page type: `.astro`, Markdown, MDX, and raw pages.
   - Fix BOM detection and preserve the BOM on write (§3.2).
   - Undo: the watcher hot-reload path (`App.tsx:1600-1671`) calls `dropPageHistory`
     (`:1417`), as `openFile` and `reloadFromDisk` already do. Today Undo after an external
     reload writes an old snapshot and silently reverts the external edit — the guard cannot
     see it, because the undo is authored against the current checksum.
   - `component:editProperties`: checked rollback and `write-race` result (§3.3).
   - Markdown/MDX: `.md` and `.mdx` fixtures (headings, lists, fences, CRLF, BOM, MDX JSX
     blocks) with byte-exact parse→serialize round-trip tests. The parser claims them
     (`electron/markdownParser.ts:25`); none exist.
   - Tests: payload and result parsers reject bad checksums; an external edit between read and
     write yields `conflict` with disk bytes unchanged; a failed atomic write leaves no temp
     file; every `SaveState` transition, including autosave staying off while `conflicted`;
     BOM + CRLF fixtures round-trip; an external reload leaves no page snapshot to undo into;
     a property batch whose written file was changed externally is reported, not restored.
1. **Contracts, spans and simulator skeleton.** `shared/intent.ts`, `shared/ref.ts`,
   `shared/snapshot.ts`, the capability model, rejection reasons, limits (§8), fixture corpus.
   Contract tests first. The parser emits **attribute name and value spans**, and the
   span-integrity property (§3.2) runs on every corpus and large fixture. The large-fixture
   generator (§10) lands here. The corpus carries the hard intent classes from day one: multi-span
   (loop rename), kind-changing (strip bindings), multi-file (stylesheet), frontmatter slots.
   The simulator skeleton lands with the determinism constraint (§10). New projection types live
   in a module whose name cannot collide with `shared/page-node.ts`, which remains the wire
   model until step 9. `scripts/adapter-surface.ts` measures the adapter surface with a written
   grep method and runs in the gate as a ratchet. A lint rule confines
   `serializePage` / `serializeNodes` to the legacy writer boundary.
2. **Diff and mapping.** `diff.ts`, `mapSpan.ts`, `SetAttribute` only. Evaluate whether the line
   diff in `electron/conflicts.ts:54` generalizes before writing a new one.
3. **Spike.** Intent → map → witness check → splice → reparse → reproject, against the
   simulator's seeded scenarios. Record mapping correctness, reproject-plus-diff latency, and the
   adapter surface. Measured 2026-09-28 by hand: 67 direct node-mutation sites (47 in
   `App.tsx`), 10 prop-index writes, 28 `mutateModel` and 4 `applyEdit` call sites; the step-1
   script replaces this estimate.
4. **Threshold decision.** Zero wrong-site applications; adapter count recorded; on the named
   large fixtures (§10): **intent→applied p95 ≤ 50 ms** (the engine) and **last keystroke→disk
   p95 ≤ 350 ms** (300 ms typing batch + 50 ms). Re-registered 2026-09-28 from ≤ 150 ms, with
   the reason in §7: the batch window protects the preview and is policy, not engine cost. After
   the spike starts, the numbers may not move. Fail → keep step 0's guarded legacy path, report,
   and stop.
   **Decided 2026-09-28: fail.** Revised the same day by the owner (option A of the tracker's
   step-4 revision proposal), before measurement. Changes:
   - Wrong-site plans are gated at 2 000 seeds.
   - "Engine" means planning, splicing and projection. The §5.2 disk work and the snapshot's
     SHA-256 are protocol work. They are recorded, not gated: they cost more than 50 ms on the
     bytes-* fixtures before any engine code runs.
   - End-to-end intent→applied ≤ 50 ms and keystroke→disk ≤ 350 ms remain, on nodes-25 and
     nodes-50.
   - Stale engine ≤ 50 ms applies on those two fixtures.
   Definitions, reasons, the harness and the decision rule are in the tracker, Thresholds.
   Revision A failed on keystroke→disk: hosts inside `{…}` fell back to a full reparse.
   **Revision B** (the same thresholds; the projection patch extended to hosts in conditions
   and loops) **passed every threshold on 2026-09-28: go.**
5. **Actor and write protocol.** Bounded queue, §5.2 protocol on `atomicWrite.ts`,
   external-writer handling, one actor per chunk file. **Single writer:** the legacy save path
   submits `ReplaceSource` through the actor from this step on (§3.3); a test proves no code
   path outside the actors calls `atomicWrite` for a page, chunk, or stylesheet. Platform suite.
   `component:editProperties` runs through the actors as a batch in sorted path order (§3.3).
   Single-gesture parallel run with parity checks against the legacy path, including it.
   **Landed 2026-09-28** (tracker, Step 5). Decided there: the host steps each intent to its
   outcome synchronously; the lock is a lock file (Node has no portable `flock`); a replace
   whose directory cannot be flushed is `uncertain`; snapshots derive projections on first
   read; the renderer sends no authored bytes, so a stale `replace-source` is refused, never
   mapped. The single-writer rule covers every write of project text, not only pages.
6. **Gesture expansion.** Attribute → prop → insert/remove → move → inline CSS → frontmatter
   slots. Stylesheet intents follow §3.3 once a real gesture needs them. **Undo on the engine:**
   every `applied` outcome records its inverse splices (same ranges, expected and replacement
   bytes swapped); Undo submits them as an intent against the post-apply checksum, so a file
   changed since maps through the diff or rejects like any edit. Inverse splices replace
   full-model snapshots; the stack bound moves to `LIMITS.undoEntriesMax` (100, today's cap).
   The property batch gains its inverse batch. Adapter surface shrinks monotonically; new
   features enter through intents only.
   **Landed 2026-09-29** (tracker, Step 6): the planner plans every operation; the six
   gestures reach disk as edit requests (`page:edit`, stated against the page the renderer
   shows and translated by main); the host rebases an edit exactly through its own recent
   commits and maps one across an outside write; Undo reverts on the engine; property
   batches undo as inverse batches; a class's stylesheet rule waits for the page edit.
   Adapter surface 70 / 9 / 28 → 48 / 2 / 15. Gestures with no operation (text, tag
   renames, paste) keep the whole-model save until their operations exist.
7. **Capabilities and preview bridge.** Visible read-only fallbacks, preview token, stale-token
   rejection, capped morph.
   **Landed 2026-09-29** (tracker, Step 7). Decided there: a node a loop repeats is addressed as
   its one source node and accepts visual intents (an edit changes every copy; nothing is placed
   beside it); a stale intent whose node changed capability is refused. The token is the SHA-256
   of the sorted manifest of per-file stamps — each marked file's checksum, emitted by its own
   compiled module, so a component edit restamps the rendering; main checks every stamp against
   the disk before a click selects. The patch is capped by `previewMarkersMax` and
   `previewMorphWorkMax`, handed to the patcher at the bridge boundary, and past either reloads
   with its reason. Adapter surface unchanged at 48 / 2 / 15 / 4 / 23.
8. **Code editor on the actor.** Diff-based patches, `parse-error` projections,
   `merge-conflict` surfacing.
9. **Deletion.** Compat adapter, `shared/editor-model.ts`, the `WeakMap` acks in
   `src/pagePersistence.ts`, version counters (`changeVersion`, `codeEditVersionRef`), `n<N>` and
   `c<N>` ids, `src/modelAdoption.ts`, `PageSnapshot` and the snapshot branch of `AppHistory`,
   `ReplaceSource` for `.astro` (Markdown and MDX keep it until step 10, §6), whole-file
   `serializePage` as an `.astro` write path — plus three
   cases the actor dissolves: `electron/selfWrites.ts` (the actor's own write is a tick whose
   read matches the committed checksum), `saveDrainMax` (the bounded queue replaces drains), and
   `rescanChainMax` (one read plus one parse per tick). End state: snapshots, projections,
   intents, splices.
10. **Markdown and MDX on the engine.** The markdown parser (`electron/markdownParser.ts`) gains
   node and attribute spans with the span-integrity property; its gestures move to intents;
   `ReplaceSource` and `serializeMarkdownPage` retire as write paths. Same gate and simulator
   rules as steps 1–6, run against the step-0 markdown fixtures.

## 12. Contingent upgrades and rejected options

- **Fingerprint verifier** (one lazy hash of the mapped node's slice): built only if the
  simulator ever produces a wrong-site application.
- **Incremental reparse** (reparse only the regions a splice touched) and **cached diffs**: built
  only if a step-4 latency threshold fails, each with a brute-force reference (§10).
- **Preview throttle**: throttle refreshes in the `avb-morph` Vite plugin
  (`electron/main.ts:5203`) so the typing batch can shrink without more re-renders. Built only if
  users report save lag while typing.
- **Diff-mapping deferral**: rejected. Step 0 makes every disk change a `conflict`; mapping is
  what turns most of those into applied edits, and the step-4 gate decides whether it holds.
- **Document service** (version-counter protocol, AI as peer client): promoted only if a one-day
  sketch shows the parser's query surface fits a service boundary. ⇧⌘C (`App.tsx:2579`) covers
  the legibility goal until then.
- **Rejected permanently.** Identity written into `.astro` files (violates the source contract).
  Whole-file regeneration as the steady-state write path (violates fidelity). Shell rewrite: the
  engine boundary is language-independent, and swapping Electron mid-migration buys nothing the
  boundary does not already give.
- **Reviewed and rejected (2026-09-28)**, from an external architecture chat:
  - Spatial indexes (R-tree, R*-tree, BSP, blockmap, GiST). The browser owns geometry: canvas
    hit-testing is `elementFromPoint` in the preview (`electron/preload.ts:1524`), mapped to
    source through index-path markers. The projection holds no bounds, and adding them would
    mean syncing a second layout engine — a new source of staleness.
  - B-tree and B+-tree node indexes. In memory a `Map` or array index is O(1); siblings are
    `children[i ± 1]`; tree depth is capped at `LIMITS.treeDepthMax`.
  - Data-oriented node decomposition (hot, warm, cold arrays). Hundreds of small objects per
    file; the split adds a sync problem and no measured win.
  - SpacetimeDB reducer and subscription protocols. The pure planner (§5.2) and the capped
    projection-diff morph (§9) already take what applies.
- **Superseded.** The earlier `LiveModel` + version-counter recommendation.

## 13. Reconciled against the codebase (2026-09-28)

Confirmed: the write path re-serializes the whole file and can overwrite external edits
(§5.1); writes are not atomic; `Result`, `assert`, `Brand` and `LIMITS` exist in `shared/`.

Corrected from the previous draft:

- `shared/projection.ts` does not exist; there is no collision to rename away.
- The parser has no attribute spans; node spans are UTF-16 and opt-in (§3.2).
- Ids partly survive reparse through `modelAdoption.ts` (§4).
- Adapter surface measured at 67 + 10 (+ 32 wrapper call sites), not ~123 + ~15 (§11 step 3).
- The existing ratchet (`scripts/ratchet-check.ts`) counts only `@ts-nocheck`; the adapter
  ratchet is new work.
- Saver acks are a `WeakMap`, not a `WeakSet`.
- One save writes the page, chunk files, and a delayed style re-write (§5.1).
- The BOM bug is live (§3.2).
- The keystroke→disk threshold conflicts with the 300 ms typing delay (§11 step 4).
- The "anchor plan" fallback was never on file; step 0 replaces it.
- Steps 5–8 would have run two writers on one file; `ReplaceSource` makes the actor the only
  writer (§3.3, §5.2).
- Page saves and `component:editProperties` already write several files; §3.3 now covers both.
- Markdown and MDX pages share `page:write`; §6 scopes them out of steps 1–8.
- The corpus had no large file for the step-4 thresholds; §10 adds generated fixtures.
- Undo after a watcher hot reload reverts the external edit (§11 step 0).
- Property-batch rollback restores blindly, and a read-back race asserts instead of rolling
  back (§3.3).
- The markdown round-trip tests its parser header claims do not exist (§11 step 0).
- Found by the step-0 fixtures and fixed there: a CRLF Markdown page with a multi-line
  frontmatter gained a CR per frontmatter line on every save.

## 14. Honest risks and open decisions

- **The simulator is the arbiter.** Low corpus diversity is a failed gate, not a passed one.
- **The diff is the safety margin.** Its conservatism is judged by the simulator, not assumed.
  `max diff work` exhaustion surfaces as a typed rejection or a read-only downgrade, never a
  silent fidelity loss.
- **Steady-state cost** per edit is one file-scale diff plus one in-memory splice and reparse.
  The step-4 numbers decide; cache diff results if they fail.
- **Staleness is looser than fingerprints**: some edits apply that fingerprints would reject.
  The simulator informs whether that trade holds.
- **`write-race`** is a designed admission of an OS limit; product requirements must carry it.
- **`modelAdoption.ts`** is a positional heuristic until step 9. Guard: it keys UI only, never
  anchors.
- **Batch rollback is best-effort.** A crash mid-way through a property batch can leave files
  mixed; the `rollback` error names them. Product requirements carry it (§3.3).
- **Typing batching is policy.** Shrinking the 300 ms window multiplies preview re-renders; the
  preview throttle (§12) is the lever, not the engine.
- **Markdown and MDX keep whole-file regeneration until step 10**, guarded against overwrites
  from step 0.

Decided 2026-09-28: keystroke→disk split into engine and batch numbers (§11 step 4); the
property batch hardened, not split (§3.3); undo as inverse splices, with snapshots dropped on
external reload now (§11 steps 0, 6); Markdown and MDX guarded now, engine at step 10.

## 15. Standing rules

AGENTS.md is normative. Gate green per step. Behavior preservation proven by parity. Verify
before claiming: each step's owner runs the gate and the simulator and records the result, with
the commit sha, in `docs/editor-core-tracker.md`. Commit per workflow. Improve only touched code.
