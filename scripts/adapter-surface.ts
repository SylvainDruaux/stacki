#!/usr/bin/env node
// The adapter surface: how much renderer code still edits the legacy mutable
// page tree directly (plan §11 steps 3–6). Every site counted here is one the
// compat adapter must translate into intents and step 9 must delete. The counts
// only go down: a new site fails the gate, a removed one asks for the baseline
// to be lowered.
//
// Method (a grep, written down so anyone can re-run it by hand):
//
//   Files   src/**/*.ts and src/**/*.tsx. Node mutations and prop-index writes
//           exclude src/style-panel/, which edits CSS rules, not the page tree.
//           Wrapper call sites cover all of src/: applyEdit lives there.
//   Fields  the page-node fields a mutation can change: props, children,
//           attrOrder, attrSource, kind, name, value, id, dynamicTag, slots,
//           body, test, nodes, mdRaw, mdSource.
//
//   1. Node mutations — one per match of
//        a. `<receiver>.<field> =`, `+=` or `-=` (not `==`, not `=>`);
//        b. `<receiver>.<field>.<mutator>(` where mutator is an array mutator
//           (push, pop, splice, shift, unshift, sort, reverse, fill, copyWithin);
//        c. `delete <receiver>.<field>`;
//        d. aliased lists: `const|let <alias> = <expression>.children|nodes`
//           declares an alias, and each `<alias>.<mutator>(` in that file counts;
//           so does the sibling list a tree lookup returns (findParentList
//           gives `{ list, index }`): `<receiver>.list.<mutator>(`, and
//           `<alias>.<mutator>(` after `const { list: <alias> } = …` or
//           `const { list } = …`.
//      Receivers whose last segment names a DOM or CMS object, not a page node,
//      are excluded: event, target, currentTarget, gain, input, field (CMS
//      schema fields), style, dataset.
//   2. Prop-index writes — `props[<key>] =` (any receiver, or a bare `props`
//      alias) and `delete <receiver>.props[<key>]`.
//   3. `mutateModel(` call sites, the definition excluded.
//   4. `applyEdit(` call sites, the definition excluded.
//   5. From step 5: whole-file `replace-source` submissions, the migration-only
//      operation (plan §3.3) — call sites of `replaceSource(`, `writeCurrent(`
//      and `writeProjectText(` in electron/**/*.ts, definitions excluded, and
//      the host's own plumbing (documentActors.ts, documentWrites.ts) not
//      counted. Step 9 deletes them for `.astro`; step 10 for the rest.
//
// Comment lines (starting with //, * or /*) are skipped. Hand count on
// 2026-09-28 was 67 / 10 / 28 / 4; this method is the authority from step 1 on,
// and the tracker records both.

import fs = require('node:fs');
import path = require('node:path');

interface Counts {
  readonly mutations: number;
  readonly propIndexWrites: number;
  readonly mutateModelCalls: number;
  readonly applyEditCalls: number;
  readonly replaceSourceCalls: number;
}

const REPLACE_SOURCE_BASELINE = 23;

/** Measured 2026-09-28 by this script at step 1, lowered at each step-6
 * expansion (the tracker's adapter table). Lower these; never raise them. */
const BASELINE: Counts = {
  mutations: 55,
  propIndexWrites: 4,
  mutateModelCalls: 22,
  applyEditCalls: 4,
  /** Measured at step 5, when the legacy writers moved onto the actors. */
  replaceSourceCalls: REPLACE_SOURCE_BASELINE,
};

const FILES_MAX = 20_000;
const FIELDS = 'props|children|attrOrder|attrSource|kind|name|value|id|dynamicTag|slots|body|test|nodes|mdRaw|mdSource';
const MUTATORS = 'push|pop|splice|shift|unshift|sort|reverse|fill|copyWithin';
const EXCLUDED_RECEIVERS = new Set(['event', 'target', 'currentTarget', 'gain', 'input', 'field', 'style', 'dataset']);
const RECEIVER = '([A-Za-z_$][\\w$]*(?:\\??\\.[A-Za-z_$][\\w$]*|\\[[^\\]]*\\])*)';

