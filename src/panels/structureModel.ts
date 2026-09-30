import type { PageModel, PageNode } from '../../shared/page-node';
import type { Diagnostic } from '../../shared/source-projection';
import { treeBudget } from '../treeView';
import { rowChildren, rowHost } from '../branches';

export type NavigatorNode = PageNode;
export type NavigatorModel = Pick<PageModel, 'nodes' | 'imports'>;

export type StructurePageState =
  | {
      readonly editable: true;
      readonly model: NavigatorModel;
      readonly source: string;
    }
  | {
      readonly editable: false;
      readonly source: string;
      readonly reason?: string;
      readonly bail?: { readonly what: string; readonly near: string } | undefined;
    };

/** The page as the navigator draws it (plan §3.6): a tree to edit visually, or
 * a parse error, which is a state of the page like any other — the navigator
 * switches over it exhaustively and offers the code editor. */
export type StructureProjection =
  | { readonly tag: 'valid'; readonly state: Extract<StructurePageState, { editable: true }> }
  | {
      readonly tag: 'parse-error';
      readonly state: Extract<StructurePageState, { editable: false }>;
      readonly diagnostics: readonly Diagnostic[];
    };

export function structureProjection(state: StructurePageState): StructureProjection {
  if (state.editable) {
    return { tag: 'valid', state };
  }
  const message = state.reason ?? 'This page cannot be parsed.';
  const near = state.bail?.near;
  return { tag: 'parse-error', state, diagnostics: [{ message, near: near || undefined }] };
}

export type DropLocation = {
  readonly parentId: string | null;
  readonly index: number;
};

export type DropTarget =
  | { readonly kind: 'gap'; readonly parentId: string | null; readonly index: number }
  | { readonly kind: 'into'; readonly intoId: string };

export interface FoundNavigatorNode {
  readonly node: NavigatorNode;
  readonly parent: NavigatorNode | null;
  readonly siblings: readonly NavigatorNode[];
  readonly index: number;
}

export function isFragmentNode(node: NavigatorNode): boolean {
  return (node.kind === 'component' || node.kind === 'element') && node.name === 'Fragment';
}

export function navigatorChildren(node: NavigatorNode): readonly NavigatorNode[] {
  return rowChildren(node);
}

export function navigatorHost(node: NavigatorNode): NavigatorNode {
  return rowHost(node) ?? node;
}

export function defaultCollapsed(node: NavigatorNode): boolean {
  return navigatorChildren(node).length > 0;
}

export function findNavigatorNode(
  nodes: readonly NavigatorNode[],
  id: string,
): NavigatorNode | null {
  return findNodeWalk(nodes, id, 0, treeBudget());
}

export function findVisibleNode(
  nodes: readonly NavigatorNode[],
  id: string,
): FoundNavigatorNode | null {
  return findVisibleWalk(nodes, id, null, 0, treeBudget());
}

export function navigatorAncestors(
  nodes: readonly NavigatorNode[],
  id: string,
): readonly NavigatorNode[] {
  return findAncestorWalk(nodes, id, [], 0, treeBudget()) ?? [];
}

export function collapseMap(
  nodes: readonly NavigatorNode[],
  collapsed: boolean,
): ReadonlyMap<string, boolean> {
  const result = new Map<string, boolean>();
  collapseMapWalk(nodes, collapsed, result, 0, treeBudget());
  return result;
}

function findNodeWalk(
  nodes: readonly NavigatorNode[],
  id: string,
  depth: number,
  visit: (depth: number) => void,
): NavigatorNode | null {
  for (const node of nodes) {
    visit(depth);
    if (node.id === id) {
      return node;
    }
    const children = 'children' in node ? (node.children ?? []) : [];
    const found = findNodeWalk(children, id, depth + 1, visit);
    if (found) {
      return found;
    }
  }
  return null;
}

function findVisibleWalk(
  nodes: readonly NavigatorNode[],
  id: string,
  parent: NavigatorNode | null,
  depth: number,
  visit: (depth: number) => void,
): FoundNavigatorNode | null {
  for (const [index, node] of nodes.entries()) {
    visit(depth);
    if (node.id === id) {
      return { node, parent, siblings: nodes, index };
    }
    const found = findVisibleWalk(navigatorChildren(node), id, node, depth + 1, visit);
    if (found) {
      return found;
    }
  }
  return null;
}

function findAncestorWalk(
  nodes: readonly NavigatorNode[],
  id: string,
  trail: readonly NavigatorNode[],
  depth: number,
  visit: (depth: number) => void,
): readonly NavigatorNode[] | undefined {
  for (const node of nodes) {
    visit(depth);
    if (node.id === id) {
      return trail;
    }
    const found = findAncestorWalk(navigatorChildren(node), id, [...trail, node], depth + 1, visit);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function collapseMapWalk(
  nodes: readonly NavigatorNode[],
  collapsed: boolean,
  result: Map<string, boolean>,
  depth: number,
  visit: (depth: number) => void,
): void {
  for (const node of nodes) {
    visit(depth);
    const children = navigatorChildren(node);
    if (children.length > 0) {
      result.set(node.id, collapsed);
      collapseMapWalk(children, collapsed, result, depth + 1, visit);
    }
  }
}
