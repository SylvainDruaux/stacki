// The invariants every page tree holds, whoever built it: unique ids, paired
// nodes owning their children, bounded depth and size (pageNode.ts).

import { LIMITS } from '../core/limits';

export interface TreeInvariantNode {
  readonly id?: string;
  readonly kind: string;
  readonly children?: readonly TreeInvariantNode[] | undefined;
}

/** Check the producer's own tree without cloning it or claiming it has already
 * crossed the wire parser. Iteration makes the depth limit independent of the
 * JavaScript call stack. The receiver checks the same invariant after parsing. */
export function assertTreeInvariants(nodes: readonly TreeInvariantNode[]): void {
  if (nodes.length > LIMITS.treeNodesMax) {
    throw new Error(`Tree invariant violated: exceeds ${LIMITS.treeNodesMax} nodes`);
  }
  const pending = nodes.map((node) => ({ node, depth: 0 }));
  const ids = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const entry = pending[index];
    if (!entry) {
      throw new Error('Tree invariant violated: missing traversal entry');
    }
    if (entry.depth > LIMITS.treeDepthMax) {
      throw new Error(`Tree invariant violated: exceeds depth ${LIMITS.treeDepthMax}`);
    }
    const { node, depth } = entry;
    if (typeof node.id !== 'string') {
      throw new Error('Tree invariant violated: missing id');
    }
    if (ids.has(node.id)) {
      throw new Error(`Tree invariant violated: duplicate id ${node.id}`);
    }
    ids.add(node.id);
    if (node.children) {
      if (pending.length + node.children.length > LIMITS.treeNodesMax) {
        throw new Error(`Tree invariant violated: exceeds ${LIMITS.treeNodesMax} nodes`);
      }
      for (const child of node.children) {
        pending.push({ node: child, depth: depth + 1 });
      }
    }
  }
}
