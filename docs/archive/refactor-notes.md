# Refactor notes

Restore point: `d9f9c05` (`chore: checkpoint before major overhaul`).
Working branch: `codex/refactor-performance`.

## Structure and behavior

- `src/editorTree.js` supplies one index per immutable page model, reused for
  selection, ancestor trails, anchor links, canvas paths, and hidden node lookup.
  Mutation helpers continue to read current data rather than caching mutable trees.
- `src/loopBindings.js` owns loop scope and renaming. Dollar signs in identifiers
  and inner loops that shadow outer variables now work correctly.
- `electron/frontmatter.js` shares import reading/writing between the parser and
  code editor. Ordered source slots preserve interleaved declarations, import
  syntax, and blank lines while allowing edits. Non-import code remains visible
  to the binding controls, including declarations before the first import.
- Shorthand Astro fragments (`<>...</>`) expose their children in conditionals
  and loops. Saves preserve the shorthand, and preview markers reach the actual
  rendered children. Fragment wrappers remain selectable without trying to open
  a component file.
- `src/pagePersistence.js` serializes page writes and acknowledges only the saved
  state. Code windows debounce by destination, so editing another file cannot
  cancel the first file's pending write. Navigation and disk reloads discard
  obsolete responses and preserve newer edits. Entering and leaving components
  keeps the current inspector and preview mounted until the destination loads
  and pending edits are saved. Nested component navigation preserves scroll.
  Opening a component selects its first rendered child through conditional,
  loop, and fragment wrappers; layouts retain their body selection.
- New CSS variables default to `unset`. Empty declaration spans no longer
  include delimiters or adjacent values, preserving existing empty values.
- `src/ui/usePointerDrag.js` handles frame scheduling, the final pointer position,
  cancellation, lost focus, and cleanup for canvas, preview, and terminal resizing.
- `electron/projectWatcher.js` owns both directory watchers and all their delayed
  notifications. Each filesystem event checks self writes once.
- `electron/serialQueue.js` supplies serial work and keyed cancellation. Thumbnail
  capture and Astro startup no longer race concurrent callers.
- Content workers share startup, isolate replies and exits to their own lifetime,
  and clear request timers. Closing a project cancels pending server startup and
  releases its workers, watchers, timers, and owned process groups.
- Generated preview configuration recognizes canonical and symlinked project
  paths. Content schema conversion supports Astro 5's Zod 3 as well as the existing
  Zod 4 path, using the project's converter rather than adding an app dependency.
- Computed colors and styles use a shared batched cache implementation. Responses
  from old documents or selections cannot overwrite current values; unanswered
  queries settle on the fallback. Literal colors do not subscribe to page changes.
- External updates to CodeMirror do not echo back as fresh edits. Typing no longer
  jumps the caret back to a previously requested reveal line.
- Optional editors and terminal rendering load on demand. Hiding the terminal
  preserves the instance and scrollback. Unchanged dimensions avoid repeated IPC
  resize calls, and disposed terminals ignore delayed startup/clipboard results.
- Grid area declarations now appear in Custom properties; dynamic border and
  grid-line controls are verified by mounting and editing the real controls.

The unused Webflow adapter and unreferenced generated `.vars.css` snapshot were
removed. Their approximately 7,800 lines remain available in the restore commit.

## Performance evidence

The production entry JavaScript was approximately 2,267 kB before the refactor.
After splitting optional editors it is approximately 1,068 kB (53% smaller). This measures the
entry bundle, not every feature's combined download size or application startup
time. The editor code is still available in separately loaded chunks.

`npm run performance:report -- d9f9c05` compares exact preview edit operations
against the checkpoint and reports elapsed time and matrix allocations. On this
machine, an unchanged list of 2,000 siblings fell from approximately 10.3 ms to
0.1 ms and avoided a 16 MB matrix. Appending or removing the final sibling has the
same linear fast path. Changed regions retain the existing exact LCS matching
and tie behavior; their worst-case cost remains quadratic.

## Validation

`npm test` runs all registered test commands, including the new behavioral suites
for lifecycle races, navigation, save ordering, preview identity, parser edge
cases, computed values, and terminal state. `npm run build` verifies production
bundling. `npm run integration:dev` exercises real Electron/Astro startup and
shutdown, content schema loading/validation, and production renderer/preload boot
in an isolated temporary project. The bridge gate follows lazy component imports
as well as static ones, retaining prop-wiring coverage after code splitting.

The complete gate passed all 122 commands. Production bundling and the real
Electron/Astro integration passed. The development server's optimized shared
frontmatter module was also fetched and executed successfully, and the unpacked
parser dependency check passed.

The optional external content fixture and `STACKI_CORPUS` checks are skipped when
their projects are absent. The parser's remaining known round-trip limitations
are explicitly listed in `test/expectations.json`; a passing gate does not claim
those existing defects are fixed. Native Windows packaging and every Astro
version require their own environment checks.
