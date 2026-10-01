import fs from 'fs';
import path from 'path';
import postcss from 'postcss';
import { writeProjectText } from './documentWrites';
import { MAIN_LIMITS } from './lib/mainLimits';
import { assert } from '../shared/assert';
import type { Declaration, Rule as PostcssRule } from 'postcss';

// Reading a project's CSS custom properties as something an editor can show.
//
// There is no schema here and no convention to lean on: variables are declared
// wherever the author put them, named however they name things, and the only
// structure in the file is the structure a person gave it — which rule they sit
// in, which comment they sit under, and what their names have in common.
//
// So all three are used, in that order:
//
//   the file       one tab per stylesheet, because that is how the author
//                  divided the work in the first place
//   the rule       `:root` is one thing; `.theme-dark` is another. Rules that
//                  declare the same set of names are the same thing seen in
//                  different modes, and become columns of one table.
//   the comment    a comment between declarations is a heading — `/* Swatches
//                  */` says what the next few lines are.
//
// Then the names themselves. `--h1-line-height` and `--text-small-line-height`
// are the same property of two different things, and a list is the wrong shape
// for that: it reads as thirteen unrelated rows repeated eight times. Split at
// the point where the names stop agreeing and it is a table — one row per
// property, one column per thing — which is both shorter and the way the
// author was thinking when they wrote it.

// Folders deeper than the stylesheet bound are not where a project keeps its CSS; the rename walk
// covers the whole project, where a config or a helper module can sit two levels deeper. A
// `var()` chain longer than the resolve bound is shown as written rather than followed.
const CSS_VARIABLE_LIMITS = {
  stylesheetDepthMax: 8,
  renameTargetDepthMax: 10,
  resolveDepthMax: 8,
} as const;

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.astro', '.stacki']);

const toPosix = (filePath: string): string => filePath.split(path.sep).join('/');

// --- reading ---------------------------------------------------------------

function findStylesheets(projectPath: string): string[] {
  const roots = ['src', 'public', 'styles'].map((folder) => path.join(projectPath, folder));
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > CSS_VARIABLE_LIMITS.stylesheetDepthMax) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (/\.css$/i.test(entry.name)) {
        found.push(full);
      }
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }
  return [...new Set(found)].sort();
}

interface VarEntry {
  readonly kind: 'var';
  readonly name: string;
  readonly value: string;
  readonly important: boolean;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly line: number;
}
interface CommentEntry {
  readonly kind: 'comment';
  readonly text: string;
  readonly textStart: number;
  readonly textEnd: number;
}
type Entry = VarEntry | CommentEntry;

interface Rule {
  selector: string;
  selectors: readonly string[];
  context: readonly string[];
  line: number;
  entries: Entry[];
}

/** The indentation in front of `text`, absent when nothing matches (never). */
const leading = (text: string): number => text.match(/^\s*/)?.[0]?.length ?? 0;

// Every custom property declared in one file, with where its value sits in the
// text so it can be written back without reformatting anything around it.
function readDeclarations(text: string): Rule[] {
  const root = postcss.parse(text);
  const rules: Rule[] = [];

  const contextOf = (node: Declaration | PostcssRule): string[] => {
    const parts: string[] = [];
    let parent = node.parent;
    while (parent && parent.type !== 'root') {
      if (parent.type === 'atrule') {
        parts.unshift(`@${parent.name} ${parent.params}`.trim());
      } else if (parent.type === 'rule') {
        parts.unshift(parent.selector);
      }
      parent = parent.parent;
    }
    return parts;
  };

  root.walkRules((rule: PostcssRule) => {
    const entries: Entry[] = [];
    for (const node of rule.nodes || []) {
      if (node.type === 'comment') {
        // Where the words are, inside the `/*` and the spacing postcss keeps in
        // raws: a heading in a single-rule file IS this comment, so renaming it
        // means writing here.
        const open = node.source?.start?.offset ?? 0;
        const textStart = open + 2 + (node.raws?.['left']?.length ?? 0);
        entries.push({
          kind: 'comment',
          text: node.text.trim(),
          textStart,
          textEnd: textStart + node.text.length,
        });
        continue;
      }
      if (node.type !== 'decl' || !node.prop.startsWith('--')) {
        continue;
      }
      // PostCSS offsets end just after the declaration. Including another
      // character can pull the next declaration into a compact CSS value.
      const start = node.source?.start?.offset ?? 0;
      const end = node.source?.end?.offset ?? start;
      const declText = text.slice(start, end);
      const rawValue = node.raws.value?.raw ?? node.value;
      const valueStart =
        start + node.prop.length + (node.raws.between ?? ':').length + leading(rawValue);
      // Trailing `;` and whitespace are not part of the value.
      // PostCSS keeps whitespace in an empty custom property's node.value.
      // That whitespace was already skipped above, so using its length again
      // would consume the semicolon, closing brace, or following declaration.
      const valueEnd = Math.max(valueStart, start + declText.replace(/[\s;]+$/, '').length);
      entries.push({
        kind: 'var',
        name: node.prop,
        value: text.slice(valueStart, valueEnd),
        important: !!node.important,
        valueStart,
        valueEnd,
        line: node.source?.start?.line ?? 0,
      });
    }
    if (!entries.some((entry) => entry.kind === 'var')) {
      return;
    }
    rules.push({
      selector: rule.selector,
      selectors: rule.selectors ?? [],
      context: contextOf(rule),
      line: rule.source?.start?.line ?? 0,
      entries,
    });
  });

  return rules;
}

// --- naming ----------------------------------------------------------------

const titleize = (text: unknown): string =>
  String(text)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());

// What to call a rule. A selector list usually leads with the generic one
// (`:root, .theme-light, …`) and the name people use for it is the specific
// one, so the first plain class wins over `:root`, `*` and anything nested.
function labelForRule(rule: Rule): string {
  const candidates = rule.selectors.length ? rule.selectors : [rule.selector];
  const simpleClass = candidates.find((selector) => /^\.[a-z0-9_-]+$/i.test(selector.trim()));
  const chosen = simpleClass || candidates[0] || rule.selector;
  const cleaned = String(chosen).trim();
  if (cleaned === ':root') {
    return ':root';
  }
  if (/^\.[a-z0-9_-]+$/i.test(cleaned)) {
    return titleize(cleaned.slice(1));
  }
  return cleaned;
}

// The stem shared by a set of labels, for naming a group of modes: "Theme
// light" + "Theme dark" + "Theme brand" → "Theme".
function commonStem(labels: readonly string[]): string {
  if (!labels.length) {
    return '';
  }
  const words = labels.map((label) => label.split(/\s+/));
  const stem: string[] = [];
  for (let i = 0; i < (words[0]?.length ?? 0); i++) {
    const word = words[0]?.[i];
    if (!word || !words.every((labelWords) => labelWords[i] === word)) {
      break;
    }
    stem.push(word);
  }
  return stem.join(' ');
}

