// Gestures in their intent form (plan §11 step 6, the compat adapter): each
// is the edit requests it becomes against the page's origin, and its effect
// on the shown model. The effect builds a new model and never edits one in
// place — the old model is the undo snapshot and, until the page is clean
// again, the origin's lineage — so the adapter-surface ratchet counts none of
// it. Gestures join in the §11.6 order; one without an intent form yet keeps
// saving the whole model (App.tsx, mutateModel).
import { assert } from '../shared/assert';
import type { EditorModel, EditorNode } from '../shared/editor-model';
import type { Edit, NodeRef } from '../shared/edit-request';
import { LIMITS } from '../shared/limits';
import type { Attr } from '../shared/page-node';
import type { EditGesture, StreamedEdit } from './pageEdits';

type Urgency = boolean | 'live';

/** Props to set (a value) or remove (undefined), by name. */
export type PropPatch = Readonly<Record<string, Attr | undefined>>;

/** Set or remove attributes and props of one node: string values and
 * removals (the attribute step), expressions and bare props (the prop step).
 * A spread is code of its own and still saves the whole model. */
export function propsGesture(
  nodeId: string,
  patch: PropPatch,
  options: { readonly coalesceKey: string | null; readonly urgency: Urgency },
): EditGesture {
  return {
    coalesceKey: options.coalesceKey,
    urgency: options.urgency,
    request: (refOf) => {
      const target = refOf(nodeId);
      if (target === undefined) {
        return undefined;
      }
      const edits: StreamedEdit[] = [];
      for (const [name, value] of Object.entries(patch)) {
        const edit = attributeEdit(target, name, value);
        if (edit === undefined) {
          return undefined; // All or nothing: one gesture, one way to disk.
        }
        edits.push({ edit, stream: `attribute:${target.path.join('.')}:${name}` });
      }
      return edits;
    },
    apply: (model) =>
      withNode(model, nodeId, (node) =>
        Object.assign({}, node, { props: patchedProps(node.props, patch) }),
      ),
  };
}

