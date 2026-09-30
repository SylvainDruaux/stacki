// The policy every agent harness enforces, as pure functions of the tool call
// the agent is about to make. Harness adapters (hook.mts for Claude Code and
// Codex, .pi/extensions/stacki-policy for Pi) only translate their protocol to
// these calls and back, so the three agents are held to one rule set.
//
// Two decisions are made before a tool runs:
// - commandVerdict: a shell command that would switch a gate off.
// - pathVerdict: an edit to the files that define the gates themselves.
// Checks after an edit, and before the agent stops, live in policy/checks.mts.

import path from 'node:path';
import { assert } from '../policy/assert.mts';
import { normalizePath } from '../policy/scan.mts';

export type Verdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  // A human decides: the harness asks where it can, and refuses where it
  // cannot, telling the agent to ask its human.
  | { readonly kind: 'ask'; readonly reason: string };

const ALLOW: Verdict = { kind: 'allow' };
const COMMAND_CHARS_MAX = 200_000;
const SEGMENTS_MAX = 1_000;
const TOKENS_MAX = 20_000;

// The files that define the gates. Weakening one weakens every gate at once,
// so an agent changes them only with a human's say-so (docs/enforcement.md).
const POLICY_PATTERNS: readonly RegExp[] = [
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^eslint\.config\.mjs$/,
  /^\.prettierrc\.json$/,
  /^\.prettierignore$/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /^scripts\/(?:eslint-plugin|policy|agent)\//,
  /^\.githooks\//,
  /^\.claude\/settings\.json$/,
  /^\.codex\//,
  /^\.pi\//,
  /^\.github\/workflows\//,
  /^shared\/limits\.ts$/,
  /^docs\/enforcement\.md$/,
];

const POLICY_EDIT_REASON =
  'This file defines the repository gates (docs/enforcement.md). Changing it changes ' +
  'what every agent and every commit is held to, so a human approves it first.';

export function pathVerdict(file: string): Verdict {
  assert(!file.includes('\\'), 'pathVerdict: paths use forward slashes');
  assert(!file.startsWith('/'), 'pathVerdict: paths are repository-relative');
  if (file.startsWith('.git/')) {
    return { kind: 'deny', reason: 'The .git directory is git’s own state; use git commands.' };
  }
  if (POLICY_PATTERNS.some((pattern) => pattern.test(file))) {
    return { kind: 'ask', reason: `${file}: ${POLICY_EDIT_REASON}` };
  }
  return ALLOW;
}

// Git subcommands that run hooks, and so accept --no-verify.
const HOOKED_SUBCOMMANDS = new Set(['am', 'commit', 'merge', 'push', 'rebase', 'revert']);
const HOOK_SETTINGS = /^core\.hookspath\b/i;
const BYPASS_REASON =
  'This would skip the repository hooks, which hold the same checks as CI. Fix the ' +
  'finding instead; if a hook itself is wrong, ask your human to change it.';

export function commandVerdict(command: string, root: string): Verdict {
  assert(command.length <= COMMAND_CHARS_MAX, 'commandVerdict: command exceeds the size limit');
  assert(path.isAbsolute(root), 'commandVerdict: the root is absolute');
  if (/\.git\/hooks\b/.test(command)) {
    return { kind: 'deny', reason: `Writing git's own hook directory. ${BYPASS_REASON}` };
  }
  for (const segment of commandSegments(command)) {
    const verdict = gitSegmentVerdict(tokenize(segment));
    if (verdict.kind !== 'allow') {
      return verdict;
    }
  }
  return shellWriteVerdict(command, root);
}

// A shell command can write a file as surely as an edit tool can. When one
// both names a gate file and contains a way to write — a redirect, an
// in-place editor, a file-moving command, or an interpreter running a script
// — a human decides, as for an edit. Reading a gate file is always fine. The
// check is a heuristic by nature (a shell is Turing-complete); CI remains the
// gate that cannot be talked around.
const SHELL_WRITE = new RegExp(
  [
    '(?:^|[^>&0-9])>>?(?![&>])',
    '\\btee\\b',
    '\\b(?:sed|perl)\\b[^|;&\\n]*\\s-i',
    '\\b(?:mv|cp|rm|ln|install|truncate|touch|chmod)\\s',
    '\\b(?:python3?|ruby|deno|bun)\\b',
    '\\bnode\\s+(?:-e|--eval|-p|--print)\\b',
    '\\bgit\\s+(?:checkout|restore|apply|am)\\b',
  ].join('|'),
);
const PATH_LIKE = /[\w@.~/-]+/g;

