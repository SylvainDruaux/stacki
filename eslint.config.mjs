// ESLint flat config — AGENTS.md rule set.
//
// Hand-rolled rather than via the typescript-eslint meta-package because the
// repo's pnpm tree carries @typescript-eslint/parser and eslint-plugin directly
// and adding the meta package means a fresh full-graph resolution the tree
// isn't ready for. Same rules, same shape.
//
// max-lines-per-function and prefer-readonly remain warnings until the
//    oversized legacy functions are split.
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';

// no-restricted-syntax lists replace each other between config blocks rather
// than merging, so each group is defined once and composed per block below.

// `as const` is the canonical way to keep literal unions (§5). Reject all
// other assertion syntax while allowing that one language construct.
const NO_ASSERTIONS = [
  {
    selector: "TSAsExpression:not([typeAnnotation.typeName.name='const'])",
    message: 'Type assertions must be replaced with validation and narrowing.',
  },
  {
    selector: 'TSTypeAssertion',
    message: 'Type assertions must be replaced with validation and narrowing.',
  },
];

// Whole-file regeneration (plan §12: rejected as the steady state; §11.9: gone
// for existing .astro files). An existing file changes only by splices, so the
// printers may be imported or called only where a file is printed that does not
// exist yet, or where an edit prints just what it adds. Importing the name is
// what is banned, so an alias cannot slip past.
const WHOLE_FILE_REGENERATION_MESSAGE =
  'Whole-file regeneration is confined to the printer boundaries (plan §11.9); ' +
  'an existing file changes only through intents and splices.';