// --- grouping --------------------------------------------------------------

const namesOf = (rule: Rule): string[] =>
  rule.entries.filter((entry) => entry.kind === 'var').map((entry) => entry.name);

const overlap = (left: readonly string[], right: readonly string[]): number => {
  const rightSet = new Set(right);
  const shared = left.filter((name) => rightSet.has(name)).length;
  return shared / Math.max(left.length, right.length);
};

// Rules that declare the same names are one thing in several modes — a light
// theme and a dark one, a size scale and its variants. They are shown as
// columns of a single table rather than as three tables nobody can compare.
const MERGE_THRESHOLD = 0.6;

function groupRules(rules: readonly Rule[]): Rule[][] {
  const groups: Rule[][] = [];
  const taken = new Set<number>();

  rules.forEach((rule, index) => {
    if (taken.has(index)) {
      return;
    }
    const names = namesOf(rule);
    const members: Rule[] = [rule];
    taken.add(index);

    for (let other = index + 1; other < rules.length; other++) {
      if (taken.has(other)) {
        continue;
      }
      const candidate = rules[other];
      if (!candidate || candidate.context.join('|') !== rule.context.join('|')) {
        continue;
      }
      const otherNames = namesOf(candidate);
      const same = overlap(names, otherNames);
      // One shared name is only a mode when it is the whole of both rules —
      // a page of utilities each setting `--_gap-size` is a scale, not a
      // coincidence.
      const enough =
        names.length > 1
          ? same >= MERGE_THRESHOLD
          : same === 1 && otherNames.length === names.length;
      if (enough) {
        members.push(candidate);
        taken.add(other);
      }
    }
    groups.push(members);
  });

  return groups;
}

// --- families (the columns inside one rule) --------------------------------

// Every way a name can be cut into a prefix and a suffix at a dash.
function splits(name: string): { prefix: string; suffix: string }[] {
  const body = name.replace(/^--/, '');
  const parts = body.split('-');
  const out: { prefix: string; suffix: string }[] = [];
  for (let at = 1; at < parts.length; at++) {
    out.push({ prefix: parts.slice(0, at).join('-'), suffix: parts.slice(at).join('-') });
  }
  return out;
}

interface Family {
  prefixes: string[];
  rows: string[];
  self: boolean;
}

// The suffixes most of these prefixes declare. "Most" rather than "all",
// because one variant carrying an extra property is normal and should not cost
// everyone else the table.
function rowsFor(
  prefixes: readonly string[],
  bySuffix: Map<string, Set<string>>,
  used: Set<string>,
): string[] {
  const rows: string[] = [];
  for (const [suffix, owners] of bySuffix) {
    const shared = prefixes.filter(
      (prefix) => owners.has(prefix) && !used.has(`--${prefix}-${suffix}`),
    );
    if (shared.length >= Math.max(2, Math.ceil(prefixes.length * 0.5))) {
      rows.push(suffix);
    }
  }
  return rows;
}

/**
 * The tables hiding in a list of names.
 *
 * A family is a set of prefixes that share a set of suffixes: {h1, h2, …} all
 * having {line-height, margin-top, …}. The suffix that the most prefixes agree
 * on picks the family; every other suffix that most of those prefixes also have
 * becomes a row. A name that is only the prefix (`--h1`) is the family's own
 * value, and is the first row.
 */
// Families one stylesheet is read into: a stylesheet, not a database.
const FAMILIES_MAX = 25;

function findFamilies(names: readonly string[]): { families: Family[]; used: Set<string> } {
  const bySuffix = new Map<string, Set<string>>(); // suffix -> Set(prefix)
  for (const name of names) {
    for (const { prefix, suffix } of splits(name)) {
      const owners = bySuffix.get(suffix);
      if (owners) {
        owners.add(prefix);
      } else {
        bySuffix.set(suffix, new Set([prefix]));
      }
    }
  }

  const nameSet = new Set(names);
  const families: Family[] = [];
  const used = new Set<string>();

  while (families.length < FAMILIES_MAX) {
    const best = bestFamilySeed(bySuffix, nameSet, used);
    if (best === undefined) {
      break;
    }
    const family = familyFrom(best, names, nameSet);
    assert(family.prefixes.length >= 2, 'findFamilies: a family has at least two columns');
    const sizeBefore = used.size;
    // `--h1` itself, if it exists: the value the family is named for.
    if (family.self) {
      for (const prefix of family.prefixes) {
        used.add(`--${prefix}`);
      }
    }
    for (const suffix of family.rows) {
      for (const prefix of family.prefixes) {
        used.add(`--${prefix}-${suffix}`);
      }
    }
    // Every family claims names nobody had, so the search ends before the bound in practice.
    assert(used.size > sizeBefore, 'findFamilies: a family claims new names');
    families.push(family);
  }

  return { families, used };
}

interface FamilySeed {
  readonly score: number;
  readonly prefixes: readonly string[];
  readonly rows: string[];
}

// Every suffix is a candidate seed: the prefixes that share it might be a
// family. Which one is picked matters — `--h1-margin-top` and
// `--h1-trim-top` both end in `top`, so "top" seeds a wide, shallow family
// of fourteen `*-margin`/`*-trim` prefixes that would eat two rows out of
// the real one. The family that accounts for the most declarations wins,
// which is the deep one: seven headings by thirteen properties.
function bestFamilySeed(
  bySuffix: Map<string, Set<string>>,
  nameSet: ReadonlySet<string>,
  used: Set<string>,
): FamilySeed | undefined {
  let best: FamilySeed | undefined = undefined;
  for (const [suffix, prefixes] of bySuffix) {
    const seed = [...prefixes].filter((prefix) => !used.has(`--${prefix}-${suffix}`));
    if (seed.length < 2) {
      continue;
    }
    const rows = rowsFor(seed, bySuffix, used);
    // A prefix that is also a variable of its own — `--gap-1` beside
    // `--gap-1-min` — is a row too: the family's own value. Without counting
    // it, a scale with one part each looks like a single-row table and stays
    // a list.
    const self = seed.some((prefix) => nameSet.has(`--${prefix}`) && !used.has(`--${prefix}`));
    const height = rows.length + (self ? 1 : 0);
    if (height < 2) {
      continue;
    }
    const score = seed.length * height;
    if (!best || score > best.score) {
      best = { score, prefixes: seed, rows };
    }
  }
  return best;
}

