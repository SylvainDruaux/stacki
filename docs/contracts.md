# Stacki contract surface

The modules in `shared/` define the data that Electron and the renderer may
exchange. Code inside either process may rely on these types only after a value
has passed through the matching parser. Raw IPC replies, file contents,
`JSON.parse` results, browser messages, and drag payloads remain `unknown` until
that boundary check succeeds.

## Page trees

`shared/page-node.ts` is the canonical page model for Astro, Markdown, and MDX.
`parsePageNode`, `parsePageTree`, `parsePageModel`, and `parsePageReadResult`
enforce these invariants:

- Node ids are unique within a tree, and nothing keys on them across
  snapshots (plan §4). The Astro parser's ids are structural paths — `n0`,
  `n0.2.1` — assigned once a tree is complete, so a parse is a pure function
  of its text; Markdown's are `m<N>` until step 10. `layout` names the layout
  wrapper. The renderer carries its own handles from one parse to the next by
  span mapping (`src/nodeHandles.ts`): `s<16 hex>.<path>` for a node first
  seen in that snapshot, `g<32 hex>` for a node a gesture created.
- `text`, `expr`, `raw-line`, `comment`, and `raw` nodes are leaves.
  Components and elements may use `children: null` only when self-closing.
  Branches, loops, conditions, and chunk groups always carry child arrays.
- Attribute variants are `string`, `expr`, `bare`, or `spread`. The value field
  exists only on variants that need it.
- Import slots, attribute order, original tag text, line endings, blank lines, Markdown
  fences, list markers, indentation, and trailing blanks are source-preserving
  data. A parse/write round trip must retain them even when the editor does not
  display them.
- Every tree, depth, attribute collection, import list, string, and Markdown
  metadata collection is bounded by `shared/limits.ts`.

The renderer edits a `structuredClone` through `shared/editor-model.ts`. That
module is the sole constructor for the mutable mirror; IPC and disk contracts
remain readonly.

## IPC

`shared/ipc-payloads.ts` is the channel-to-payload inventory and
`shared/ipc-results.ts` is the channel-to-result inventory. `shared/preload-api.ts`
maps the public preload method names to those channels. A new or changed channel
must update all three files and add known-good and malformed cases under
`test/contracts/` or the renderer boundary's focused test.

Electron handlers call `parseIpcPayload` before using input. Renderer modules do
the same before invoking preload and parse every reply before returning it to a
component. Shared parsers cover common records; feature boundary modules such as
`src/appBridge.ts`, `src/historyBridge.ts`, and `src/terminalBridge.ts` preserve
only the fields their consumers use while still validating nested values and
bounds.

Expected operating failures use `Result` or an explicit result union. A shape
that violates the declared wire contract is a programmer error and throws at
the boundary. Do not catch that assertion and turn it into an operating result.

## Page saves

`shared/page-save.ts` is the save contract (plan §11 step 0). `page:read` and
`page:write` results carry `checksum`: the SHA-256 of the exact bytes read or
written, as 64 lowercase hex characters (`Digest` in `shared/brand.ts`, built
only by `toDigest`). The write payload carries `baseChecksum`, the checksum the
edit was authored against. (`page:writeRaw`, the code editor's whole-text save,
was retired at step 8: see Code editor below.) Main re-reads the
file first and, if it no longer holds those bytes, returns
`{ ok: false, error: { code: 'conflict', diskChecksum } }` without writing. A
deleted file is `missing`, never a conflict; `filesystem` and `write-race`
cover the rest, `uncertain` is a write that may have landed and could not be
verified (plan §3.5), and `backpressured` a full actor queue (the edit was
never accepted). The renderer keeps the edits unsaved on every code but a
conflict, and the next save names the same base. The renderer's `SaveState`
union (`src/saveState.ts`) turns a conflict into `conflicted`: autosave stops,
the edits stay, and only "Reload from disk" or a reviewed "Save this version"
leaves that state.

