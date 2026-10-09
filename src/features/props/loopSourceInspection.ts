// Describe a loop's source without executing project code. A literal list can
// show its real items; computed data keeps an honest source link instead.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { findDeclaration, objectEntries, splitTopLevel } from '../../editor/dataSource';
import { literalNode, type TreeNode } from '../../editor/dataSample';

const ITEMS_SHOWN_MAX = 3;
const FIELDS_SHOWN_MAX = 4;
const PREVIEW_CHARS_MAX = 42;

export interface LoopSourceInspection {
  readonly path: string;
  readonly origin: string;
  readonly count: number | undefined;
  readonly items: readonly string[];
  readonly note: string | undefined;
  readonly tree: TreeNode | undefined;
}

export function inspectLoopSource(
  source: string,
  root: string,
  path: string,
  origin: string,
): LoopSourceInspection {
  assert(source.length <= LIMITS.ipcFieldCharsMax, 'Loop source exceeds text limit');
  assert(path === root || path.startsWith(`${root}.`), 'Loop source path must start at root');
  const declaration = findDeclaration(source, root);
  if (!declaration) {
    return {
      path,
      origin,
      count: undefined,
      items: [],
      note: 'Value is computed or imported here.',
      tree: undefined,
    };
  }
  const tree = literalNode(root, root, declaration.value, 0);
  let value = declaration.value;
  const steps = path.slice(root.length).replace(/^\./, '').split('.').filter(Boolean);
  assert(steps.length <= LIMITS.treeDepthMax, 'Loop source path exceeds depth limit');
  for (const step of steps) {
    const entry = objectEntries(value).find((candidate) => candidate.key === step);
    if (!entry) {
      return {
        path,
        origin,
        count: undefined,
        items: [],
        note: 'Value is computed from this file.',
        tree,
      };
    }
    value = entry.value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return {
      path,
      origin,
      count: undefined,
      items: [],
      note: 'List values are computed at runtime.',
      tree,
    };
  }
  const body = trimmed.slice(1, -1).trim();
  const entries = body
    ? splitTopLevel(body)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  if (entries.length > LIMITS.treeNodesMax || entries.some((entry) => entry.startsWith('...'))) {
    return {
      path,
      origin,
      count: undefined,
      items: [],
      note: 'List values include computed items. Open the source to inspect them.',
      tree,
    };
  }
  const items = entries.slice(0, ITEMS_SHOWN_MAX).map(itemPreview);
  return { path, origin, count: entries.length, items, note: undefined, tree };
}

function itemPreview(value: string): string {
  const fields = objectEntries(value).slice(0, FIELDS_SHOWN_MAX);
  if (!fields.length) {
    return clipped(value);
  }
  return fields.map((field) => `${field.key}: ${clipped(field.value)}`).join(' · ');
}

function clipped(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS_MAX ? `${flat.slice(0, PREVIEW_CHARS_MAX - 1)}…` : flat;
}