// The family a seed describes, with its rows and columns in source order: the order the author
// chose, rather than anything alphabetical.
function familyFrom(
  best: FamilySeed,
  names: readonly string[],
  nameSet: ReadonlySet<string>,
): Family {
  const { prefixes } = best;
  const order = new Map<string, number>();
  names.forEach((name, index) => {
    for (const { prefix, suffix } of splits(name)) {
      if (prefixes.includes(prefix) && !order.has(suffix)) {
        order.set(suffix, index);
      }
    }
  });
  const rows = [...best.rows].sort(
    (left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0),
  );

  const columnOrder = new Map<string, number>();
  names.forEach((name, index) => {
    const body = name.replace(/^--/, '');
    for (const prefix of prefixes) {
      if ((body === prefix || body.startsWith(`${prefix}-`)) && !columnOrder.has(prefix)) {
        columnOrder.set(prefix, index);
      }
    }
  });
  const columns = [...prefixes].sort(
    (left, right) => (columnOrder.get(left) ?? 0) - (columnOrder.get(right) ?? 0),
  );
  const self = columns.some((prefix) => nameSet.has(`--${prefix}`));
  return { prefixes: columns, rows, self };
}

// --- sections --------------------------------------------------------------

// Names sharing a leading part, where that part is not itself a variable:
// `--selection-background` and `--selection-text` belong to the selection,
// while `--background` and `--background-2` do not belong to a background —
// there is one, and it is a variable in its own right.
//
// The longest shared start wins, so `--button-2-*` is its own thing rather than
// six more rows of `--button-*`.
function prefixSections(names: readonly string[]): {
  loose: string[];
  sections: Map<string, string[]>;
} {
  const nameSet = new Set(names);
  const counts = new Map<string, number>();
  for (const name of names) {
    const body = name.replace(/^--/, '');
    const parts = body.split('-');
    for (let at = 1; at < parts.length; at++) {
      const prefix = parts.slice(0, at).join('-');
      if (nameSet.has(`--${prefix}`)) {
        continue;
      }
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
  }

  const qualifies = (prefix: string): boolean => (counts.get(prefix) || 0) >= 2;
  const assigned = new Map<string, string[]>(); // prefix -> [names]
  const loose: string[] = [];
  for (const name of names) {
    const body = name.replace(/^--/, '');
    const parts = body.split('-');
    let chosen: string | undefined = undefined;
    for (let at = 1; at < parts.length; at++) {
      const prefix = parts.slice(0, at).join('-');
      if (qualifies(prefix)) {
        chosen = prefix;
      }
    }
    if (!chosen) {
      loose.push(name);
      continue;
    }
    const group = assigned.get(chosen);
    if (group) {
      group.push(name);
    } else {
      assigned.set(chosen, [name]);
    }
  }

  // A section of one is not a section — those names go back in the main list,
  // in the place they were declared.
  const sections = new Map<string, string[]>();
  const orphans = new Set<string>();
  for (const [prefix, group] of assigned) {
    if (group.length >= 2) {
      sections.set(prefix, group);
    } else {
      group.forEach((name) => orphans.add(name));
    }
  }
  const mainList = names.filter((name) => loose.includes(name) || orphans.has(name));
  return { loose: mainList, sections };
}

// --- what a value is ---------------------------------------------------------
//
// A variable is worth showing as a swatch when it resolves to a colour, and
// resolving means following `var(--x)` until it stops moving. Two things stop
// it: a value with no variables left in it, and a value that cannot be worked
// out at all — `color-mix(in lab, currentcolor 10%, transparent)` depends on
// what it lands on, and no editor can preview that honestly.

const NAMED_COLORS = new Set([
  'transparent',
  'currentcolor',
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'gray',
  'grey',
  'brown',
  'cyan',
  'magenta',
  'lime',
  'navy',
  'teal',
  'olive',
  'maroon',
  'silver',
  'gold',
  'beige',
  'ivory',
  'coral',
  'salmon',
  'khaki',
  'indigo',
  'violet',
]);

const COLOR_FUNCTION = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

function resolveValue(value: unknown, map: Map<string, string>, depth = 0): string {
  if (depth > CSS_VARIABLE_LIMITS.resolveDepthMax) {
    return String(value);
  }
  const next = String(value).replace(
    /var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (whole: string, name: string, fallback: string | undefined) => {
      const found = map.get(name);
      if (found !== undefined) {
        return found;
      }
      return fallback !== undefined ? fallback.trim() : whole;
    },
  );
  return next === String(value) ? next : resolveValue(next, map, depth + 1);
}

function colorOf(resolved: unknown): string | undefined {
  const value = String(resolved).trim();
  if (!value) {
    return undefined;
  }
  if (/^#[0-9a-f]{3,8}$/i.test(value)) {
    return value;
  }
  if (COLOR_FUNCTION.test(value)) {
    return value;
  }
  if (NAMED_COLORS.has(value.toLowerCase())) {
    return value;
  }
  return undefined;
}

// True for values that name a colour but cannot be drawn as one — the swatch
// shows a checkerboard rather than pretending.
const isUncomputableColor = (resolved: unknown): boolean =>
  /(^|\s|\()color-mix\(/i.test(String(resolved));

// What kind of thing a variable holds, which is what picks its glyph — the same
// four the style panel's variable picker uses, so a colour is a droplet in both
// places and a bare number is a number in both.
const FONT_WORDS = new RegExp(
  '(serif|sans-serif|monospace|cursive|system-ui|uppercase|lowercase|capitalize|' +
    'balance|pretty|italic|normal|inherit)',
  'i',
);

function kindOf(value: unknown, resolved: unknown): string {
  const text = String(resolved ?? value).trim();
  if (!text) {
    return 'size';
  }
  if (colorOf(text) || isUncomputableColor(text)) {
    return 'color';
  }
  // Unitless: a line height, a weight, a column count, a fluid-scale bound.
  if (/^-?\d*\.?\d+$/.test(text)) {
    return 'number';
  }
  if (/^-?\d*\.?\d+([a-z%]+)$/i.test(text) || /^(calc|clamp|min|max)\(/i.test(text)) {
    return 'size';
  }
  if (
    /[a-z]/i.test(text) &&
    (FONT_WORDS.test(text) || text.includes(',') || /^[a-z-]+$/i.test(text))
  ) {
    return 'font';
  }
  return 'size';
}

// --- the model -------------------------------------------------------------

interface Column {
  readonly id: string;
  readonly label: string;
  readonly selector: string;
  readonly context: readonly string[];
  readonly line: number;
}

interface Cell {
  readonly name: string;
  readonly value: string;
  readonly file: string;
  readonly selector: string;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly line: number;
  readonly column: string;
}

interface Row {
  readonly label: string;
  readonly name?: string;
  // Reassigned centrally in readVariables once cells are described.
  cells: (Cell | undefined)[];
}

interface Block {
  readonly kind: 'rows' | 'matrix';
  readonly title: string | undefined;
  readonly titleStart?: number;
  readonly titleEnd?: number;
  readonly rows: Row[];
  readonly columns?: Column[];
}

interface Group {
  readonly kind: 'modes' | 'single';
  readonly label: string;
  readonly columns: Column[];
  readonly blocks: Block[];
}

interface FileModel {
  readonly rel: string;
  readonly name: string;
  readonly groups: Group[];
  readonly error?: string;
  readonly count?: number;
  declarations?: Rule[];
}

// A variable entry with the rule it came from attached, so a move can look the
// declaration up by selector after the model has travelled to the renderer.
interface TaggedVar extends VarEntry {
  readonly selector: string;
}

function buildGroup(members: readonly Rule[], file: string): Group {
  assert(members.length > 0, 'buildGroup: a group has at least one rule');
  const columns = members.map((rule, index) => ({
    id: `${index}`,
    label: labelForRule(rule),
    selector: rule.selector,
    context: rule.context,
    line: rule.line,
  }));
  const byName = members.map((rule): Map<string, TaggedVar> => {
    const map = new Map<string, TaggedVar>();
    for (const entry of rule.entries) {
      if (entry.kind === 'var') {
        map.set(entry.name, { ...entry, selector: rule.selector });
      }
    }
    return map;
  });

  if (members.length > 1) {
    return modesGroup(columns, byName, file);
  }
  // One rule: comments are headings, and the names inside each heading may form
  // tables of their own.
  const rule = members[0];
  if (!rule) {
    return { kind: 'single', label: '', columns, blocks: [] };
  }
  const blocks = commentSections(rule).flatMap((section) =>
    sectionBlocks(section, rule, byName[0], file),
  );
  return { kind: 'single', label: labelForRule(rule), columns, blocks };
}

// Several rules declaring the same names: the columns are the modes, so the names are the rows.
// Sub-sections come from shared prefixes.
function modesGroup(
  columns: Column[],
  byName: readonly Map<string, TaggedVar>[],
  file: string,
): Group {
  const cellsFor = (name: string): (Cell | undefined)[] =>
    byName.map((map, index) => cellFor(map, name, file, columns[index]?.id ?? ''));
  const names: string[] = [];
  for (const map of byName) {
    for (const name of map.keys()) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }
  const blocks: Block[] = [];
  const { loose, sections } = prefixSections(names);
  if (loose.length) {
    blocks.push({
      kind: 'rows',
      title: undefined,
      rows: loose.map((name) => ({ label: shortLabel(name), name, cells: cellsFor(name) })),
    });
  }
  for (const [prefix, group] of sections) {
    blocks.push({
      kind: 'rows',
      title: prefix,
      rows: group.map((name) => ({
        label: shortLabel(name, prefix),
        name,
        cells: cellsFor(name),
      })),
    });
  }
  const firstLabel = columns[0]?.label ?? '';
  return {
    kind: 'modes',
    label: commonStem(columns.map((column) => column.label)) || firstLabel,
    columns,
    blocks,
  };
}

// The names under one comment heading of a rule, with the heading's span in the file.
interface CommentSection {
  title: string | undefined;
  titleStart?: number;
  titleEnd?: number;
  names: string[];
}

function commentSections(rule: Rule): CommentSection[] {
  const sections: CommentSection[] = [];
  let current: CommentSection = { title: undefined, names: [] };
  for (const entry of rule.entries) {
    if (entry.kind === 'comment') {
      // A heading with nothing under it is kept. It used to be dropped, which
      // was tidy right up until the panel grew a way to MAKE one: a new group
      // starts empty, and a group you cannot see is one you cannot fill.
      // (Untitled runs with no names are still nothing at all.)
      if (current.names.length || current.title !== undefined) {
        sections.push(current);
      }
      current = {
        title: entry.text,
        titleStart: entry.textStart,
        titleEnd: entry.textEnd,
        names: [],
      };
      continue;
    }
    current.names.push(entry.name);
  }
  if (current.names.length || current.title !== undefined) {
    sections.push(current);
  }
  return sections;
}

// One heading's blocks: a matrix per family its names form, then a list of whatever is left.
function sectionBlocks(
  section: CommentSection,
  rule: Rule,
  map: Map<string, TaggedVar> | undefined,
  file: string,
): Block[] {
  const blocks: Block[] = [];
  const { families, used } = findFamilies(section.names);
  const claimed = new Set<string>();
  for (const family of families) {
    const rows: Row[] = [];
    if (family.self) {
      rows.push({
        label: 'value',
        cells: family.prefixes.map((prefix) => cellFor(map, `--${prefix}`, file, '0')),
      });
      for (const prefix of family.prefixes) {
        claimed.add(`--${prefix}`);
      }
    }
    for (const suffix of family.rows) {
      rows.push({
        label: suffix,
        cells: family.prefixes.map((prefix) => cellFor(map, `--${prefix}-${suffix}`, file, '0')),
      });
      for (const prefix of family.prefixes) {
        claimed.add(`--${prefix}-${suffix}`);
      }
    }
    blocks.push({
      kind: 'matrix',
      title: section.title,
      columns: family.prefixes.map((prefix): Column => ({
        id: prefix,
        label: prefix,
        selector: rule.selector,
        context: rule.context,
        line: rule.line,
      })),
      rows: rows.filter((row) => row.cells.some(Boolean)),
      // The inner sections of a one-rule file carry their comment's span so
      // the heading can be renamed in place; a comment-less section has none.
      ...(section.titleStart !== undefined
        ? { titleStart: section.titleStart, titleEnd: section.titleEnd }
        : {}),
    });
  }
  const leftovers = section.names.filter((name) => !claimed.has(name) && !used.has(name));
  if (leftovers.length || (!families.length && section.title !== undefined)) {
    blocks.push({
      kind: 'rows',
      title: families.length ? undefined : section.title,
      rows: leftovers.map((name) => ({
        label: shortLabel(name),
        name,
        cells: [cellFor(map, name, file, '0')],
      })),
      ...(families.length ? {} : { titleStart: section.titleStart, titleEnd: section.titleEnd }),
    });
  }
  return blocks;
}

function cellFor(
  map: Map<string, TaggedVar> | undefined,
  name: string,
  file: string,
  column: string,
): Cell | undefined {
  const entry = map?.get(name);
  if (!entry) {
    return undefined;
  }
  return {
    name,
    value: entry.value,
    file,
    selector: entry.selector,
    valueStart: entry.valueStart,
    valueEnd: entry.valueEnd,
    line: entry.line,
    column,
  };
}

interface DescribedCell extends Cell {
  // Absent rather than undefined, so the cell a renderer parses back is the cell sent.
  readonly ref?: string;
  readonly resolved?: string;
  readonly color?: string;
  readonly unknownColor: boolean;
  readonly kind: string;
}

// A cell's value said three ways: what the file holds, what it comes out as,
// and what colour to draw beside it (if any).
function describeCell(cell: Cell | undefined, map: Map<string, string>): DescribedCell | undefined {
  if (!cell) {
    return undefined;
  }
  const single = String(cell.value)
    .trim()
    .match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/);
  const resolved = resolveValue(cell.value, map);
  const ref = single?.[1];
  const color = colorOf(resolved);
  return {
    ...cell,
    // A value that is nothing but another variable is shown as that variable's
    // name — which is what the author wrote, and what they would search for.
    ...(ref === undefined ? {} : { ref }),
    ...(resolved === cell.value ? {} : { resolved }),
    ...(color === undefined ? {} : { color }),
    unknownColor: isUncomputableColor(resolved),
    kind: kindOf(cell.value, resolved),
  };
}

const shortLabel = (name: string, prefix?: string): string => {
  const body = name.replace(/^--/, '');
  return prefix && body.startsWith(`${prefix}-`) ? body.slice(prefix.length + 1) : body;
};

/**
 * Every stylesheet in the project that declares custom properties, as groups of
 * tables. Files with none are left out — a variables panel is a place to find
 * variables, not a file browser.
 */
function readVariables(projectPath: string): {
  files: FileModel[];
  values: Record<string, string>;
} {
  const files: FileModel[] = [];
  for (const abs of findStylesheets(projectPath)) {
    let text: string;
    try {
      if (fs.statSync(abs).size > MAIN_LIMITS.cssVariableFileBytesMax) {
        continue;
      }
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = toPosix(path.relative(projectPath, abs));
    let rules: Rule[];
    try {
      rules = readDeclarations(text);
    } catch (error: unknown) {
      files.push({
        rel,
        name: path.basename(abs),
        error: `Could not parse — ${error instanceof Error ? error.message : String(error)}`,
        groups: [],
      });
      continue;
    }
    if (!rules.length) {
      continue;
    }
    const groups = groupRules(rules).map((members) => buildGroup(members, rel));
    files.push({
      rel,
      name: path.basename(abs),
      groups,
      declarations: rules,
      count: rules.reduce((sum, rule) => sum + namesOf(rule).length, 0),
    });
  }
  // Values reference each other across files as freely as within one, so the
  // map every value is resolved against is the project's, not the file's.
  const map = new Map<string, string>();
  for (const file of files) {
    for (const rule of file.declarations || []) {
      for (const entry of rule.entries) {
        if (entry.kind === 'var') {
          map.set(entry.name, entry.value);
        }
      }
    }
  }
  const values = Object.fromEntries(map);
  for (const file of files) {
    delete file.declarations;
    for (const group of file.groups) {
      for (const block of group.blocks) {
        for (const row of block.rows) {
          row.cells = row.cells.map((cell) => describeCell(cell, map));
        }
      }
    }
  }
  return { files, values };
}

interface SetValuePayload {
  readonly file: string;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly expect?: string;
  readonly value: string;
}

/**
 * Replaces one variable's value in place. The value it is replacing has to be
 * the value that was read, or the file has changed underneath the panel and the
 * offsets no longer mean anything.
 */
function setVariable(
  projectPath: string,
  { file, valueStart, valueEnd, expect, value }: SetValuePayload,
): { ok: boolean; stale?: boolean; error?: string } {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  const current = text.slice(valueStart, valueEnd);
  if (expect !== undefined && current !== expect) {
    return { ok: false, stale: true, error: 'This file changed since the panel read it.' };
  }
  const next = text.slice(0, valueStart) + value + text.slice(valueEnd);
  writeProjectText(abs, next);
  return { ok: true };
}

interface SectionRangePayload {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly expect?: string;
  readonly title?: string;
}

/**
 * Renames a heading that is a comment.
 *
 * A file with one rule takes its headings from the comments in it, so the
 * heading is not a property of anything — it is those words, and renaming it is
 * writing them. Like a value, it is written back only if the file still says
 * what the panel read.
 */
function setSectionTitle(
  projectPath: string,
  { file, start, end, expect, title }: SectionRangePayload,
): { ok: boolean; stale?: boolean; error?: string } {
  const next = String(title ?? '').trim();
  if (!next) {
    return { ok: false, error: 'A heading needs a name.' };
  }
  // The words live inside a comment, and `*/` would end it early — the rest of
  // the rule would become the comment's text and the variables under it would
  // stop existing.
  if (next.includes('*/')) {
    return { ok: false, error: 'A heading cannot contain "*/".' };
  }

  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  const current = text.slice(start, end);
  if (expect !== undefined && current !== expect) {
    return { ok: false, stale: true, error: 'This file changed since the panel read it.' };
  }
  writeProjectText(abs, text.slice(0, start) + next + text.slice(end));
  return { ok: true };
}

/**
 * Removes a heading that is a comment.
 *
 * The variables under it do not go anywhere — they join the section above,
 * which is what a heading meant in the first place: a line drawn between two
 * runs of declarations. Rubbing the line out leaves both runs.
 *
 * Takes the same range as a rename (where the WORDS are) and grows outwards to
 * the `/*` and `*\/` around them, then to the whole line when the comment has
 * one to itself — a heading removed by cutting the words alone would leave an
 * empty comment behind.
 */
function removeSection(
  projectPath: string,
  { file, start, end, expect }: SectionRangePayload,
): { ok: boolean; stale?: boolean; error?: string } {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  if (expect !== undefined && text.slice(start, end) !== expect) {
    return { ok: false, stale: true, error: 'This file changed since the panel read it.' };
  }
  const open = text.lastIndexOf('/*', start);
  const close = text.indexOf('*/', end);
  if (open === -1 || close === -1) {
    return { ok: false, error: 'That heading is no longer a comment.' };
  }
  let from = open;
  let to = close + 2;
  // A line of its own goes with it; a comment sharing a line with something
  // else leaves that something else where it is.
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const lineEnd = text.indexOf('\n', to);
  const before = text.slice(lineStart, from);
  const after = text.slice(to, lineEnd === -1 ? text.length : lineEnd);
  if (!before.trim() && !after.trim()) {
    from = lineStart;
    to = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  writeProjectText(abs, text.slice(0, from) + text.slice(to));
  return { ok: true };
}

interface MoveHeadingPayload {
  readonly file: string;
  readonly selector: string;
  readonly start: number;
  readonly end: number;
  readonly expect?: string;
  readonly before?: string;
}

/**
 * Moves a heading, and only the heading.
 *
 * The variables do not travel with it, because they were never inside it: a
 * group is the run of lines between one comment and the next, so dragging a
 * comment up past three variables is how those three variables come to be under
 * it. Moving the run wholesale is a different gesture (moveSection) and a
 * different intent.
 *
 * `before` is the declaration it should sit above; null puts it after the last
 * one, where it heads whatever is added next.
 */
function moveHeading(
  projectPath: string,
  { file, selector, start, end, expect, before }: MoveHeadingPayload,
): { ok: boolean; stale?: boolean; error?: string } {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  if (expect !== undefined && text.slice(start, end) !== expect) {
    return { ok: false, stale: true, error: 'This file changed since the panel read it.' };
  }
  const open = text.lastIndexOf('/*', start);
  const close = text.indexOf('*/', end);
  if (open === -1 || close === -1) {
    return { ok: false, error: 'That heading is no longer a comment.' };
  }

  const comment = text.slice(open, close + 2);
  let from = open;
  let to = close + 2;
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const lineEnd = text.indexOf('\n', to);
  if (
    !text.slice(lineStart, from).trim() &&
    !text.slice(to, lineEnd === -1 ? text.length : lineEnd).trim()
  ) {
    from = lineStart;
    to = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  const cut = text.slice(0, from) + text.slice(to);

  const root = postcss.parse(cut);
  const matches: PostcssRule[] = [];
  root.walkRules((candidate) => {
    if (candidate.selector === selector) {
      matches.push(candidate);
    }
  });
  const rule = matches[0];
  if (!rule) {
    return { ok: false, error: `${selector} is no longer in ${file}.` };
  }

  const decls = (rule.nodes || []).filter((node) => node.type === 'decl');
  const anchorDecl = before ? decls.find((declaration) => declaration.prop === before) : undefined;
  let at: number;
  if (anchorDecl) {
    const offset = anchorDecl.source?.start?.offset ?? 0;
    at = cut.lastIndexOf('\n', offset - 1) + 1;
  } else {
    // After everything: the line following the last declaration, or just inside
    // the brace when the rule has none left.
    const last = decls[decls.length - 1];
    if (last) {
      const offset = last.source?.end?.offset ?? 0;
      const nl = cut.indexOf('\n', offset);
      at = nl === -1 ? cut.length : nl + 1;
    } else {
      const openOffset = rule.source?.start?.offset ?? 0;
      at = cut.indexOf('{', openOffset) + 2;
    }
  }
  const indent = cut.slice(cut.lastIndexOf('\n', at - 1) + 1, at).match(/^\s*/)?.[0] || '  ';
  writeProjectText(abs, `${cut.slice(0, at)}${indent}${comment}\n${cut.slice(at)}`);
  return { ok: true };
}

interface AddSectionPayload {
  readonly file: string;
  readonly selector: string;
  readonly title?: string;
  readonly before?: string;
  readonly at?: number;
}

/**
 * Writes another heading into the rule.
 *
 * A heading is a line between declarations, so a second one is how a run of
 * variables becomes two runs — and an empty one, written directly above another
 * heading, is a group waiting to be filled.
 *
 * `at` puts it on the line holding that offset (above an existing heading);
 * `before` puts it above a named declaration. Either way it takes the
 * indentation of the line it lands on.
 */
function addSection(
  projectPath: string,
  { file, selector, title, before, at }: AddSectionPayload,
): { ok: boolean; error?: string; stale?: boolean; title?: string } {
  const next = String(title ?? '').trim();
  if (!next) {
    return { ok: false, error: 'A heading needs a name.' };
  }
  if (next.includes('*/')) {
    return { ok: false, error: 'A heading cannot contain "*/".' };
  }

  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');

  let offset = at;
  if (typeof offset !== 'number') {
    const matches: PostcssRule[] = [];
    const root = postcss.parse(text);
    root.walkRules((candidate) => {
      if (candidate.selector === selector) {
        matches.push(candidate);
      }
    });
    const rule = matches[0];
    if (!rule) {
      return { ok: false, error: `${selector} is no longer in ${file}.` };
    }
    const decls = (rule.nodes || []).filter((node) => node.type === 'decl');
    const anchorDecl =
      (before && decls.find((declaration) => declaration.prop === before)) ||
      decls[decls.length - 1] ||
      undefined;
    if (!anchorDecl) {
      return { ok: false, error: `${selector} has nothing to head.` };
    }
    offset = anchorDecl.source?.start?.offset ?? 0;
  }
  const sane = offset > text.length ? text.length : offset < 0 ? 0 : offset;
  if (sane < 0 || sane > text.length) {
    return { ok: false, error: 'That place is no longer in the file.' };
  }

  const lineStart = text.lastIndexOf('\n', sane - 1) + 1;
  const indent = text.slice(lineStart, sane).match(/^\s*/)?.[0] ?? '';
  const heading = `${indent}/* ${next} */\n`;
  writeProjectText(abs, `${text.slice(0, lineStart)}${heading}${text.slice(lineStart)}`);
  return { ok: true, title: next };
}

interface MoveVariablePayload {
  readonly file: string;
  readonly selector: string;
  readonly name: string;
  readonly target?: string;
  readonly at?: number;
}

// A declaration owns its whole line: the indentation in front of it and the
// newline after it. Taking less leaves a blank line behind and lands the moved
// line inside another one.
interface SourcedNode {
  readonly source?: {
    readonly start?: { readonly offset?: number };
    readonly end?: { readonly offset?: number };
  };
}

function lineSpan(text: string, node: SourcedNode): { from: number; to: number } {
  const start = node.source?.start?.offset ?? 0;
  // `postcss` ends a declaration on its last character, which for a line that
  // ends in a newline IS that newline — so the search for the end of the line
  // starts there, not after it, or the span swallows the line below.
  const end = node.source?.end?.offset ?? start;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nextLine = text.indexOf('\n', end);
  return { from: lineStart, to: nextLine === -1 ? text.length : nextLine + 1 };
}

/**
 * Moves one declaration to sit before another inside the same rule. The panel
 * reorders rows; the file is what actually holds the order, so a row that moves
 * moves the line — indentation, trailing comment and all — rather than being
 * rewritten somewhere else.
 *
 * `target` is the name to land in front of; null means the end of the rule.
 */
function moveVariable(
  projectPath: string,
  { file, selector, name, target, at: landAt }: MoveVariablePayload,
): { ok: boolean; error?: string; changed?: boolean } {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  const root = postcss.parse(text);

  const matches: PostcssRule[] = [];
  root.walkRules((candidate) => {
    if (candidate.selector === selector) {
      matches.push(candidate);
    }
  });
  const rule = matches[0];
  if (!rule) {
    return { ok: false, error: `${selector} is no longer in ${file}.` };
  }

  const declOf = (prop: string): Declaration | undefined =>
    (rule.nodes || []).find(
      (node): node is Declaration => node.type === 'decl' && node.prop === prop,
    );
  const moved = declOf(name);
  if (!moved) {
    return { ok: false, error: `${name} is no longer declared there.` };
  }
  const before = target ? declOf(target) : undefined;
  if (target && !before) {
    return { ok: false, error: `${target} is no longer declared there.` };
  }

  const span = lineSpan(text, moved);
  const line = text.slice(span.from, span.to);
  // Landing in front of a declaration is not enough on its own: a group ends at
  // a COMMENT, and "in front of the next declaration" steps over that comment
  // and into the next group. So a drop at the end of a group says where it
  // means, as an offset — the start of the line the variable should land above,
  // comment or not.
  const allDecls = (rule.nodes || []).filter((node) => node.type === 'decl');
  const lastDecl = allDecls[allDecls.length - 1] ?? moved;
  const at =
    typeof landAt === 'number'
      ? text.lastIndexOf('\n', Math.max(0, Math.min(landAt, text.length)) - 1) + 1
      : before
        ? lineSpan(text, before).from
        : lineSpan(text, lastDecl).to;

  // Cut first, then insert at a position corrected for the cut.
  const withoutLine = text.slice(0, span.from) + text.slice(span.to);
  const insertAt = at > span.from ? at - (span.to - span.from) : at;
  const next = withoutLine.slice(0, insertAt) + line + withoutLine.slice(insertAt);
  if (next === text) {
    return { ok: true, changed: false };
  }
  writeProjectText(abs, next);
  return { ok: true, changed: true };
}

interface MoveSectionPayload {
  readonly file: string;
  readonly selector: string;
  readonly names: readonly string[];
  readonly target?: string;
}

/**
 * Moves a whole group — the comment that heads it and every declaration under
 * it — to sit in front of another group's first declaration, or to the end of
 * the rule. Same idea as moving one row, except that a group is several lines
 * that are not always next to each other (a family's names interleave), so they
 * are cut out and re-inserted together, in the order they were in.
 */
function moveSection(
  projectPath: string,
  { file, selector, names, target }: MoveSectionPayload,
): { ok: boolean; error?: string; changed?: boolean } {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  const root = postcss.parse(text);

  const matches: PostcssRule[] = [];
  root.walkRules((candidate) => {
    if (candidate.selector === selector) {
      matches.push(candidate);
    }
  });
  const rule = matches[0];
  if (!rule) {
    return { ok: false, error: `${selector} is no longer in ${file}.` };
  }

  const nodes = rule.nodes || [];
  const declOf = (prop: string): Declaration | undefined =>
    nodes.find((node): node is Declaration => node.type === 'decl' && node.prop === prop);

  const decls = names
    .map(declOf)
    .filter((declaration): declaration is Declaration => declaration !== undefined);
  const firstDecl = decls[0];
  if (!firstDecl) {
    return { ok: false, error: 'Those variables are no longer declared there.' };
  }

  const spans = decls.map((declaration) => lineSpan(text, declaration));
  const firstSpan = spans[0];
  if (!firstSpan) {
    return { ok: false, error: 'Those variables are no longer declared there.' };
  }
  // The comment above the first one is the group's name — it goes too.
  const firstAt = nodes.indexOf(firstDecl);
  const heading =
    firstAt > 0 && nodes[firstAt - 1]?.type === 'comment' ? nodes[firstAt - 1] : undefined;
  if (heading?.type === 'comment') {
    spans.unshift(lineSpan(text, heading));
  }

  spans.sort((left, right) => left.from - right.from);
  // The blank line under a group belongs to it — leaving it behind closes the
  // gap where the group was and glues the group to whatever it lands on.
  const last = spans[spans.length - 1] ?? firstSpan;
  const blank = text.slice(last.to).match(/^[ \t]*\r?\n/);
  if (blank) {
    last.to += blank[0]?.length ?? 0;
  }
  let block = spans.map((span) => text.slice(span.from, span.to)).join('');

  const landing = target ? declOf(target) : undefined;
  if (target && !landing) {
    return { ok: false, error: `${target} is no longer declared there.` };
  }
  // In front of the target group's own heading, if it has one.
  const landingAt = landing ? nodes.indexOf(landing) : -1;
  const landingHeading = landingAt > 0 ? nodes[landingAt - 1] : undefined;
  const lastDecl = decls[decls.length - 1] ?? firstDecl;
  const at = landing
    ? lineSpan(text, landingHeading?.type === 'comment' ? landingHeading : landing).from
    : lineSpan(text, lastDecl).to;
  // At the end of the rule there is nothing to separate from below, so the
  // group keeps its gap above instead of leaving one before the closing brace.
  if (!landing) {
    block = block.replace(/(?:[ \t]*\r?\n)+$/, '\n').replace(/^/, '\n');
  } else if (!/\n[ \t]*\r?\n$/.test(block)) {
    block += '\n';
  }

  const next = cutAndInsert(text, spans, block, at);
  if (next === text) {
    return { ok: true, changed: false };
  }
  writeProjectText(abs, next);
  return { ok: true, changed: true };
}

// The text with every span cut out and `block` inserted at `at`, an offset into the text as it
// was before the cut.
function cutAndInsert(
  text: string,
  spans: readonly { readonly from: number; readonly to: number }[],
  block: string,
  at: number,
): string {
  // Cut from the bottom up so the offsets above stay valid, then insert at the
  // target corrected for everything removed before it.
  let out = text;
  for (const span of [...spans].reverse()) {
    out = out.slice(0, span.from) + out.slice(span.to);
  }
  const removedBefore = spans.reduce(
    (sum, span) => (span.to <= at ? sum + (span.to - span.from) : sum),
    0,
  );
  const insertAt = at - removedBefore;
  // The spans cut before `at` all end at or before it, so they never sum past it.
  assert(insertAt >= 0, 'cutAndInsert: the insertion point is not before the text');
  return out.slice(0, insertAt) + block + out.slice(insertAt);
}

interface AddVariablePayload {
  readonly file: string;
  readonly selector: string;
  readonly name: string;
  readonly value?: string;
  readonly after?: string;
}

/**
 * Adds a declaration to a rule, under the group it belongs to. `after` is the
 * name it should follow — the last variable of that group — so a new one lands
 * at the bottom of its own group rather than at the bottom of the rule, which
 * for a file like this would be two hundred lines away from what it belongs to.
 */
function addVariable(
  projectPath: string,
  { file, selector, name, value = 'unset', after }: AddVariablePayload,
): { ok: boolean; error?: string; name?: string } {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  const root = postcss.parse(text);

  const matches: PostcssRule[] = [];
  root.walkRules((candidate) => {
    if (candidate.selector === selector) {
      matches.push(candidate);
    }
  });
  const rule = matches[0];
  if (!rule) {
    return { ok: false, error: `${selector} is no longer in ${file}.` };
  }

  const decls = (rule.nodes || []).filter((node) => node.type === 'decl');
  if (decls.some((declaration) => declaration.prop === name)) {
    return { ok: false, error: `${name} is already declared in ${selector}.` };
  }

  const previous =
    (after && decls.find((declaration) => declaration.prop === after)) ||
    decls[decls.length - 1] ||
    undefined;
  const indentOf = (node: Declaration): string => {
    const start = node.source?.start?.offset ?? 0;
    return text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
  };
  const line = `${previous ? indentOf(previous) : '  '}${name}: ${value};\n`;

  let at: number;
  if (previous) {
    const end = previous.source?.end?.offset ?? 0;
    const nextLine = text.indexOf('\n', end);
    at = nextLine === -1 ? text.length : nextLine + 1;
  } else {
    // An empty rule: just inside the brace.
    const openOffset = rule.source?.start?.offset ?? 0;
    at = text.indexOf('{', openOffset) + 2;
  }

  writeProjectText(abs, text.slice(0, at) + line + text.slice(at));
  return { ok: true, name };
}

// --- renaming ----------------------------------------------------------------
//
// A custom property's name is not kept anywhere but in the text: it is the
// declaration `--brand: …` and every `var(--brand)` that reads it, spread across
// however many stylesheets and components the project has. So a rename is one
// substitution over all of them, and it either happens everywhere or the name is
// silently broken somewhere the panel cannot show.
//
// Groups are not stored either — the panel derives them from shared name
// prefixes (see prefixSections), so renaming a group is renaming each of its
// members. Both arrive here as a list of renames applied in a single pass, which
// is also what makes a swap (`a`→`b`, `b`→`a`) come out right instead of
// collapsing into one name.

// Where a name can be written. CSS files hold most of them; an Astro component
// keeps its rules in a `<style>` block, and a `style="--x: 1"` can sit in markup
// or a template — a token spelled `--x` in any of these is that variable.
const RENAME_EXTS =
  /\.(css|s[ac]ss|less|pcss|postcss|astro|html|htm|md|mdx|mdoc|svelte|vue|jsx|tsx|[cm]?[jt]s)$/i;

/**
 * Every file in the project that could spell a variable's name.
 *
 * The panel READS variables from `src`, `public` and `styles` — that is where a
 * project keeps its stylesheets. References are not so tidy: a `style` attribute
 * in a layout, a `--x` in a Tailwind or Astro config at the root, a themed
 * string in a helper module. So this walks the project rather than those three
 * roots, and skips only what is not the project's own text (dependencies, build
 * output, version control, caches).
 *
 * Broad on purpose. A missed reference is a variable that silently stops
 * resolving somewhere the panel cannot see, which is the failure that has no
 * symptom until someone looks at the page.
 */
function findRenameTargets(projectPath: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > CSS_VARIABLE_LIMITS.renameTargetDepthMax) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Dotted directories are caches and version control; a dotted FILE at the
      // root can still be a config that names a variable (`.postcssrc`), so the
      // skip is for directories only.
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        walk(path.join(directory, entry.name), depth + 1);
      } else if (RENAME_EXTS.test(entry.name)) {
        found.push(path.join(directory, entry.name));
      }
    }
  };
  walk(projectPath, 0);
  return [...new Set(found)].sort();
}

/** A custom property name, as a name and not as a prefix of a longer one. */
const NAME_RE = /^--[^\s:;{}()'"\\,]+$/;
// `--space` must not match inside `--space-2` or `--x--space`, in either
// direction — the parts of a name are separated by hyphens, so a hyphen on
// either side is part of a longer name rather than a boundary.
const EDGE = '[-\\w\\u00a0-\\uffff]';

interface Rename {
  readonly from: string;
  readonly to: string;
}

/**
 * Renames custom properties across the project — declarations and references
 * alike, in one pass.
 *
 * `renames` is [{ from, to }]. Everything is checked before anything is written:
 * a rename that would land on a name already in use, or that is not a name at
 * all, takes the whole batch down rather than leaving a group half renamed.
 */
function renameVariables(
  projectPath: string,
  { renames }: { readonly renames?: readonly Rename[] },
): { ok: boolean; files?: number; occurrences?: number; error?: string } {
  const list = (renames || []).filter((rename) => rename && rename.from !== rename.to);
  if (!list.length) {
    return { ok: true, files: 0, occurrences: 0 };
  }
  const problem = renameBatchProblem(list) ?? renameTakenProblem(projectPath, list);
  if (problem !== undefined) {
    return { ok: false, error: problem };
  }

  const by = new Map(list.map(({ from, to }) => [from, to]));
  // One alternation over every name being renamed, longest first — so that with
  // both `--a` and `--a-b` in the batch, `--a-b` is the one that matches.
  const alternation = [...by.keys()]
    .sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`(?<!${EDGE})(${alternation})(?!${EDGE})`, 'g');

  const writes: [string, string][] = [];
  let occurrences = 0;
  for (const abs of findRenameTargets(projectPath)) {
    let text: string;
    try {
      if (fs.statSync(abs).size > MAIN_LIMITS.cssVariableFileBytesMax) {
        continue;
      }
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    let hits = 0;
    const next = text.replace(re, (match: string): string => {
      hits += 1;
      return by.get(match) ?? match;
    });
    if (!hits) {
      continue;
    }
    occurrences += hits;
    writes.push([abs, next]);
  }

  // Written only once every file has been read and rewritten in memory: a
  // half-applied rename is worse than a refused one. Each write goes through
  // the file's document actor (documentWrites.ts), which also announces it as
  // the app's own, so the watcher does not read it back as an outside edit.
  for (const [abs, next] of writes) {
    writeProjectText(abs, next);
  }
  return { ok: true, files: writes.length, occurrences };
}

// Why the batch cannot be applied as asked, before looking at the project: a name that is not
// one, or two renames that collide with each other.
function renameBatchProblem(list: readonly Rename[]): string | undefined {
  const froms = new Set<string>();
  const tos = new Set<string>();
  for (const { from, to } of list) {
    if (!NAME_RE.test(String(from || ''))) {
      return `${from} is not a variable name.`;
    }
    if (!NAME_RE.test(String(to || ''))) {
      return `"${String(to || '').replace(/^--/, '')}" cannot be a variable name.`;
    }
    if (froms.has(from)) {
      return `${from} is renamed twice in one go.`;
    }
    if (tos.has(to)) {
      return `Two variables would both be called ${to}.`;
    }
    froms.add(from);
    tos.add(to);
  }
  return undefined;
}

// Taken names, minus the ones this batch is freeing up: renaming a group means
// every member moves at once, and a swap within it is legitimate.
function renameTakenProblem(projectPath: string, list: readonly Rename[]): string | undefined {
  const froms = new Set(list.map(({ from }) => from));
  const declared = new Set<string>();
  for (const abs of findStylesheets(projectPath)) {
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/(^|[;{}\s])(--[^\s:;{}()'"\\,]+)\s*:/g)) {
      const name = match[2];
      if (name) {
        declared.add(name);
      }
    }
  }
  for (const { to } of list) {
    if (declared.has(to) && !froms.has(to)) {
      return `${to} already exists.`;
    }
  }
  return undefined;
}

export {
  readVariables,
  renameVariables,
  setSectionTitle,
  removeSection,
  addSection,
  moveHeading,
  setVariable,
  moveVariable,
  moveSection,
  addVariable,
  readDeclarations,
  findFamilies,
  groupRules,
  labelForRule,
  findStylesheets,
};