Since step 5 every write of project text — page, chunk, style re-write,
stylesheet, code window, CMS and asset edits, component-property batches — is
an intent to the file's document actor (see Document actors below), which
writes through `electron/atomicWrite.ts`: a same-directory temporary file
(`wx`, the target's mode and owner, fsync), one rename, a directory fsync, then
the actor's own read-back, which reports another writer as `write-race`.
Encoding: files are UTF-8; page reads decode strictly (invalid
UTF-8 is an error, never a lossy replacement); line endings round-trip
untouched; a leading byte-order mark is read past by the parsers and restored
by the model writers.
`page:serialize` returns the text a model write would produce, for reviewing
unsaved edits in code. `test/fixtures/round-trip/` holds the byte-exact
Astro, Markdown and MDX fixtures (CRLF, BOM) the save path must reproduce.

## Editor core (plan steps 1–5)

The contract layer of `docs/stacki-editor-core-plan.md`, since step 2 the
diff, the span mapper and the pure planner, and since step 5 the document
actor. The app submits one operation so far: the migration-only
`replace-source`, from every legacy writer.

- `span.ts` — `ByteSpan` and `Utf16Span` over the branded `ByteOffset` and
  `Utf16Offset` (`brand.ts`); mixing them is a compile error. The only
  conversion is `utf16ToByteOffsets` (one linear pass; an offset inside a
  surrogate pair asserts). `ByteString` is a private copy of a file's bytes,
  always a plain `Uint8Array` — never a Node `Buffer`, whose `slice` is a view
  (a `Buffer` from `fs.readFileSync` is copied, not aliased);
  `decodeUtf8` is strict and returns `invalid-utf8` instead of replacing.
- `ref.ts` — `AnchorRef`: a byte span, a structural path of `ChildIndex`es, and
  the expected kind (a page-tree kind, `frontmatter`, or `document`). Node
  anchors have a path; the other two do not; a document anchor starts at 0.
- `intent.ts` — `Intent` (id, file, `authoredChecksum`, anchor, operation), the
  closed `Operation` union (including the migration-only `replace-source`),
  `SubmissionResult` (`accepted` | `backpressured`), the terminal `Outcome`
  (`applied` | `rejected` | `uncertain`) and the nine `REJECTION_REASONS`, each
  with notice text. `parseIntent` checks every anchor/operation pairing,
  multi-span sites (inside the anchor, ascending, disjoint, at most
  `splicesPerIntentMax`) and the summed UTF-8 payload.
- `capability.ts` — `editable` | `read-only-opaque` | `repeated-source-node` |
  `runtime-aggregate` | `unsupported`; `editable` and (since step 7)
  `repeated-source-node` accept visual intents: a node a loop repeats is one
  source node, and an edit of it changes every copy. Nothing is placed beside
  it (the loop body is code), and a stale intent whose node changed capability
  since it was authored — wrapped in a loop outside Stacki — is refused
  `region-externally-modified`. The renderer shows every other capability
  beside the selection (`src/nodeCapability.ts`, `CapabilityNotice`).
- `source-projection.ts` — the `Projection` sum (`valid` with byte-addressed
  nodes, paths, attribute spans and capabilities, and the text's UTF-16 length,
  which the parser bounds; or `parse-error` with bounded diagnostics). Named so
  nothing in it can be confused with the `page-node.ts` wire model. `.astro`
  only until step 10; stylesheets project as opaque documents.
- `snapshot.ts` — `createSnapshot` computes the checksum from the bytes through
  an injected hash (the renderer has no `node:crypto`) and asserts the
  projection measured the same bytes. There is no version field.
- `diff.ts` (step 2) — `diffBytes(source, target, budget)`: Myers' O(ND) byte
  diff run in both directions, so `distanceBefore` / `distanceAfter` give the
  prefix and suffix edit distance of any grid point; `diffHunks` prints one
  minimum script. Budget: `LIMITS.diffWorkMax` (byte comparisons plus frontier
  cells) and `LIMITS.diffDistanceMax` (frontier memory); exhaustion is the
  typed `too-costly`, never a partial diff.
- `mapSpan.ts` (step 2) — `mapSpan(lastKnown, current, span, budget)` →
  `resolved` (every minimum edit script keeps the span whole at one place) |
  `gone` (none keeps it whole) | `ambiguous` (they disagree) | `too-costly`.
  Decided from two columns of the span; `test/simulator/reference-diff.ts`
  checks every column and the suites assert they agree.
- `planner.ts` (step 2) — `Splice`, `Plan`, and the pure
  `planIntent({ authored, current }, intent)` → `Result<Plan, RejectionReason>`.
  Plans `set-attribute` only: it maps the element's name-through-last-attribute
  region through the diff and splices the mapped value, with the authored value
  as its witness; `ambiguous` → `anchor-ambiguous`, `gone` → `anchor-moved`,
  `too-costly` → `resource-limit`. Since step 5 it also plans `replace-source`:
  one whole-file splice witnessed by the authored bytes, never mapped (stale →
  `region-externally-modified`). Other operations are `unsupported-operation`
  until their steps. Equal checksums skip the diff; `planIntentThroughDiff` is
  that fast path's reference.
- `splice.ts` (step 5) — `witnessesHold`, `applySplices`, `changedRanges`:
  the one implementation of the write primitive, shared by the actor and the
  simulator.
- `documentActor.ts` (step 5) — the actor as pure steps (idle → planned →
  written → idle, plan §5.2) over an injected `DocumentDisk` (read, advisory
  lock, atomic replace), planner and `Projector`. `submitIntent` answers
  `accepted` or, at `intentsPendingMax`, `backpressured`; every accepted intent
  reaches one `Outcome`; a replace whose directory could not be flushed, or
  whose read-back fails, is `uncertain` with the candidate checksum;
  `reconcileUncertain` resolves one by comparison. The actor never retries and
  never merges. `createLazySnapshot` (`snapshot.ts`) derives a projection on
  first read.

The parser (`parsePage(text, { locs: true })`) reports `start`/`end` on every
node — branches and inline-run gap spaces included — and `attrSpans` on every
tag: the whole attribute, its name and its value, in UTF-16 offsets.
`parsePageNode` validates them against the node's range and its props record.
The span-integrity suite (`test/contracts/span-integrity.test.ts`) slices every
node and attribute of every corpus, round-trip, editor-core and large fixture
and requires the reported text back, in UTF-16 and in bytes.

Every bound lives in `limits.ts`, including `sourceBytesMax` (merged up from
`electron/main.bounds.ts`) and the engine bounds of plan §8.

Fixtures: `test/fixtures/editor-core/` is the hostile corpus (loop rename,
kind-changing move, page + stylesheet, frontmatter slot, identical siblings,
BOM/CRLF/astral text, conditionals, a malformed page), each with a
hand-written `*.expected.*` output; `test/simulator/oracles.ts` holds the
hand-derived splices. `test/fixtures/large/manifest.json` pins the generated
large fixtures (`npm run fixtures:large` writes the files).

The simulator (`test/simulator/`, `npm run test:simulator`) drives the real
parser, the planner and a step-wise actor over a fake disk with a seeded PRNG,
and checks the nine invariants after every event. The actor plans
`set-attribute` with `shared/planner.ts` (mapped through the diff when stale)
and the other operations with the step-1 reference planner; each queued intent
carries the snapshot it was authored against. Every stale `set-attribute`
decision is judged against byte origins the simulator records for every writer
(`provenance.ts`, `remap-judge.ts`): a wrong-site plan fails the run. Its
`diff`, `map-span` and `planner` suites hold the step-2 modules to their
brute-force references and to hand-derived byte ranges.
`STACKI_SIMULATOR_SEEDS=<n>` raises the seed count for a long run;
`npm run spike:editor-core` prints the step-3 spike report (not in the gate).

Lint fences (`eslint.config.mjs`): `serializePage`, `serializeNodes` and
`serializeMarkdownPage` may be imported or called only inside the legacy writer
boundary (`electron/astroParser.ts`, `main.ts`, `markdownParser.ts`,
`componentFile.ts`) and tests. The simulator core (all but its `*.test.ts` and
`*.bench.ts` entry points and the `*.entry.ts` modules they import) and the
engine contract modules may not use timers, clocks, promises, `Math.random`,
`process` or I/O modules. `scripts/adapter-surface.ts` runs in the gate as a ratchet on the
legacy tree-mutation surface (method in its header).

## Visual edits (step 6)

`page:edit` carries an `EditRequest` (`shared/edit-request.ts`): a gesture in
the terms of the page the renderer shows — node references are the path, kind
and UTF-16 range of its parse — against that parse's checksum. Main turns it
into an intent (`electron/editRequests.ts`: references checked against its own
projection, ranges converted to bytes, new nodes and the frontmatter block
printed, loop-rename sites found) and the page's actor plans and writes
splices. The reply (`shared/page-save.ts`, `parsePageEditResult`) is the page
as written and the inverse hunks Undo sends back as a `revert` request; a
refusal is `rejected` with the actor's reason and the checksum on disk. An edit
authored before the actor's own recent commits is rebased exactly
(`shared/rebase.ts`); one authored before an outside write is mapped through the
diff from a retained snapshot; one whose bytes are gone is refused. Every
operation is planned (`shared/planner.ts`, `planTree.ts`, `planText.ts`,
`planSupport.ts`, `loopScope.ts`, `inlineStyle.ts`); `remove-node` and
`revert-splices` joined the union. `page:read` reads through the page's actor.

Property batches are undoable: `component:editProperties` answers with an undo
token, and `component:revertProperties` applies that batch's inverse — every
file checked against the bytes the batch left — and answers with the redo
token. Main keeps the batches; the renderer holds tokens only.

The renderer's half (`src/pageEdits.ts`, `src/editGestures.ts`) and the gesture
parity suite (`test/gesture-parity.test.js`) are described in the tracker,
Step 6.

## Code editor (step 8)

The code editor saves through `page:edit` too: a `code-patch` edit carries the
byte diff from the text it read (named by `authoredChecksum`) to the text it
holds, as ascending, disjoint hunks `{ span, expected, text }` of those bytes
(`shared/code-patch.ts`, `diffCodePatch`; the wire parser in
`shared/edit-request.ts` checks the shape and bounds). Main checks every hunk
against the named bytes — inside them, on code-point boundaries, holding
`expected` — and submits `apply-code-patch`. The patch may leave the page
invalid (plan §3.6): the reply is then `editable: false`, and visual edits are
refused `source-invalid` until a later patch makes it parse. Bytes past
`intentPayloadBytesMax` are refused `resource-limit` (the renderer's diff
refuses them first); a stale patch maps through an outside edit with context
or is refused `merge-conflict`, as is one whose bytes the host no longer holds
or whose witness does not hold; behind the app's own commits it rebases only
where no commit touched a hunk (`shared/rebase.ts`, `shiftUntouched`). Code
patches apply to `.md` and `.mdx` pages too. The renderer's side
(`src/codeEdits.ts`, the `code` queue in `src/pageEdits.ts`) is described in
the tracker, Step 8.

## Preview bridge (step 7)

The canvas is the project's own dev server in an iframe. Its source markers
exist only in memory: the generated preview config's Vite plugin hands Astro
`electron/previewMarkers.ts`'s marked copy of each `.astro` file under `src`,
and that module reads and returns strings — it writes nothing, and no app
module imports it (`test/contracts/preview-bridge.test.ts` holds both, and runs
the real generated plugin over a project whose bytes it compares before and
after). The generated config itself lives in `node_modules/.avb`.

- `preview-token.ts` — every marked file also carries one stamp,
  `<!--avb-d:<sha256>:<project-relative path>-->`, for the exact bytes it was
  marked from. The frame collects a rendering's stamps into a manifest (sorted
  by path, one entry per file, at most `previewManifestFilesMax`; one file with
  two checksums is no manifest) and its token is the SHA-256 of
  `canonicalManifest`. The frame announces `avb:render` `{ token, stamps }`;
  `avb:hover-node`, `avb:click-node` and `avb:open-node` carry `token` (null
  until the digest is known). `parsePreviewRender` and `parseStampData` reject
  forged shapes: page code can write any comment.