function attributeEdit(target: NodeRef, name: string, value: Attr | undefined): Edit | undefined {
  if (value === undefined) {
    return { tag: 'remove-attribute', target, name };
  }
  switch (value.type) {
    case 'string':
    case 'expr':
      return { tag: 'set-attribute', target, name, value };
    case 'bare':
      return { tag: 'set-attribute', target, name, value: { type: 'bare' } };
    case 'spread':
      return undefined;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/** Props in their order, patched: a set value keeps its slot, a new one goes
 * last, a removed one goes — what the legacy setProp did in place. */
export function patchedProps(
  props: Readonly<Record<string, Attr>> | undefined,
  patch: PropPatch,
): Record<string, Attr> {
  const next: Record<string, Attr> = {};
  for (const [name, value] of Object.entries(props ?? {})) {
    if (Object.hasOwn(patch, name)) {
      const patched = patch[name];
      if (patched !== undefined) {
        Object.defineProperty(next, name, {
          value: patched,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    } else {
      Object.defineProperty(next, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  for (const [name, value] of Object.entries(patch)) {
    if (value !== undefined && !Object.hasOwn(next, name)) {
      Object.defineProperty(next, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return next;
}

/** A copy of the model with one node replaced; every list on the path to it
 * is new, every other node shared. Unchanged when no node has the id. */
export function withNode(
  model: EditorModel,
  nodeId: string,
  update: (node: EditorNode) => EditorNode,
): EditorModel {
  const nodes = replacedIn(model.nodes, nodeId, update, 0);
  return nodes === model.nodes ? model : { ...model, nodes };
}

// Recursion bounded by the tree's depth bound, asserted.
function replacedIn(
  list: EditorNode[],
  nodeId: string,
  update: (node: EditorNode) => EditorNode,
  depth: number,
): EditorNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'A model is no deeper than its bound');
  for (const [index, node] of list.entries()) {
    if (node.id === nodeId) {
      return list.map((candidate, at) => (at === index ? update(candidate) : candidate));
    }
    const children = node.children;
    if (Array.isArray(children)) {
      const replaced = replacedIn(children, nodeId, update, depth + 1);
      if (replaced !== children) {
        // Object.assign keeps the node's own variant; a spread widens it.
        const parent = Object.assign({}, node, { children: replaced });
        return list.map((candidate, at) => (at === index ? parent : candidate));
      }
    }
  }
  return list;
}

// --- Insert and remove (the §11.6 insert/remove step) --------------------------------

/** Where a new node lands: a list inside a parent (null: the page's root
 * list) and a position in it, as the insert palette and paste state it. */
export interface InsertPlace {
  readonly parentId: string | null;
  readonly index: number;
}

type Placement = 'before' | 'after' | 'first-child' | 'last-child';

/** Insert one new node. The request places it beside the node now at that
 * position (before it, or after the last one), or inside an empty parent;
 * main prints it at its indentation. An empty page has nothing to stand
 * beside, so that insertion saves the whole model. */
export function insertGesture(
  model: EditorModel,
  node: EditorNode,
  place: InsertPlace | null,
  options: { readonly urgency: Urgency },
): EditGesture {
  const beside = besidePlace(model, place);
  return {
    coalesceKey: null,
    urgency: options.urgency,
    request: (refOf) => {
      const target = beside === undefined ? undefined : refOf(beside.anchorId);
      if (beside === undefined || target === undefined) {
        return undefined;
      }
      const edit: Edit = {
        tag: 'insert-node',
        target,
        placement: beside.placement,
        content: { tag: 'nodes', nodes: [node] },
      };
      return [{ edit, stream: null }];
    },
    apply: (current) => withInserted(current, node, place),
  };
}

/** A copy of a node right after it: the request copies the node's own bytes
 * (plan §3.4: never a reprint), the effect its clone with new ids. */
export function duplicateGesture(
  nodeId: string,
  clone: EditorNode,
  options: { readonly urgency: Urgency },
): EditGesture {
  return {
    coalesceKey: null,
    urgency: options.urgency,
    request: (refOf) => {
      const target = refOf(nodeId);
      if (target === undefined) {
        return undefined;
      }
      const content = { tag: 'copy' as const, source: target };
      return [{ edit: { tag: 'insert-node', target, placement: 'after', content }, stream: null }];
    },
    apply: (current) => withInsertedAfter(current, nodeId, clone),
  };
}

/** Remove nodes, in the order given (a note before the node it annotates).
 * `apply` is the whole effect — it may also prune what the removal leaves
 * unused — and `changesMore` says whether it does anything the removals
 * alone do not, in which case the gesture has no intent form yet. */
export function removalGesture(
  nodeIds: readonly string[],
  effect: { readonly apply: (model: EditorModel) => EditorModel; readonly changesMore: boolean },
  options: { readonly urgency: Urgency },
): EditGesture {
  return {
    coalesceKey: null,
    urgency: options.urgency,
    request: (refOf) => {
      if (effect.changesMore) {
        return undefined;
      }
      const edits: StreamedEdit[] = [];
      for (const id of nodeIds) {
        const target = refOf(id);
        if (target === undefined) {
          return undefined;
        }
        edits.push({ edit: { tag: 'remove-node', target }, stream: null });
      }
      return edits;
    },
    apply: effect.apply,
  };
}

/** The model without the given nodes (and their subtrees). */
export function withoutNodes(model: EditorModel, nodeIds: readonly string[]): EditorModel {
  const gone = new Set(nodeIds);
  const nodes = filteredList(model.nodes, gone, 0);
  return nodes === model.nodes ? model : { ...model, nodes };
}

function filteredList(list: EditorNode[], gone: ReadonlySet<string>, depth: number): EditorNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'A model is no deeper than its bound');
  let changed = false;
  const next: EditorNode[] = [];
  for (const node of list) {
    if (gone.has(node.id)) {
      changed = true;
      continue;
    }
    const children = node.children;
    if (Array.isArray(children)) {
      const kept = filteredList(children, gone, depth + 1);
      if (kept !== children) {
        changed = true;
        next.push(Object.assign({}, node, { children: kept }));
        continue;
      }
    }
    next.push(node);
  }
  return changed ? next : list;
}

/** The model with `node` inserted where `place` says — the legacy
 * insertIntoModel's rule, without editing a model in place: no place, or a
 * parent that is gone, means the end of the page. */
export function withInserted(
  model: EditorModel,
  node: EditorNode,
  place: InsertPlace | null,
): EditorModel {
  const parentId = place?.parentId ?? null;
  if (parentId === null || !containsNode(model.nodes, parentId)) {
    const index = place === null || parentId !== null ? model.nodes.length : place.index;
    return { ...model, nodes: spliced(model.nodes, Math.min(index, model.nodes.length), node) };
  }
  const index = place?.index ?? 0;
  return withNode(model, parentId, (parent) => {
    const children = Array.isArray(parent.children) ? parent.children : [];
    return Object.assign({}, parent, {
      children: spliced(children, Math.min(index, children.length), node),
    });
  });
}

function withInsertedAfter(model: EditorModel, anchorId: string, node: EditorNode): EditorModel {
  const nodes = afterIn(model.nodes, anchorId, node, 0);
  return nodes === model.nodes ? model : { ...model, nodes };
}

function afterIn(
  list: EditorNode[],
  anchorId: string,
  node: EditorNode,
  depth: number,
): EditorNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'A model is no deeper than its bound');
  for (const [index, candidate] of list.entries()) {
    if (candidate.id === anchorId) {
      return spliced(list, index + 1, node);
    }
    const children = candidate.children;
    if (Array.isArray(children)) {
      const replaced = afterIn(children, anchorId, node, depth + 1);
      if (replaced !== children) {
        const parent = Object.assign({}, candidate, { children: replaced });
        return list.map((item, at) => (at === index ? parent : item));
      }
    }
  }
  return list;
}

function spliced(list: readonly EditorNode[], index: number, node: EditorNode): EditorNode[] {
  return [...list.slice(0, index), node, ...list.slice(index)];
}

function containsNode(list: readonly EditorNode[], nodeId: string): boolean {
  const pending = [...list];
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'A model stays inside its node bound');
    const node = pending[visited];
    assert(node !== undefined, 'The visit index lies inside the list');
    if (node.id === nodeId) {
      return true;
    }
    if (Array.isArray(node.children)) {
      pending.push(...node.children);
    }
  }
  return false;
}

// The node a new one stands beside: the one at the position (before it), or
// the last one (after it), or an empty parent (inside it). Blank text between
// root nodes is a separator, never a neighbour to stand beside.
function besidePlace(
  model: EditorModel,
  place: InsertPlace | null,
): { readonly anchorId: string; readonly placement: Placement } | undefined {
  const parentId = place?.parentId ?? null;
  const parent = parentId === null ? undefined : findNode(model.nodes, parentId);
  const list =
    parent === undefined ? model.nodes : Array.isArray(parent.children) ? parent.children : [];
  const index =
    parent === undefined && parentId !== null
      ? list.length
      : Math.min(place?.index ?? list.length, list.length);
  const at = list.slice(index).find((node) => !blank(node));
  if (at !== undefined) {
    return { anchorId: at.id, placement: 'before' };
  }
  const last = list
    .slice(0, index)
    .filter((node) => !blank(node))
    .pop();
  if (last !== undefined) {
    return { anchorId: last.id, placement: 'after' };
  }
  return parent === undefined ? undefined : { anchorId: parent.id, placement: 'first-child' };
}

function blank(node: EditorNode): boolean {
  return node.kind === 'text' && /^\s*$/.test(node.value ?? '');
}

function findNode(list: readonly EditorNode[], nodeId: string): EditorNode | undefined {
  const pending = [...list];
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'A model stays inside its node bound');
    const node = pending[visited];
    assert(node !== undefined, 'The visit index lies inside the list');
    if (node.id === nodeId) {
      return node;
    }
    if (Array.isArray(node.children)) {
      pending.push(...node.children);
    }
  }
  return undefined;
}
