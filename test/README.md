# Tests

```bash
npm test                                   # the gate — run this before every commit
npm run roundtrip:report                   # where the parser stands, and what is left to fix
node dist/scripts/reports/roundtripReport.js ~/a-site  # same report against any Astro project
STACKI_CORPUS=~/a-site npm test            # crash-sweep a real project as part of the gate
npm test -- queryCache                     # one suite, by name (case and dashes do not matter)
npm test -- simulator/                     # every suite under a folder
npm test -- --list                         # the suites the gate runs
npm run performance:report -- d9f9c05      # compare preview diff with the pre-refactor checkpoint
npm run integration:dev                    # real Electron/Astro lifecycle smoke test
```

The gate runs every file named `*.test.js` or `*.test.ts` under `test/`
(`scripts/gate/testDiscovery.ts`), each as `node <file>` in its own process,
outside `fixtures/`, `corpus/`, `helpers/` and `integration/`. A new test is in
the gate the moment it exists; there is no list to add it to. The few suites
that need a different runner, Node flags or to run alone say so in
`scripts/gate/testSuites.ts`, keyed by path. Harnesses live in `helpers/`, and
`helpers/sources.js` is how a test names a repository file (see
`sourcePaths.test.js`).

`npm test -- simulator/` runs the editor-core simulator (`simulator/`): seeded runs of
the step-wise actor over a fake disk, checked against the nine invariants of
plan §10, plus the oracle scenarios over the hostile corpus in
`fixtures/editor-core/`, and the step-2 suites (`diff`, `map-span`, `planner`)
that hold `shared/engine/diff.ts`, `shared/engine/mapSpan.ts` and `shared/engine/planner.ts` to the
brute-force references in `simulator/reference-diff.ts`.
`STACKI_SIMULATOR_SEEDS=2000 npm test -- simulator/` is
the long run. From step 3 the simulator's actor plans `set-attribute` with the
shipping planner, and every stale plan is judged against the byte origins the
simulator recorded (`simulator/provenance.ts`, `simulator/remap-judge.ts`); a
wrong-site plan fails the run. Everything under `simulator/` except its
entry points (`*.test.ts`, `*.bench.ts`) and the `*.entry.ts` modules only they
import is lint-fenced: no timers, clocks, promises, `Math.random` or I/O.

`npm run spike:editor-core` (after `npm run fixtures:large`) prints the step-3
spike report: remap verdicts per fixture over 400 seeds, and intent→applied and
last keystroke→disk latency on the six large fixtures, on a real disk, against
the pre-registered thresholds. It measures and asserts no threshold, so it is
not in the gate. `STACKI_SPIKE_SEEDS`, `STACKI_SPIKE_SAMPLES` and
`STACKI_SPIKE_KEYSTROKES` change the sample counts.

The optional `integration:dev` test installs a pinned Astro version into a temporary
project and starts real Electron and Astro processes. It needs network access on
the first install and uses isolated app data; it does not modify an existing site.
The ordinary gate stays offline. Several older content tests use an optional
external project and report a skip if it is absent; the standalone lifecycle and
content worker regressions still run.

## The round-trip gate

Stacki edits files it did not write. The contract that makes that safe is:

> Parsing a page and serializing it straight back must return **the original bytes**.

Anything else means opening a file and saving it rewrites parts the user never
touched — reformatted markup, reordered imports, lost blank lines. That turns a
one-prop change into a whole-file diff in their git history, and in the worst case
changes what the page does.

`roundtripCorpus.test.js` checks five properties against every fixture in `corpus/`:

| # | Property | Why |
|---|---|---|
| 1 | `parsePage` never throws | A crash on someone's project is the worst possible first impression |
| 2 | Editability is stable | A file silently dropping to code view is a feature regression |
| 3 | parse → serialize is identity | The contract above |
| 4 | Serialization is idempotent | Weaker fallback: if a file *is* damaged, it is damaged once, not on every save |
| 5 | One edit → one-line diff | Measures blast radius. Checked against the serializer's own output, so it stays meaningful while #3 is still failing |

## Known failures

`expectations.json` lists fixtures that **currently fail** property 3, each with the
root cause and a `severity`:

- **`corruption`** — the output is not equivalent to the input. It changes meaning
  or is invalid Astro. These are bugs.
- **`formatting`** — semantically the same file, reformatted. Still unacceptable
  for a tool that edits other people's repos, but it won't break a build.

The gate asserts a known failure **still fails**. So when a fix lands, the test goes
red with *"delete its entry from expectations.json"* — the fix cannot land silently,
and the fixture immediately becomes a permanent regression test.

That makes `expectations.json` the parser worklist. Shrinking it to `{}` is the goal.

## Adding a fixture

1. Drop a minimal, valid `.astro` file in `corpus/` named after the shape it covers.
2. Run `npm test`.
3. If it passes, you're done — it now guards that shape forever.
4. If it fails, that's a real defect. Add an entry to `expectations.json` with the
   root cause (file:line) and a severity, and it becomes tracked work.

Fixtures should be **minimal and single-purpose**: one shape per file, named for the
shape. `named-imports.astro` covers named imports, not named imports *and* slots.

Currently uncovered, worth adding: CRLF line endings, `.mdx`, framework components
(`.jsx`/`.vue`/`.svelte`), dynamic routes (`[slug].astro`), TypeScript path aliases
in import specifiers.