- `preview:check` `{ projectPath, render }` → `PreviewVerdict`: main re-derives
  the token from the manifest, then reads every stamped file from disk
  (`electron/previewCheck.ts`; a path outside the project is `missing`, a file
  past `sourceBytesMax` changed) and answers `current` or `stale` with one of
  `PREVIEW_STALE_REASONS`.
- The renderer (`src/previewGate.ts`) accepts a click or double-click only when
  the event's token is the frame's latest, the open file's stamp is the bytes
  the editor shows (the clean checksum, or the origin while unsaved edits keep
  every path), and main answers `current` — judged again after main answers. A
  refusal is a notice; nothing is selected. Hover needs the latest token only.
  Markdown and MDX pages carry no stamp until step 10.
- The canvas patch (`electron/morphClient.ts`) is bounded by
  `previewMarkersMax` markers per rendering and `previewMorphWorkMax`
  child-list matrix cells per patch; main prepends `AVB_PREVIEW_LIMITS` from
  `shared/limits.ts` to the source it serves. Past either the page reloads and
  first posts `avb:preview-reload` `{ reason }` (`markers-over-cap`,
  `diff-over-cap`, `scripts-changed`, `patch-failed`); the app shows the caps.

## Document actors (step 5)

`electron/documentActors.ts` hosts one actor per canonical file in the main
process and steps each submission to its outcome before returning (main's
handlers run one at a time; the queue bound still holds). `documentWrites.ts`
installs the process's host and is the only entry point for writing project
text: `writeProjectText` (witnessed by the bytes on disk now; a missing file is
created) and `createProjectText` (never overwrites). `page:write` submits
`replace-source` witnessed by the renderer's `baseChecksum`; each chunk file has its own actor; `component:editProperties`
leases its files' actors in sorted canonical order and witnesses each by its
`before` checksum, with the checked rollback as intents too.
`documentDisk.ts` is the real disk: bounded reads, a lock file beside the
target (dead or old owners broken), the atomic replace, exclusive creation,
and canonical keys (directory identity plus the name, case-folded where a probe
shows the directory ignores case). Bounds: `documentActorsMax`,
`documentBytesRetainedMax`, `intentsPendingMax`, `parseTasksInFlightMax`,
`watcherFilesPerTickMax`. Telemetry (`documentTelemetry.ts`, plan §9a): one
JSON line per outcome, backpressure, save-guard conflict and leaked lock, with
a running count, the intent id and a 16-hex-character path hash — never a path
or source bytes.

