# Architecture consolidation — what changed and how to work with it

**Branch:** `refactor/architecture-consolidation`, 183 commits on top of `main` at `cbd5168`.
**Audience:** everyone who works on Stacki, from your first week to the person who reviews the
editor core. Read the first two sections whatever your level; after that, follow the reading
path for what you are about to do.

The diff is large (about 1,170 files), but most of it is files moving and splitting. The
behaviour that changed is smaller and is listed in full here. This page explains each change in
plain terms first, then gives the detail and links to the documents that own it.

---

## 1. The short version

Stacki is a visual editor for Astro projects. Its users also edit the same files by hand and
with AI assistants, so **the file on disk is the source of truth, never the app's own model.**
This branch makes that promise hold, and makes the codebase easier to change safely:

1. **Saving works differently.** The app no longer rewrites a whole file when you change one
   thing. It sends a small, precise edit ("replace these bytes with those"), checks that the
   file still holds what it expects, and refuses rather than overwrites if someone else changed
   it. ([§3](#3-change-1--how-saving-works-now))
2. **The code has a map.** Files moved from flat folders into layers and feature folders, and
   the tests now mirror the source tree. ([§4](#4-change-2--where-code-lives))
3. **The rules in `AGENTS.md` are enforced by machines.** The same checks run when you edit,
   commit, push, and in CI, for people and for coding agents alike.
   ([§5](#5-change-3--the-rules-are-checked-for-you))
4. **No more giant files.** The largest files (up to 8,900 lines) were split; no source file
   may now exceed 800 lines, and no function 70. ([§6](#6-change-4--smaller-files))
5. **Faster app and faster test loop**, plus several user-visible style-panel bugs fixed.
   ([§7](#7-change-5--performance-and-the-test-loop), [§8](#8-bugs-fixed-along-the-way))

## 2. What you need to do differently

If you read nothing else, read this list.

- **Find files with the directory map**, not your memory of `main`. `src/App.tsx` is now
  `src/app/App.tsx`, panels live in `src/features/<feature>/`, and so on. See
  [§4.3](#43-where-did-my-file-go).
- **Never write project files directly.** Every change to a user's file goes through that
  file's *document actor* as an edit. A static test fails the build if anything else writes.
  See [§3.4](#34-rules-of-thumb-for-everyday-work).
- **Expect the hooks to stop you.** Editing a file runs Prettier, the policy scan and ESLint on
  it. Fix what they report; do not work around them, and never use `--no-verify`.
- **Before you finish, run `npm run check:changed`.** The full gate is
  `env -u ELECTRON_RUN_AS_NODE npm test`. While iterating,
  `env -u ELECTRON_RUN_AS_NODE npm test -- <suite>` runs one suite in seconds.
- **Put new tests where the source is.** A suite for `src/features/style/` goes in
  `test/renderer/style/`; for `electron/parse/`, in `test/electron/parse/`.
- **Some files need a human's approval to change**: `AGENTS.md`, `CLAUDE.md`, lint and
  compiler configs, `scripts/{eslintPlugin,policy,agent}/`, the hook configs and
  `shared/core/limits.ts`. Agents are stopped when they try to edit these.

### Reading paths

| You are… | Read |
|---|---|
| New to the codebase | §1–§4, then [`docs/codebase.md`](codebase.md) top to bottom |
| Building a feature or fixing a bug in a panel | §2, §3.1–§3.4, §4, §9 |
| Touching saving, parsing, IPC or the engine | All of this page, then [`docs/contracts.md`](contracts.md) and [`docs/stacki-editor-core-plan.md`](stacki-editor-core-plan.md) |
| Reviewing this branch | §10, then the tracker [`docs/editor-core-tracker.md`](editor-core-tracker.md) |
| Changing tooling, lint rules or gates | §5, then [`docs/enforcement.md`](enforcement.md) |

---

## 3. Change 1 — how saving works now

### 3.1 The problem it solves

On `main`, saving a page worked like this: the app held the whole page as a tree in memory,
you changed the tree, and the app **printed the whole file again** from the tree and wrote it to
disk. Two things went wrong with that:

- **Lost work.** The write never checked what was on disk. If you, a teammate or an AI assistant
  edited the file while Stacki had an unsaved change, Stacki's autosave silently overwrote it.
- **Unwanted churn.** Reprinting a file risks changing parts the user never touched, which shows
  up as noise in their git history and, at worst, changes what the page does.

### 3.2 The idea, in one paragraph

Think of a shared document with *suggested edits*. Instead of sending back a whole new copy, the
app sends "at this spot, where the text currently reads `X`, put `Y`." Before applying it, the
file's owner checks that the spot still reads `X`. If it does, the edit lands and nothing else in
the file moves. If someone changed that spot in the meantime, the edit is refused with a reason
and the user decides what to do. Nothing is ever silently overwritten.

That is the whole design. The rest is making it exact, fast and impossible to bypass.

### 3.3 How a visual edit reaches disk

```
 Renderer (src/)                         Main process (electron/)
 ───────────────                         ────────────────────────
 user drags, types, picks a style
        │
        ▼
 gesture → edit request                  page:edit
 (src/editor/editGestures.ts)  ───────────────────────►  edit request → intent
                                                          (electron/documents/editRequests.ts)
                                                                 │
                                                                 ▼
                                                          the file's document actor
                                                          (shared/engine/documentActor.ts)
                                                           1. read the file, check its checksum
                                                           2. plan splices (engine/planner.ts)
                                                           3. apply them in memory, re-parse
                                                           4. write atomically, read back
                                                                 │
 install the reply: new page,  ◄────────────────────────────────┘
 node handles carried across,      reply: the page as written,
 Undo = the inverse splices        plus the inverse splices (for Undo)
 (src/editor/pageSender.ts)        — or a typed refusal
```

The pieces, in the order an edit meets them:

- **Gesture** — what the user did, in the renderer.
- **Edit request** (`shared/engine/editRequest.ts`) — the gesture stated against the exact
  version of the page the user was looking at, identified by its **checksum** (a SHA-256 of the
  file's bytes).
- **Intent** (`shared/engine/intent.ts`) — main's version of the request, with positions turned
  into byte offsets. The operations are a closed list: `set-attribute`, `insert-node`,
  `move-node`, `remove-node`, `apply-code-patch`, `rewrite-text`, `revert-splices` and others.
- **Document actor** — exactly one per open file, and **the only thing allowed to write project
  text.** It processes one intent at a time from a bounded queue.
- **Splice** (`shared/engine/splice.ts`) — "replace bytes *a*–*b* with this text." Each splice
  carries a **witness**: the bytes it expects to replace. A witness that does not match is a
  refusal, not a guess.
- **Atomic write** (`electron/documents/atomicWrite.ts`) — write a temporary file beside the
  target, flush it, rename it over the target, flush the folder, then read it back. A crash
  leaves either the old file or the new one, never half of each.

What the user can get back, besides success (`shared/ipc/pageSave.ts`):

| Outcome | Meaning | What the app does |
|---|---|---|
| `rejected` | The bytes the edit targets changed on disk | The page turns *conflicted*: autosave stops, every local edit is kept, and the user picks "Reload from disk" or "Review in code" |
| `missing` | The file was deleted | Never recreated behind the user's back |
| `write-race` | Another program wrote the file during our write | Reported, not hidden |
| `uncertain` | The write may have landed but could not be verified | Reported with the checksum it would have produced |
| `backpressured` | The actor's queue is full | The edit was never accepted; the renderer keeps it and retries |
| `filesystem` | Any other disk error | Reported |

The renderer tracks this with a small state machine, `SaveState` in `src/editor/saveState.ts`:
`clean`, `dirty`, `saving`, `conflicted`. It replaces the old `dirty` boolean.

**Edits made while the file changes underneath.** If the actor itself wrote the file since the
edit was authored, the edit is shifted exactly past those writes (`shared/engine/rebase.ts`). If
someone else wrote it, the edit's position is mapped through a diff of the two versions
(`shared/engine/diff.ts`, `mapSpan.ts`). If the mapping is ambiguous, or the target is gone, the
edit is refused.

**The code editor** uses the same path: it sends the byte diff between the text it read and the
text you typed (`shared/engine/codePatch.ts`). If an outside edit overlaps yours, you get
`merge-conflict`, never an overwrite. A page that does not parse may still be saved, so you can
type through broken intermediate states; the navigator shows the parse error until it parses.

**Markdown and MDX pages** (`.md`, `.mdx`) are on the same engine.

### 3.4 Rules of thumb for everyday work

- **To change a user's file, submit an intent.** Gestures go through `src/editor/editGestures.ts`
  and `page:edit`. Programmatic writes in main (stylesheets, CMS entries, assets, component
  properties) go through `electron/documents/documentWrites.ts`, which turns "the text I read"
  and "the text I want" into a `rewrite-text` intent of just the changed hunks.
  `test/electron/documents/singleWriter.test.ts` fails if anything else writes.
- **Do not print a whole existing file.** Printing is fenced by lint to brand-new files
  (`electron/documents/componentFile.ts`) and the parsers' own round-trip tests.
- **The page tree is read-only.** To change the page, describe the change as an edit; the reply
  gives you the new tree. Nothing mutates a tree in place any more.
- **Selection survives edits** because node handles are carried through each write's splices
  (`src/editor/nodeHandles.ts`), not looked up again by position.
- **Handle every outcome.** A refusal is normal operation, not an error to log and ignore.

### 3.5 What was deleted

The old save machinery is gone, not just unused. If you remember these from `main`, they no
longer exist: `mutateModel`, the mutable page tree, `selfWrites`, `modelAdoption`,
`PageSnapshot` and snapshot-based Undo, the `WeakMap` save acknowledgements, parse-order node
ids, the rescan chain and panel drains, and the IPC channels `page:write`, `page:writeRaw` and
`page:serialize`. The temporary `replace-source` operation that bridged old and new is also
gone: the count of whole-file write sites in `electron/`, `shared/` and `src/` went from 21
to 0, and `scripts/gate/adapterSurface.ts` holds it there.

### 3.6 How we know it works

This was built in eleven steps (0–10), each with a gate, and recorded step by step in
`docs/editor-core-tracker.md`. Two things are worth knowing:

- **A simulator** (`test/simulator/`) drives the real actor over a fake disk with seeded random
  interleavings of user edits and outside edits, and checks nine invariants after each run. It
  records where every byte came from, so an edit applied to the wrong place fails the run.
- **Pass/fail thresholds were written down before measuring.** The first attempt and the first
  revision *failed* and are recorded as failures; the design was revised until it passed. The
  passing run (revision B) had zero wrong-place edits in 2,000 seeds and a p95 of about 330 ms
  from the last keystroke to disk, against a limit of 350 ms.

---

## 4. Change 2 — where code lives

### 4.1 Before and after

On `main`, `src/` held about 75 loose modules beside `panels/`, `style-panel/` and `ui/`;
`electron/` held 56 files in one folder; `shared/` was flat. Now each process is organised the
same way: **layers or areas, where a module may only import from the ones below it.**

```
src/ (renderer)           electron/ (main process)        shared/ (contracts)
───────────────           ────────────────────────        ───────────────────
app        ← the shell    handlers  ← IPC handlers        ipc         ← the IPC contract
features/* ← one folder   content, project, git,          engine      ← intents, planner,
             per panel      properties                                  splices, diffs
ui         ← shared        documents ← the write path      page,       ← page model,
             widgets       parse     ← the parsers         properties    property contracts
editor     ← page-editing lib       ← the floor            core        ← assert, Result,
             core                                                        brands, limits
ipc        ← bridges to main
lib        ← generic utilities
```

Arrows point downward only. A feature may import another feature only along a few listed edges
(variables → the style panel's value editors, component properties → the props panel's fields,
history → git's widgets). The ESLint rule `stacki/source-layers` enforces all of this, and
`shared/` imports nothing outside itself.

`scripts/` is grouped by job (`build/`, `gate/`, `release/`, `install/`, `reports/`,
`policy/`, `agent/`, `eslintPlugin/`), and `test/` mirrors the source:

```
test/renderer/<layer or feature>/   ← suites for src/
test/electron/<area>/               ← suites for electron/
test/shared/<area>/                 ← suites for shared/
test/scripts/<area>/                ← suites for scripts/
test/helpers/                       ← harnesses
test/simulator/, corpus/, fixtures/, integration/
```

The full table is the **Directory map** in [`docs/codebase.md`](codebase.md#directory-map).

### 4.2 Naming

Folders and modules are camelCase, React components PascalCase, and every file name is unique
within each of `src/`, `electron/`, `shared/` and `scripts/` (ignoring case). Relative imports in
compiled code carry no file extension. The policy scan checks all of these.

### 4.3 Where did my file go?

| On `main` | Now |
|---|---|
| `src/App.tsx` (5,291 lines) | `src/app/App.tsx`, with `src/app/model/`, `state/` and `shell/` |
| `src/panels/<Name>Panel.tsx` | `src/features/<feature>/<Name>Panel.tsx` |
| `src/style-panel/` | `src/features/style/` (`clipPath/`, `embed/`, `model/`, `components/`) |
| `src/bridge.ts`, `src/appBridge.ts` | `src/ipc/` |
| `src/<feature>Bridge.ts` | `src/features/<feature>/` |
| `src/pagePersistence.ts`, `editorTree.ts`, `treeView.ts`, … | `src/editor/` |
| `electron/main.ts` (5,465 lines) | `electron/main.ts` (window, menu, lifecycle) + `electron/handlers/` (IPC) |
| `electron/astroParser.ts`, `markdownParser.ts` | `electron/parse/` (a facade over `astro*.ts` modules) |
| `electron/preload.ts` | `electron/preload/` (bridge and canvas-frame modules) |
| `electron/morphClient.ts` | `electron/previewClient/` |
| `electron/atomicWrite.ts`, document writes | `electron/documents/` |
| `electron/projectWatcher.ts`, `cssVars.ts` | `electron/project/` |
| `electron/componentProperties.ts` | `electron/properties/` |
| `shared/assert.ts`, `result.ts`, `brand.ts`, `limits.ts` | `shared/core/` |
| `shared/page-node.ts`, `frontmatter.ts` | `shared/page/pageNode.ts`, `shared/page/frontmatter.ts` |
| `shared/ipc.ts`, `ipc-payloads.ts`, `ipc-results.ts` | `shared/ipc/` |
| `shared/editor-model.ts` | Deleted; the renderer's read-only view is `src/editor/pageView.ts` |
| `REFACTOR.md`, finished plans and trackers | `docs/archive/` |

When in doubt, `git log --follow -- <new path>` shows a file's history across the move.
`git blame` skips the commit that stripped import extensions (`.git-blame-ignore-revs`).

### 4.4 Why move everything at once?

Moving files by hand across hundreds of imports is where mistakes hide. The moves were done with
a tool, `scripts/move/moveSources.mts`: each move is a reviewed table of old → new paths, and the
tool rewrites every import, `require`, and file path written in tests, configs and docs, then
verifies that everything still resolves. Anything it cannot rewrite safely blocks the step. Each
move commit therefore reads as "here is the table" rather than hundreds of hand edits. The tool
stays in the repository, with an empty table, for the next restructure.

---

## 5. Change 3 — the rules are checked for you

### 5.1 Why

`AGENTS.md` sets the engineering standard: no `any`, parse every boundary, bound every loop,
assert invariants, 70-line functions, 100-column lines, unabbreviated names, and so on. On
`main` most of that relied on review, and a lot of code is written with AI assistants, which
drift from rules that are only written down. Now a rule either **cannot be broken**, or it is
**explicitly marked as review-only** in [`docs/enforcement.md`](enforcement.md).

### 5.2 What runs, and when

| When | What runs |
|---|---|
| An agent edits a file | Prettier (formats it), the policy scan and ESLint on that file |
| An agent tries to finish | The same on every changed file, then `tsc` |
| `git commit` | Prettier check, scan and ESLint on staged files; commit message format |
| `git push` | `tsc`, full ESLint, full scan |
| CI, on every pull request | The full gate: builds, `tsc`, ESLint, Prettier, scan, every test |

The same code runs for a person, Claude Code, Codex and Pi. Git hooks are installed by
`npm install`.

The checks themselves:

- **ESLint** with zero warnings allowed: every finding is an error, or carries a written reason
  in an `eslint-disable` comment. A local plugin, `scripts/eslintPlugin/`, adds 14 rules stock
  ESLint cannot express, such as no abbreviations, no `null`, no boolean parameters, bounded
  loops and recursion, comments as sentences, and stated rounding on division.
- **The policy scan**, `scripts/policy/scan.mts`: 100-column lines, a header comment on every
  test file, no shell scripts, the dependency record in `docs/dependencies.md` matching
  `package.json`, one lockfile, the directory layout, and a floor on assertion density in
  `shared/`.
- **Prettier** across the whole tree, `printWidth: 100`.
- **Commit messages**: a typed subject (`feat(scope): …`) of at most 72 characters, a blank
  line, then a body that says why.

### 5.3 When a check stops you

Read the message: each one names the rule and where it is written. Fix the code, not the check.
If you believe the rule is wrong, change the rule on its own with its test and a human's
approval ("Changing a rule" in `docs/enforcement.md`). Do not skip hooks; CI runs the same
checks and cannot be skipped.

---

## 6. Change 4 — smaller files

The files that hurt most on `main` were the largest:

| File on `main` | Lines | Now |
|---|---|---|
| `src/style-panel/clip-path/ClipPath.tsx` | 8,893 | `src/features/style/clipPath/`, pure modules |
| `electron/main.ts` | 5,465 | `electron/main.ts` + `electron/handlers/` |
| `src/App.tsx` | 5,291 | `src/app/` (shell, state hooks, model) |
| `src/style-panel/EmbedEditor.tsx` | 4,979 | `src/features/style/embed/` |
| `electron/astroParser.ts` | 4,183 | `electron/parse/astro*.ts` behind the same facade |
| `electron/preload.ts` | 2,136 | `electron/preload/` |

Each split kept the file's public interface, so callers did not change. `ClipPath` had no tests,
so a recorded characterisation suite pinned its behaviour before it was split. The preload and
the canvas morph client must ship as one file each, so they are now written as modules and
bundled back together by esbuild (`scripts/build/bundleClients.ts`); the preload bundle shrank
from 125 KB to 63 KB as a side effect.

**Why it matters:** a file you can read in one sitting is a file you can review, and one an AI
assistant can hold in context. ESLint's `max-lines` now holds every source file in `src/`,
`electron/`, `shared/` and `scripts/` to 800 lines, with no exemptions.

---

## 7. Change 5 — performance and the test loop

- **Canvas.** The canvas script used to re-walk the whole page on every DOM change, including
  its own. It now ignores its own writes and throttles style-only changes. On a 2,000-node page
  a style-panel colour probe went from about 1.7 s of CPU (three full walks) to a single computed
  style.
- **Re-renders.** Hovering a row in the navigator, each chunk of dev-server output, and every
  canvas report used to re-render the whole app. Now a hover re-renders only the canvas, and a
  log chunk or an unchanged report re-renders nothing (`src/ui/liveValue.ts`).
- **Test gate.** Suites run in a bounded parallel pool. The full gate dropped from about 342 s to
  238 s on the development machine. Running one suite while you iterate
  (`npm test -- <suite>`) takes about 13 s instead of about 190 s, because it skips the clean
  build and the whole-tree checks. It is not a substitute for the full gate.
- **Benchmarks** to measure before optimising: `npm run bench:canvas`, `bench:render`,
  `bench:page-edit`.

---

## 8. Bugs fixed along the way

These are user-visible. Several were found by driving the built app through real projects.

| What the user saw | Cause, briefly | Commit |
|---|---|---|
| An unsaved change could overwrite an outside edit | Saves never checked the disk | `d10e9c5`, then §3 |
| A style edit appeared on the canvas only after the *next* edit; a page's own `<style>` never updated | Astro served the previous compile; the canvas patch skipped dev stylesheets | `413e468` |
| Editing a page's own `<style>` was refused as "can't be made visually" | `<style>` was classed with `<script>` as opaque | `855239a` |
| Styling an element with no class restyled the whole page | The selector fell back to Astro's per-file `data-astro-cid-…` attribute | `f23e8b1` |
| A successful edit showed a refusal message | Enter re-sent an unchanged value | `f23e8b1` |
| A page's CSS could overwrite a component's `<style>` | Style blocks were identified by node id alone, which repeats across files | `7cf8f9b` |
| Picking a value in the style panel sometimes did nothing, or flicked back | The edit went to the first matching rule, not the one that wins; a stale read restored old CSS | `1e2946c` |
| A CRLF Markdown page gained a stray carriage return per save; a leading BOM broke frontmatter | Encoding handling in the parsers | `d10e9c5` |

---

## 9. How do I…

**…make a new kind of visual edit?** Describe the gesture as edit requests in
`src/editor/editGestures.ts`. If no existing operation fits, add one to the union in
`shared/engine/intent.ts`; the compiler will then point at every place that must handle it,
including the planner (`shared/engine/planner.ts` and `plan*.ts`) and the intent contract test.
Add a case to the gesture parity suite (`test/renderer/editor/gestureParity.test.js`).

**…change a file from main (a stylesheet, a CMS entry, an asset)?** Read it, compute the text
you want, and write through `electron/documents/documentWrites.ts`. Never call `fs.writeFile`
on project text.

**…add an IPC channel?** Update all three inventories in `shared/ipc/`: `ipcPayloads.ts`,
`ipcResults.ts` and `preloadApi.ts`. Parse the payload in the handler (`electron/handlers/`)
and the reply in the renderer bridge. Add known-good and malformed cases under
`test/shared/ipc/`. See "IPC" in `docs/contracts.md`.

**…add a panel or feature?** Create `src/features/<feature>/` holding its panel, models, bridge
and CSS. It may import `lib`, `ipc`, `editor` and `ui`, but not another feature unless that
edge is added to `SOURCE_LAYERS` in `eslint.config.mjs`, which needs a human's approval. Put
its suites in `test/renderer/<feature>/`.

**…add a test?** Create `*.test.ts` (or `.js`) in the mirrored folder, opening with a comment
that states the test's goal and method. The gate finds it by name; there is no list to update.
Run it with `env -u ELECTRON_RUN_AS_NODE npm test -- <name>`.

**…add a dependency?** Prefer the platform. If you must add one, record what it does, why the
platform cannot, and what it costs in `docs/dependencies.md`; the scan fails otherwise.

**…move or rename files in bulk?** Use `scripts/move/moveSources.mts` with a manifest step
rather than hand-editing imports.

---

## 10. For reviewers

- **Read the history by workstream, not as one diff.** In order: editor core steps 0–10
  (`feat(editor-core): step N …`), the AGENTS.md alignment and lint paydown
  (`refactor(align)`, `feat(policy)`), the restructure (`chore(scripts): move steps …` followed
  by `refactor(<area>): …`), the file splits, then performance and fixes.
- **For move commits, review the move table** in the `chore(scripts): move steps…` commit
  before it. The following commit is the tool's output.
- **Gate files changed on this branch** (`AGENTS.md`, `CLAUDE.md`, `eslint.config.mjs`,
  `scripts/{eslintPlugin,policy,agent}/`, hook configs). They need a human reviewer's sign-off.
- **Known open items**, all recorded in the tracker: the Markdown canvas stamp; URL-like values
  inside expression hosts (`?`, `:`) still fall back to a slower path; a moved element is
  rebuilt on the canvas, so it loses its client state.
- **Production signal.** Each save outcome is logged as one JSON line on main's stdout, with a
  hashed path and no file contents (`electron/documents/documentTelemetry.ts`). The mix of
  refusal reasons is how we will learn about cases the tests do not cover.

---

## 11. Glossary

| Term | Meaning |
|---|---|
| **Checksum** | SHA-256 of a file's exact bytes. Names "the version of the file I saw" (`Digest` in `shared/core/brand.ts`). |
| **Snapshot** | The bytes of a file, their checksum and the parsed projection, held by the actor. Immutable. |
| **Projection** | The page tree parsed from a snapshot's bytes. Derived and disposable; never written back. |
| **Edit request** | A gesture stated against the page the renderer shows. Sent over `page:edit`. |
| **Intent** | Main's form of an edit: an operation with an anchor in bytes, plus the checksum it was authored against. |
| **Splice** | "Replace bytes *a*–*b* with this text": the only way a file changes. |
| **Witness** | The bytes a splice expects to replace. A mismatch is a refusal. |
| **Document actor** | The single writer for one file. It queues intents, plans splices, writes atomically and returns one typed outcome per intent. |
| **Rebase** | Shifting an edit past the actor's own recent writes, exactly. |
| **Capability** | What the editor may do to a node visually (editable, read-only, opaque), shown beside the selection. |
| **Preview token** | Stamps each canvas rendering, so a click on a stale rendering never selects the wrong node. |
| **Gate** | The checks a change must pass: hooks locally, the full gate in CI. |
| **Gate files** | Files that define the gates. They change only with a human's approval. |

## 12. Further reading

- [`docs/codebase.md`](codebase.md): the architecture, the write path and the directory map.
- [`docs/contracts.md`](contracts.md): every cross-process contract. Read it before changing
  page trees, IPC, saves or the engine.
- [`docs/stacki-editor-core-plan.md`](stacki-editor-core-plan.md): the editor-core design.
  Code comments cite it as "plan §".
- [`docs/editor-core-tracker.md`](editor-core-tracker.md): step-by-step record and measurements.
- [`docs/enforcement.md`](enforcement.md): each rule and the check that holds it.
- [`test/README.md`](../test/README.md): running tests, the round-trip gate and the simulator.
- [`docs/archive/`](archive/): finished plans, kept for their reasoning; paths in them are from
  before the restructure.