const ASSIGN_RE = new RegExp(`${RECEIVER}\\.(?:${FIELDS})\\s*(?:=(?![=>])|\\+=|-=)`, 'g');
const MUTATE_RE = new RegExp(`${RECEIVER}\\.(?:${FIELDS})\\.(?:${MUTATORS})\\(`, 'g');
const DELETE_RE = new RegExp(`delete\\s+${RECEIVER}\\.(?:${FIELDS})\\b(?!\\[)`, 'g');
const ALIAS_RE = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.(?:children|nodes)\b\s*(?:[;\n|?]|$)/g;
const LIST_MUTATE_RE = new RegExp(`${RECEIVER}\\.list\\.(?:${MUTATORS})\\(`, 'g');
const LIST_ALIAS_RE = /(?:const|let)\s+\{[^}]*\blist\b(?:\s*:\s*([A-Za-z_$][\w$]*))?[^}]*\}\s*=/g;
const PROP_INDEX_RE = /(?:\bprops\[[^\]]+\]\s*=(?![=>]))|(?:delete\s+[\w$.?]+\.props\[)/g;
const MUTATE_MODEL_RE = /\bmutateModel\(/g;
const APPLY_EDIT_RE = /\bapplyEdit\(/g;
const DEFINITION_RE = /(?:function\s+(?:mutateModel|applyEdit)\b|(?:const|let)\s+(?:mutateModel|applyEdit)\s*=)/;
const REPLACE_SOURCE_RE = /\b(?:replaceSource|writeCurrent|writeProjectText)\(/g;
const REPLACE_SOURCE_DEFINITION_RE =
  /(?:function\s+(?:replaceSource|writeCurrent|writeProjectText)\b|^\s*(?:replaceSource|writeCurrent)\()/;
/** The host's plumbing: it defines the submissions, it does not make them. */
const REPLACE_SOURCE_PLUMBING = new Set(['documentActors.ts', 'documentWrites.ts']);

export function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  const pending = [directory];
  for (let visited = 0; pending.length > 0; visited++) {
    if (visited > FILES_MAX) {
      throw new Error(`adapter-surface: more than ${FILES_MAX} paths under ${directory}`);
    }
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
  }
  return found.sort();
}

function codeLines(text: string): readonly string[] {
  return text.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line));
}

function receiverCounts(line: string, pattern: RegExp): number {
  let count = 0;
  for (const match of line.matchAll(pattern)) {
    const receiver = match[1] ?? '';
    const last = receiver.split(/\??\./).pop()?.replace(/\[.*$/, '') ?? '';
    if (!EXCLUDED_RECEIVERS.has(last)) {
      count += 1;
    }
  }
  return count;
}

/** Node mutations and prop-index writes in one file's text. */
export function countTreeEdits(text: string): { readonly mutations: number; readonly propIndexWrites: number } {
  const lines = codeLines(text);
  const aliases = new Set([
    ...[...text.matchAll(ALIAS_RE)].map((match) => match[1] ?? ''),
    ...[...text.matchAll(LIST_ALIAS_RE)].map((match) => match[1] ?? 'list'),
  ]);
  aliases.delete('');
  const aliasRe = aliases.size === 0 ? undefined : new RegExp(`\\b(?:${[...aliases].join('|')})\\.(?:${MUTATORS})\\(`, 'g');
  let mutations = 0;
  let propIndexWrites = 0;
  for (const line of lines) {
    mutations += receiverCounts(line, ASSIGN_RE) + receiverCounts(line, MUTATE_RE) + receiverCounts(line, DELETE_RE);
    mutations += receiverCounts(line, LIST_MUTATE_RE);
    mutations += aliasRe === undefined ? 0 : [...line.matchAll(aliasRe)].length;
    propIndexWrites += [...line.matchAll(PROP_INDEX_RE)].length;
  }
  return { mutations, propIndexWrites };
}

/** Wrapper call sites in one file's text, definitions excluded. */
export function countWrapperCalls(text: string): { readonly mutateModelCalls: number; readonly applyEditCalls: number } {
  let mutateModelCalls = 0;
  let applyEditCalls = 0;
  for (const line of codeLines(text)) {
    if (DEFINITION_RE.test(line)) {
      continue;
    }
    mutateModelCalls += [...line.matchAll(MUTATE_MODEL_RE)].length;
    applyEditCalls += [...line.matchAll(APPLY_EDIT_RE)].length;
  }
  return { mutateModelCalls, applyEditCalls };
}

/** Whole-file `replace-source` submission sites in one file's text. */
export function countReplaceSourceCalls(text: string): number {
  let calls = 0;
  for (const line of codeLines(text)) {
    if (REPLACE_SOURCE_DEFINITION_RE.test(line)) {
      continue;
    }
    calls += [...line.matchAll(REPLACE_SOURCE_RE)].length;
  }
  return calls;
}

function measureReplaceSource(root: string): number {
  let calls = 0;
  for (const file of sourceFiles(path.join(root, 'electron'))) {
    if (!REPLACE_SOURCE_PLUMBING.has(path.basename(file))) {
      calls += countReplaceSourceCalls(fs.readFileSync(file, 'utf8'));
    }
  }
  return calls;
}

function measure(root: string): { readonly counts: Counts; readonly byFile: ReadonlyMap<string, number> } {
  const source = path.join(root, 'src');
  const stylePanel = path.join(source, 'style-panel') + path.sep;
  let mutations = 0;
  let propIndexWrites = 0;
  let mutateModelCalls = 0;
  let applyEditCalls = 0;
  const byFile = new Map<string, number>();
  for (const file of sourceFiles(source)) {
    const text = fs.readFileSync(file, 'utf8');
    const calls = countWrapperCalls(text);
    mutateModelCalls += calls.mutateModelCalls;
    applyEditCalls += calls.applyEditCalls;
    if (file.startsWith(stylePanel)) {
      continue;
    }
    const edits = countTreeEdits(text);
    mutations += edits.mutations;
    propIndexWrites += edits.propIndexWrites;
    if (edits.mutations + edits.propIndexWrites > 0) {
      byFile.set(path.relative(root, file), edits.mutations + edits.propIndexWrites);
    }
  }
  const replaceSourceCalls = measureReplaceSource(root);
  const counts = { mutations, propIndexWrites, mutateModelCalls, applyEditCalls, replaceSourceCalls };
  return { counts, byFile };
}

function main(): void {
  const root = path.join(__dirname, '..', '..');
  const { counts, byFile } = measure(root);
  const labels: Readonly<Record<keyof Counts, string>> = {
    mutations: 'direct node-mutation sites',
    propIndexWrites: 'prop-index writes',
    mutateModelCalls: 'mutateModel( call sites',
    applyEditCalls: 'applyEdit( call sites',
    replaceSourceCalls: 'replace-source submission sites (electron/)',
  };
  let slipped = false;
  const keys = [
    'mutations',
    'propIndexWrites',
    'mutateModelCalls',
    'applyEditCalls',
    'replaceSourceCalls',
  ] as const;
  for (const key of keys) {
    const now = counts[key];
    const baseline = BASELINE[key];
    console.log(`${String(now).padStart(4)} ${labels[key]} (baseline ${baseline})`);
    if (now > baseline) {
      slipped = true;
      console.error(`     grew by ${now - baseline}: new code must enter through intents (plan §11 step 6).`);
    } else if (now < baseline) {
      console.log(`     ${baseline - now} below baseline — lower BASELINE.${key} in scripts/adapter-surface.ts.`);
    }
  }
  if (process.argv.includes('--files')) {
    for (const [file, count] of byFile) {
      console.log(`  ${String(count).padStart(3)} ${file}`);
    }
  }
  if (slipped) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
