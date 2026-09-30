// Small shared helpers for reading/writing a rule's declarations from the
// bespoke section controls (Size, Layout, …).

import type { ParsedRule } from './types';

export type Found = { value: string; important: boolean };

/** The current declaration for `prop` on a rule (last one wins), or undefined. */
export function readProp(rule: ParsedRule, prop: string): Found | undefined {
  const list = rule.declarations.filter((decl) => decl.prop === prop);
  if (!list.length) {
    return undefined;
  }
  const decl = list[list.length - 1];
  if (decl === undefined) {
    throw new Error(`Declaration invariant failed for ${prop}`);
  }
  return { value: decl.value, important: decl.important };
}

/** Lowercased value of `prop`, or '' when absent. */
export function readValue(rule: ParsedRule, prop: string): string {
  return readProp(rule, prop)?.value.trim().toLowerCase() ?? '';
}

export function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i);
  if (match) {
    return { value: input.slice(0, match.index).trim(), important: true };
  }
  return { value: input.trim(), important: false };
}

export const withImportant = (found: Found) =>
  found.important ? `${found.value} !important` : found.value;
export const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