function shellWriteVerdict(command: string, root: string): Verdict {
  if (!SHELL_WRITE.test(command)) {
    return ALLOW;
  }
  const prefix = `${root.split(path.sep).join('/')}/`;
  for (const match of command.matchAll(PATH_LIKE)) {
    const candidate = match[0].replace(/^\.\//, '');
    const file = candidate.startsWith(prefix) ? candidate.slice(prefix.length) : candidate;
    if (POLICY_PATTERNS.some((pattern) => pattern.test(file))) {
      const reason = `This command may write ${file}. ${POLICY_EDIT_REASON}`;
      return { kind: 'ask', reason };
    }
  }
  return ALLOW;
}

function gitSegmentVerdict(tokens: readonly string[]): Verdict {
  const gitIndex = tokens.findIndex((token) => token === 'git' || token.endsWith('/git'));
  if (gitIndex < 0) {
    return ALLOW;
  }
  const rest = tokens.slice(gitIndex + 1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    assert(token !== undefined, 'gitSegmentVerdict: index within tokens');
    // `git -c core.hooksPath=/dev/null commit …`
    if (token === '-c' || token.startsWith('--config-env')) {
      const setting = rest[index + 1] ?? '';
      if (HOOK_SETTINGS.test(setting)) {
        return { kind: 'deny', reason: `Overriding core.hooksPath. ${BYPASS_REASON}` };
      }
    }
  }
  const subcommandIndex = subcommandPosition(rest);
  const subcommand = rest[subcommandIndex];
  const arguments_ = rest.slice(subcommandIndex + 1);
  if (subcommand === 'config') {
    return configVerdict(arguments_);
  }
  if (subcommand === undefined || !HOOKED_SUBCOMMANDS.has(subcommand)) {
    return ALLOW;
  }
  if (arguments_.includes('--no-verify')) {
    return { kind: 'deny', reason: `\`git ${subcommand} --no-verify\`. ${BYPASS_REASON}` };
  }
  // `-n` is --no-verify only for commit; a cluster such as `-anm` includes it.
  if (subcommand === 'commit') {
    if (arguments_.some(isNoVerifyCluster)) {
      return { kind: 'deny', reason: `\`git commit -n\`. ${BYPASS_REASON}` };
    }
  }
  return ALLOW;
}

// Global options before the subcommand that take the next word as their
// value: `git -C ../repo commit` runs commit, not a command named ../repo.
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--super-prefix',
  '--work-tree',
]);

function subcommandPosition(rest: readonly string[]): number {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    assert(token !== undefined, 'subcommandPosition: index within tokens');
    if (GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith('-')) {
      return index;
    }
  }
  return rest.length;
}

// `git config core.hooksPath` reads the setting; with a value, `--unset`, or
// `--replace-all` it changes it.
function configVerdict(arguments_: readonly string[]): Verdict {
  const keyIndex = arguments_.findIndex((token) => HOOK_SETTINGS.test(token));
  if (keyIndex < 0) {
    return ALLOW;
  }
  if (arguments_.some((token) => token === '--get' || token === '--get-all')) {
    return ALLOW;
  }
  const unsets = arguments_.some((token) => token.startsWith('--unset'));
  const hasValue = keyIndex < arguments_.length - 1;
  if (unsets || hasValue) {
    return { kind: 'deny', reason: `Changing core.hooksPath. ${BYPASS_REASON}` };
  }
  return ALLOW;
}

// A short-option cluster that includes n: `-n`, `-an`, `-nm`. A cluster stops
// at the first option that takes a value (m, F, c, C, t, S, u), since the rest
// of the token is that value (`-mnote` is a message).
function isNoVerifyCluster(token: string): boolean {
  if (!/^-[A-Za-z]+$/.test(token)) {
    return false;
  }
  for (const letter of token.slice(1)) {
    if (letter === 'n') {
      return true;
    }
    if ('mFcCtSu'.includes(letter)) {
      return false;
    }
  }
  return false;
}

// Splits a shell command line at the operators that start a new command:
// `;`, `&&`, `||`, `|`, `&`, newlines, and subshell parentheses. Quotes are
// honored so `git commit -m "a; b"` stays one command.
export function commandSegments(command: string): readonly string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);
    if (quote !== undefined) {
      current += character;
      if (character === quote) {
        quote = undefined;
      } else if (character === '\\' && quote === '"') {
        index += 1;
        current += command.charAt(index);
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (';&|\n()`'.includes(character)) {
      segments.push(current);
      current = '';
      assert(segments.length <= SEGMENTS_MAX, 'commandSegments: segment limit exceeded');
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

// Words of one simple command, with quotes removed: `-m "a b"` → `-m`, `a b`.
export function tokenize(segment: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment.charAt(index);
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        assert(tokens.length <= TOKENS_MAX, 'tokenize: token limit exceeded');
      }
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

// The files a Codex `apply_patch` touches, read from its patch headers.
// Every string in the tool input is searched, so the check does not depend on
// which field the harness puts the patch in.
export function patchPaths(input: unknown): readonly string[] {
  const found = new Set<string>();
  for (const text of stringsWithin(input)) {
    for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      found.add((match[1] ?? '').trim());
    }
    for (const match of text.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
      found.add((match[1] ?? '').trim());
    }
  }
  return [...found].filter((file) => file.length > 0);
}

const STRINGS_NODES_MAX = 10_000;

function stringsWithin(input: unknown): readonly string[] {
  const strings: string[] = [];
  const pending: unknown[] = [input];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    assert(visited <= STRINGS_NODES_MAX, 'stringsWithin: payload exceeds the node limit');
    const value = pending.pop();
    if (typeof value === 'string') {
      strings.push(value);
    } else if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      pending.push(...items);
    } else if (typeof value === 'object' && value !== null) {
      const items: readonly unknown[] = Object.values(value);
      pending.push(...items);
    }
  }
  return strings;
}

// A path a tool names, relative to the repository with forward slashes, or
// absent when it lies outside the repository (not this repository's business).
export function repositoryPath(root: string, base: string, file: string): string | undefined {
  assert(path.isAbsolute(root), 'repositoryPath: the root is absolute');
  const relative = normalizePath(root, path.resolve(base, file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}
