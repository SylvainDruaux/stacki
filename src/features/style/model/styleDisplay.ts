// What a style control shows for one property, and how a typed value splits
// into the value and its `!important`. Every section of the style panel reads a
// property the same way; these were copied into each of them, and the copies
// were identical, so they live here once.

import type { ResolvedProp } from './resolved';

/** One property as a control shows it: whether anything sets it, whether the
 * picked selector is the one that does, and the value that wins. */
export type Display = {
  present: boolean;
  isSelected: boolean;
  overridden: boolean;
  winnerSelector: string;
  value: string;
  important: boolean;
};

export function displayOf(resolved: ResolvedProp | undefined): Display {
  if (!resolved) {
    return {
      present: false,
      isSelected: false,
      overridden: false,
      winnerSelector: '',
      value: '',
      important: false,
    };
  }
  const isSelected = resolved.source === 'selected';
  const source = isSelected && resolved.selectedValue ? resolved.selectedValue : resolved.winner;
  return {
    present: true,
    isSelected,
    overridden: resolved.overridden,
    winnerSelector: resolved.winner.selectorText,
    value: source.value,
    important: source.important,
  };
}

/** Typed text, split into its value and whether it ends in `!important`. */
export function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i);
  if (match) {
    return { value: input.slice(0, match.index).trim(), important: true };
  }
  return { value: input.trim(), important: false };
}
