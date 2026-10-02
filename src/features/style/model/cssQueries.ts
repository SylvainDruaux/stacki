// Renaming a media or container query across a style region: a query's text,
// its key, and every at-rule that carries it (css.ts).

import { type AtRule } from 'postcss';
import type { StyleRegion } from './styleTypes';

// ─────────────────────────── Renaming a query ───────────────────────────
// A breakpoint is written once per block but meant once per file: a component
// with four `@media (width >= 64rem)` blocks has one breakpoint in it, spelled
// four times. Changing it by hand means finding every spelling, and missing one
// splits the breakpoint in two without saying so. So the rename is by text, over
// the whole region, at any nesting depth.

/** The at-rule as the picker spells it: `@media (width >= 64rem)`. */
export function atRuleQueryText(at: AtRule): string {
  return `@${at.name} ${at.params}`.trim();
}

/**
 * The key two spellings of one query share. Whitespace comes out entirely and the
 * at-name is lowercased, so `@MEDIA (width>=64rem)` and `@media (width >= 64rem)`
 * are one breakpoint — which is the point: a file that spells the same breakpoint
 * two ways has one breakpoint in it, and renaming should fix both. Two VALID
 * queries can't collide here, because whitespace in a query only separates tokens
 * — take it out of two different queries and they stay different.
 *
 * The params keep their case (`(min-width: 48EM)` stays as somebody typed it) and
 * this is only ever a comparison key: what gets written is the text you typed.
 */
export function queryKey(query: string): string {
  return query
    .trim()
    .replace(/\s+/g, '')
    .replace(/^@([a-zA-Z-]+)/, (_all, name: string) => `@${name.toLowerCase()}`);
}

/** Split `@media (…)` into the parts postcss holds separately. `undefined` if it isn't
 *  an at-rule at all — the caller decides what to tell the user. */
export function splitQuery(query: string): { name: string; params: string } | undefined {
  const match = /^@([a-zA-Z-]+)\s*([\s\S]*)$/.exec(query.trim());
  if (!match) {
    return undefined;
  }
  return { name: match[1] ?? '', params: (match[2] ?? '').trim() };
}

/** How many at-rules in the region are spelled `query`. */
export function countAtRuleQuery(region: StyleRegion, query: string): number {
  if (!region.root) {
    return 0;
  }
  const want = queryKey(query);
  let count = 0;
  region.root.walkAtRules((at) => {
    if (queryKey(atRuleQueryText(at)) === want) {
      count += 1;
    }
  });
  return count;
}

/**
 * Rewrite every at-rule spelled `from` to be spelled `to`, and report how many
 * changed. Only the at-rule's own line moves — the rules inside it, their order
 * and their formatting are untouched, so the cascade after the rename is the
 * cascade before it with a different condition on the front.
 *
 * Blocks are not merged into an existing `to` block: two adjacent blocks with the
 * same condition are valid CSS that cascades exactly as the two separate blocks
 * did, and folding them together would reorder somebody's rules to tidy up.
 */
export function renameAtRuleQuery(region: StyleRegion, from: string, to: string): number {
  if (!region.root) {
    return 0;
  }
  const next = splitQuery(to);
  if (!next) {
    return 0;
  }
  const want = queryKey(from);
  let count = 0;
  region.root.walkAtRules((at) => {
    if (queryKey(atRuleQueryText(at)) !== want) {
      return;
    }
    // PostCSS keeps the raw source of `params` and reuses it while it still
    // matches the parsed value; assigning a new value retires it, so the new
    // condition is what gets written out.
    at.assign({ name: next.name, params: next.params });
    count += 1;
  });
  return count;
}