const NO_ASTRO_PRINTING = [
  {
    selector: 'ImportSpecifier[imported.name=/^serialize(Page|Nodes)$/]',
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
  {
    selector: 'CallExpression[callee.name=/^serialize(Page|Nodes)$/]',
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
  {
    selector: "ImportDeclaration[source.value=/astroParser(\\.js)?$/] > ImportNamespaceSpecifier",
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
];
const NO_MARKDOWN_PRINTING = [
  {
    selector: 'ImportSpecifier[imported.name=/^serializeMarkdownPage$/]',
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
  {
    selector: 'CallExpression[callee.name=/^serializeMarkdownPage$/]',
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
  {
    selector:
      "ImportDeclaration[source.value=/markdownParser(\\.js)?$/] > ImportNamespaceSpecifier",
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
];
const NO_WHOLE_FILE_REGENERATION = [...NO_ASTRO_PRINTING, ...NO_MARKDOWN_PRINTING];
// Where the .astro printers may run: their definitions; new files (a component
// made from a piece of a page, a new page); the nodes and the frontmatter block
// an edit adds, printed alone (editRequests.ts); and Markdown's HTML blocks.
const ASTRO_PRINTER_BOUNDARY = [
  'electron/astroParser.ts',
  'electron/componentFile.ts',
  'electron/editRequests.ts',
];
// Where the Markdown printer may run: its definition, and main's whole save and
// review of a Markdown or MDX page, until those pages join the engine (step 10).
const MARKDOWN_PRINTER_BOUNDARY = ['electron/main.ts'];
// Markdown's parser module holds its printer and prints its HTML blocks with
// the .astro printer: both, until step 10.
const PRINTER_BOUNDARY = ['electron/markdownParser.ts'];

// Determinism is structural (plan §10): the simulator and the engine contracts
// run on no clock, no timer, no promise and no OS. A real timer sneaking in is
// a failed gate, not a flaky test.
const NO_ASYNC = [
  { selector: 'AwaitExpression', message: 'Deterministic code has no async steps (plan §10).' },
  { selector: ':function[async=true]', message: 'Deterministic code has no async steps (plan §10).' },
  { selector: "Identifier[name='Promise']", message: 'Deterministic code has no promises (plan §10).' },
];
const DETERMINISM_RULES = {
  'no-restricted-globals': [
    'error',
    ...[
      'setTimeout',
      'setInterval',
      'setImmediate',
      'clearTimeout',
      'clearInterval',
      'clearImmediate',
      'queueMicrotask',
      'Date',
      'performance',
      'process',
      'fetch',
    ].map((name) => ({ name, message: `${name} is nondeterministic; the scheduler owns time (plan §10).` })),
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: 'Use the seeded Prng (plan §10).' },
    { object: 'crypto', property: 'randomUUID', message: 'Use the seeded Prng (plan §10).' },
    { object: 'crypto', property: 'getRandomValues', message: 'Use the seeded Prng (plan §10).' },
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [
        'fs',
        'node:fs',
        'node:fs/promises',
        'timers',
        'node:timers',
        'node:timers/promises',
        'node:child_process',
        'node:worker_threads',
        'node:perf_hooks',
        'node:os',
        'node:net',
        'node:http',
        'node:https',
      ].map((name) => ({ name, message: 'Deterministic code does no I/O; fake it behind an interface (plan §10).' })),
    },
  ],
};
// Pure engine contracts, fenced like the simulator: they will run inside it.
const ENGINE_CONTRACTS = [
  'shared/capability.ts',
  'shared/code-patch.ts',
  'shared/diff.ts',
  'shared/documentActor.ts',
  'shared/intent.ts',
  'shared/mapSpan.ts',
  'shared/inlineStyle.ts',
  'shared/loopScope.ts',
  'shared/markdownLayout.ts',
  'shared/planner.ts',
  'shared/planSupport.ts',
  'shared/planText.ts',
  'shared/planTree.ts',
  'shared/rebase.ts',
  'shared/ref.ts',
  'shared/snapshot.ts',
  'shared/source-projection.ts',
  'shared/span.ts',
  'shared/splice.ts',
];

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'test/.stacki-test/**',
      '**/generated/**',
    ],
  },
  {
    // Renderer JS/JSX is ESM with JSX. Electron main, scripts, and tests are
    // CommonJS (top-level return is legal in the CJS module wrapper).
    files: ['src/**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      curly: ['error', 'all'],
      'react-hooks/exhaustive-deps': 'warn',
      // Legacy JSX calls hooks conditionally (PropsPanel.jsx, VariablesView.jsx)
      // — real crash-on-flip bugs, fixed as part of those files' Phase 3
      // conversions. Error level stands for all TS.
      'react-hooks/rules-of-hooks': 'warn',
    },
  },
  {
    files: ['electron/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
    },
    rules: {
      curly: ['error', 'all'],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tsPlugin, 'react-hooks': reactHooks },
    rules: {
      ...tsPlugin.configs['eslint-recommended'].rules,
      ...tsPlugin.configs.recommended.rules,
      // AGENTS.md non-negotiables.
      // The migration ratchet is zero, so unchecked files cannot re-enter the tree.
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-nocheck': true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': 'off',
      'no-restricted-syntax': ['error', ...NO_ASSERTIONS, ...NO_WHOLE_FILE_REGENERATION],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      curly: ['error', 'all'],
      // Hooks deps were the author's own suppressed warnings; keep them visible.
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      // Type-aware safety. Error — the compiler-adjacent bug class.
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Scale rules: legacy functions violate these at volume. Warn now, tighten on conversion.
      '@typescript-eslint/prefer-readonly': 'warn',
      'max-lines-per-function': ['warn', { max: 70, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // shared/ is the validated-constructor layer (AGENTS.md §2): assertions
    // are permitted here immediately after validation. Everywhere else the
    // rule stands at error.
    files: ['shared/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      'no-restricted-syntax': ['error', ...NO_WHOLE_FILE_REGENERATION],
    },
  },
  {
    // These adapters validate values from PostCSS, DOM storage, and the host
    // bridge before constructing trusted application values. AGENTS.md §2
    // permits assertions inside validated constructors and type guards.
    files: [
      'src/style-panel/lib/css.ts',
      'src/style-panel/lib/host.ts',
      'src/style-panel/lib/webflow.ts',
      'src/style-panel/shared/dom-safety.ts',
      'src/style-panel/shared/tool-prefs.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...NO_WHOLE_FILE_REGENERATION],
    },
  },
  {
    // These entrypoints compile to CommonJS because Electron Builder loads its
    // afterPack hook with require. Import assignments also keep direct Node
    // execution in CommonJS so __dirname and require.main have one meaning.
    files: ['scripts/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ASTRO_PRINTER_BOUNDARY,
    rules: {
      'no-restricted-syntax': ['error', ...NO_ASSERTIONS, ...NO_MARKDOWN_PRINTING],
    },
  },
  {
    files: MARKDOWN_PRINTER_BOUNDARY,
    rules: {
      'no-restricted-syntax': ['error', ...NO_ASSERTIONS, ...NO_ASTRO_PRINTING],
    },
  },
  {
    // Both printers, and the tests that pin their round trips.
    files: [...PRINTER_BOUNDARY, 'test/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_ASSERTIONS],
    },
  },
  {
    files: ENGINE_CONTRACTS,
    rules: {
      ...DETERMINISM_RULES,
      'no-restricted-syntax': ['error', ...NO_WHOLE_FILE_REGENERATION, ...NO_ASYNC],
    },
  },
  {
    // The simulator core. Its entry points — the *.test.ts suites and the
    // *.bench.ts spike measurement — and the *.entry.ts modules only they import
    // load fixtures from disk, read the environment and (the bench) the clock,
    // then hand plain values in.
    files: ['test/simulator/**/*.ts'],
    ignores: [
      'test/simulator/**/*.test.ts',
      'test/simulator/**/*.bench.ts',
      'test/simulator/**/*.entry.ts',
    ],
    rules: {
      ...DETERMINISM_RULES,
      'no-restricted-syntax': ['error', ...NO_ASSERTIONS, ...NO_WHOLE_FILE_REGENERATION, ...NO_ASYNC],
    },
  },
];
