// How a stylesheet's custom properties are grouped for the editor: naming a
// rule, merging rules that are modes of one set, the families of columns inside
// one rule, and prefix sections (cssVars.ts).

import { assert } from '../../shared/core/assert';
import { type Rule } from './cssVarRead';

export const titleize = (text: unknown): string =>
  String(text)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());

// What to call a rule. A selector list usually leads with the generic one
// (`:root, .theme-light, …`) and the name people use for it is the specific
// one, so the first plain class wins over `:root`, `*` and anything nested.
export function labelForRule(rule: Rule): string {
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
export function commonStem(labels: readonly string[]): string {
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

export const namesOf = (rule: Rule): string[] =>
  rule.entries.filter((entry) => entry.kind === 'var').map((entry) => entry.name);

export const overlap = (left: readonly string[], right: readonly string[]): number => {
  const rightSet = new Set(right);
  const shared = left.filter((name) => rightSet.has(name)).length;
  return shared / Math.max(left.length, right.length);
};

// Rules that declare the same names are one thing in several modes — a light
// theme and a dark one, a size scale and its variants. They are shown as
// columns of a single table rather than as three tables nobody can compare.
export const MERGE_THRESHOLD = 0.6;

export function groupRules(rules: readonly Rule[]): Rule[][] {
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
export function splits(name: string): { prefix: string; suffix: string }[] {
  const body = name.replace(/^--/, '');
  const parts = body.split('-');
  const out: { prefix: string; suffix: string }[] = [];
  for (let at = 1; at < parts.length; at++) {
    out.push({ prefix: parts.slice(0, at).join('-'), suffix: parts.slice(at).join('-') });
  }
  return out;
}

export interface Family {
  prefixes: string[];
  rows: string[];
  self: boolean;
}

// The suffixes most of these prefixes declare. "Most" rather than "all",
// because one variant carrying an extra property is normal and should not cost
// everyone else the table.
export function rowsFor(
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
export const FAMILIES_MAX = 25;

export function findFamilies(names: readonly string[]): { families: Family[]; used: Set<string> } {
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

export interface FamilySeed {
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
export function bestFamilySeed(
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
export function familyFrom(
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
export function prefixSections(names: readonly string[]): {
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
