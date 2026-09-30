// Read-only tree queries. Mutation code uses the live readers; rendering builds
// one index per immutable model so hovering and selecting never rescan it.

import type { Attr, PageNode } from '../shared/page-node';

interface TreeNodeLike<Node> {
  readonly id: string;
  readonly kind: string;
  readonly children?: readonly Node[] | undefined;
  readonly props?: Readonly<Record<string, Attr>>;
}

interface TreeEntry<Node extends TreeNodeLike<Node> = PageNode> {
  node: Node;
  list: readonly Node[];
  index: number;
  parent: TreeEntry<Node> | null;
  path?: string;
}

interface Frame<Node extends TreeNodeLike<Node> = PageNode> {
  list: readonly Node[];
  index: number;
  parent: TreeEntry<Node> | null;
}

function* entries<Node extends TreeNodeLike<Node>>(
  nodes: readonly Node[] | null | undefined,
): Generator<TreeEntry<Node>> {
  const stack: Frame<Node>[] = [{ list: nodes ?? [], index: 0, parent: null }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      break;
    }
    if (frame.index >= frame.list.length) {
      stack.pop();
      continue;
    }
    const index = frame.index++;
    const node = frame.list[index];
    if (node === undefined) {
      continue;
    }
    const entry: TreeEntry<Node> = { node, list: frame.list, index, parent: frame.parent };
    yield entry;
    if ('children' in node && Array.isArray(node.children) && node.children.length) {
      stack.push({ list: node.children, index: 0, parent: entry });
    }
  }
}

function findEntry<Node extends TreeNodeLike<Node>>(
  nodes: readonly Node[] | null | undefined,
  id: string,
): TreeEntry<Node> | null {
  for (const entry of entries(nodes)) {
    if (entry.node.id === id) {
      return entry;
    }
  }
  return null;
}

function trailOf<Node extends TreeNodeLike<Node>, Value>(
  entry: TreeEntry<Node> | null,
  pick: (entry: TreeEntry<Node>) => Value,
): Value[] | null {
  if (!entry) {
    return null;
  }
  const trail: Value[] = [];
  for (let current: TreeEntry<Node> | null = entry; current; current = current.parent) {
    trail.push(pick(current));
  }
  return trail.reverse();
}

export const findNodeById = <Node extends TreeNodeLike<Node>>(
  nodes: readonly Node[] | null | undefined,
  id: string,
): Node | null => findEntry(nodes, id)?.node || null;
export const findParentNode = <Node extends TreeNodeLike<Node>>(
  nodes: readonly Node[] | null | undefined,
  id: string,
): Node | null => findEntry(nodes, id)?.parent?.node || null;
export const pathOfNode = <Node extends TreeNodeLike<Node>>(
  nodes: readonly Node[] | null | undefined,
  id: string,
): number[] | null => trailOf(findEntry(nodes, id), (entry) => entry.index);
export const ancestorChain = <Node extends TreeNodeLike<Node>>(
  nodes: readonly Node[] | null | undefined,
  id: string,
): Node[] | null => trailOf(findEntry(nodes, id), (entry) => entry.node);

export function findParentList(
  model: { readonly nodes: readonly PageNode[] },
  id: string,
): { list: readonly PageNode[]; index: number } | null {
  const found = findEntry(model.nodes, id);
  return found ? { list: found.list, index: found.index } : null;
}

export function isDescendantOf(candidateParent: PageNode, id: string): boolean {
  const children = 'children' in candidateParent ? candidateParent.children : null;
  return candidateParent.id === id || !!findNodeById(children, id);
}

export function nodeAtPath<Node extends TreeNodeLike<Node>>(
  nodes: readonly Node[] | null | undefined,
  trail: readonly number[],
): Node | null {
  let list = nodes;
  let node: Node | null = null;
  for (const i of trail) {
    node = list?.[i] ?? null;
    if (!node) {
      return null;
    }
    list = 'children' in node ? node.children : null;
  }
  return node;
}

interface TreeIndex<Node extends TreeNodeLike<Node> = PageNode> {
  readonly byId: Map<string, TreeEntry<Node>>;
  readonly byPath: Map<string, Node>;
  readonly sectionIds: string[];
  node(id: string): Node | null;
  parent(id: string): Node | null;
  path(id: string): string | null;
  ancestors(id: string): Node[] | null;
}

export function createTreeIndex<Node extends TreeNodeLike<Node>>(
  nodes: readonly Node[] | null | undefined,
): TreeIndex<Node> {
  const byId = new Map<string, TreeEntry<Node>>();
  const byPath = new Map<string, Node>();
  const sectionIds: string[] = [];
  for (const entry of entries(nodes)) {
    entry.path = entry.parent ? `${entry.parent.path}.${entry.index}` : String(entry.index);
    byId.set(entry.node.id, entry);
    byPath.set(entry.path, entry.node);
    // Presence, not kind: the tree query layer reads props from any node
    // that carries them, kind-tagged or not.
    if ('props' in entry.node) {
      const id = entry.node.props?.['id'];
      if (id?.type === 'string' && id.value) {
        sectionIds.push(id.value);
      }
    }
  }
  return {
    byId,
    byPath,
    sectionIds,
    node: (id) => byId.get(id)?.node || null,
    parent: (id) => byId.get(id)?.parent?.node || null,
    path: (id) => byId.get(id)?.path ?? null,
    ancestors: (id) => trailOf(byId.get(id) ?? null, (entry) => entry.node),
  };
}

export type { TreeEntry, TreeIndex };