Proofs: `test/contracts/single-writer.test.ts` inventories every file-writing
call in `electron/` against a reasoned allowlist and pins one owner each for
the write primitives, the disk and the host; `test/platform/` runs the write
protocol on real filesystems and processes (modes, ownership, flush order,
symlinks, continuous readers, cooperating writers, crashes between replace and
verify, NTFS replacement semantics and case-insensitive names where a Windows
filesystem is reachable); `test/legacy-parity.bench.js` is the parallel run
against the pre-step-5 build (not in the gate; it needs that build).

## Other shared contracts

- `brand.ts` constructs `NodeId`, `FilePath`, `ProjectPath`, `Digest`,
  `ByteOffset`, `Utf16Offset`, and `IntentId` after validating the primitive value.
- `scan.ts` validates project pages, layouts, components, schemas, and scan
  collection limits.
- `prop-schema.ts` validates component field schemas and their nested options.
- `frontmatter.ts` validates import members and source slots.
- `boundary.ts` supplies bounded primitive, list, dictionary, and data parsers.
- `result.ts` defines the expected-failure channel.

## Required gate

Run `env -u ELECTRON_RUN_AS_NODE npm test` before merging. The gate cleans and
rebuilds `dist/`, compiles Electron, preload, and shared contracts, builds the
renderer, runs strict `tsc --noEmit`, ESLint, the migration ratchet, and every
`test:*` command. Generated JavaScript belongs only in `dist/`; source folders
must contain TypeScript and source assets.

The builds run in order; `tsc --noEmit`, ESLint and the two ratchets
(`ratchet-check`, `adapter-surface`) then run side by side, and the test
commands run in a bounded pool (`scripts/test-pool.ts`, default one fewer than
the CPUs, `npm test -- --jobs=<n>` to change it,
`--jobs=1` for a serial run). A passing command prints one line; a failing one
prints its full output. `test:contracts` runs first and alone because it
rebuilds `dist/shared`, which the others read. `test:hovercost`,
`test:popoverdropdown`, `test:selectorwell` and `test:thumbs` run last and
alone because they measure timing, depend on read ordering, or drive a real
window. A new test must write only to its own scratch path under
`node_modules/.stacki-test/` (or a `mkdtemp` directory) and bind no fixed
port, so it can share the pool.
