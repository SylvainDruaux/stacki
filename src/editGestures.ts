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
