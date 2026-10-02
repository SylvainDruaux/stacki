// The project's variables as every picker shares them — loaded once, kept in
// one list that each open picker listens to — and which types a property can
// take (VariableConnect.tsx).

import { useEffect, useState } from 'react';
import { streamProjectVariables, type ProjectVariable } from './model/webflow';

// Which variable types make sense for the property being edited: a color property
// (color / *-color / fill / stroke) shows only Color variables; font-family shows only
// FontFamily; everything else shows anything BUT Color and FontFamily (sizes / numbers /
// percentages). No prop → no filter (show all).
export const COLOR_PROP_RE = /(?:^|-)color$/;
// Properties whose value is a keyword/string rather than a length/number/color — a
// FontFamily (string) variable is a valid connection for these.
export const STRING_PROPS = new Set([
  'font-family',
  'text-transform',
  'text-align',
  'text-decoration',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-skip-ink',
  'font-style',
  'white-space',
  'word-break',
  'overflow-wrap',
  'text-overflow',
  'text-wrap',
  'direction',
  'display',
  'position',
  'float',
  'clear',
  'visibility',
  'box-sizing',
  'overflow',
  'overflow-x',
  'overflow-y',
  'cursor',
  'pointer-events',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'align-self',
  'justify-self',
  'justify-items',
  'align-content',
  'place-content',
  'place-items',
  'place-self',
  'grid-auto-flow',
  'background-repeat',
  'background-attachment',
  'background-clip',
  'background-origin',
  'background-blend-mode',
  'mix-blend-mode',
  'object-fit',
  'border-style',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'outline-style',
  'column-rule-style',
  'column-span',
  'backface-visibility',
  'transform-style',
  'will-change',
]);
export function varTypeAllowed(prop: string | undefined, type: string): boolean {
  if (!prop) {
    return true;
  }
  const property = prop.toLowerCase();
  if (COLOR_PROP_RE.test(property) || property === 'fill' || property === 'stroke') {
    return type === 'Color';
  }
  // Keyword/string props (incl. font-family) take a FontFamily or String variable —
  // both are "not a length, not a colour". A font stack that isn't named …font-family
  // (`--font-display: "Inter", sans-serif`) types as String, and a keyword variable
  // (`--h6-text-transform: none`) can only ever be String, so requiring FontFamily here
  // left those fields with an empty picker.
  if (STRING_PROPS.has(property)) {
    return type === 'FontFamily' || type === 'String';
  }
  return type !== 'Color' && type !== 'FontFamily';
}

// Nest variables Collection → Group → variable (a group may be empty for a variable
// that isn't in a folder). Input is pre-sorted, so map insertion order is stable.
export type VarCollection = {
  collection: string;
  groups: Array<{ group: string; items: ProjectVariable[] }>;
};
export function byCollection(vars: ProjectVariable[]): VarCollection[] {
  const colls = new Map<string, Map<string, ProjectVariable[]>>();
  for (const variable of vars) {
    let groups = colls.get(variable.collection);
    if (!groups) {
      groups = new Map();
      colls.set(variable.collection, groups);
    }
    const list = groups.get(variable.group);
    if (list) {
      list.push(variable);
    } else {
      groups.set(variable.group, [variable]);
    }
  }
  return [...colls.entries()].map(([collection, groups]) => ({
    collection,
    groups: [...groups.entries()].map(([group, items]) => ({ group, items })),
  }));
}

// Project variables are shared across every VariableConnect instance: a native binding
// reads back as the variable's NAME (not var(…)), so to show a chip we match the field
// value against a variable's name OR its var(…) binding. Loaded once, streamed
// progressively; instances subscribe to re-render as entries (and the chip) resolve.
export let sharedVars: ProjectVariable[] = [];
export let sharedDone = false;
export let sharedLoading = false;
export const sharedListeners = new Set<() => void>();
export function ensureSharedVars() {
  if (sharedDone || sharedLoading) {
    return;
  }
  sharedLoading = true;
  const seen = new Set<string>();
  void streamProjectVariables(
    (variable) => {
      if (seen.has(variable.binding)) {
        return;
      }
      seen.add(variable.binding);
      sharedVars = [...sharedVars, variable];
      sharedListeners.forEach((listener) => listener());
    },
    () => false,
  ).then(() => {
    sharedDone = true;
    sharedLoading = false;
    sharedListeners.forEach((listener) => listener());
  });
}
export function useSharedVars({ active }: { active: boolean }): {
  vars: ProjectVariable[];
  loading: boolean;
} {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    ensureSharedVars();
    const listener = () => force((count) => count + 1);
    sharedListeners.add(listener);
    return () => {
      sharedListeners.delete(listener);
    };
  }, [active]);
  return { vars: sharedVars, loading: !sharedDone };
}
