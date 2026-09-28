// Keep a session's node ids stable when a freshly parsed page replaces the
// local model. The parser regenerates every id on each parse, and the UI keys
// editors by node id (panel fields, style rules, the floating code window) —
// installing a fresh parse wholesale re-keyed every editor after each save and
// dropped field focus mid-typing (issue #29).
//
// The fresh parse stays the authority for structure and source ranges; only
// ids are adopted, and only where the two trees agree the node is "the same
// slot". Where they disagree (a node added or removed in the source, an
// externally edited file), the fresh subtree keeps its fresh ids — a one-time
// re-key of the restructured region, never a stale id attached to a different
// node.

import { assert } from '../shared/assert';
import type { NodeId } from '../shared/brand';
import { LIMITS } from '../shared/limits';
import type { BranchNode, PageNode, PageNodeList } from '../shared/page-node';

export function adoptNodeIds(
  localNodes: readonly PageNode[],
  freshNodes: PageNodeList,
): PageNodeList {
  assert(
    localNodes.length <= LIMITS.treeNodesMax,
    'modelAdoption: local tree exceeds LIMITS.treeNodesMax',
  );
  assert(
    freshNodes.length <= LIMITS.treeNodesMax,
    'modelAdoption: fresh tree exceeds LIMITS.treeNodesMax',
  );
  // The fresh list is the authority for list-level metadata (markdown's
  // mdTrailingBlanks) — but only that: Object.assign would also copy the
  // fresh elements' index properties over the adopted ones. PageNodeList's
  // only extra property is mdTrailingBlanks, so it is carried explicitly.
  const adopted = adoptNodeList(localNodes, freshNodes, 0);
  const trailingBlanks = freshNodes.mdTrailingBlanks;
  if (trailingBlanks === undefined) {
    return adopted;
  }
  return Object.assign(adopted, { mdTrailingBlanks: trailingBlanks });
}

/** Pair both lists by position: aligned nodes adopt the local id, a longer
 * fresh tail keeps its fresh ids (genuinely new nodes). */
function adoptNodeList(
  localNodes: readonly PageNode[],
  freshNodes: readonly PageNode[],
  depth: number,
): PageNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'modelAdoption: tree depth exceeds LIMITS.treeDepthMax');
  const shared = Math.min(localNodes.length, freshNodes.length);
  const adopted: PageNode[] = [];
  for (let index = 0; index < shared; index += 1) {
    const localNode = localNodes[index];
    const freshNode = freshNodes[index];
    assert(localNode !== undefined, 'modelAdoption: paired local node missing');
    assert(freshNode !== undefined, 'modelAdoption: paired fresh node missing');
    adopted.push(adoptNode(localNode, freshNode, depth + 1));
  }
  for (let index = shared; index < freshNodes.length; index += 1) {
    const freshNode = freshNodes[index];
    assert(freshNode !== undefined, 'modelAdoption: fresh tail node missing');
    adopted.push(freshNode);
  }
  return adopted;
}

/** A fresh node adopts the local id when both trees say it is the same slot:
 * same kind, same name where a name exists, and the same children shape. The
 * name check is what keeps an externally inserted element from borrowing the
 * id of the element it displaced. */
function adoptNode(local: PageNode, fresh: PageNode, depth: number): PageNode {
  assert(depth <= LIMITS.treeDepthMax, 'modelAdoption: tree depth exceeds LIMITS.treeDepthMax');
  if (!sameSlot(local, fresh)) {
    return fresh;
  }
  // sameSlot just proved the kinds equal; the assert narrows the local side
  // to match before adoptSameKind reads the local children.
  assert(local.kind === fresh.kind, 'modelAdoption: same-slot nodes share a kind');
  return adoptSameKind(local, fresh, depth);
}

function adoptSameKind(local: PageNode, fresh: PageNode, depth: number): PageNode {
  switch (fresh.kind) {
    case 'cond': {
      assert(local.kind === 'cond', 'modelAdoption: cond pairs with cond');
      return {
        ...fresh,
        id: local.id,
        children: adoptBranchList(local.children, fresh.children, depth),
      };
    }
    case 'component':
    case 'element': {
      const localChildren = childListOf(local);
      const freshChildren = fresh.children;
      if (freshChildren === null) {
        if (localChildren === null) {
          // Both self-closing: the id transfers, nothing to walk.
          return replaceId(fresh, local.id);
        }
        // The source changed the node's shape, so this is not provably the
        // same slot — the fresh subtree keeps its own ids.
        return fresh;
      }
      if (localChildren === null) {
        return fresh;
      }
      return {
        ...fresh,
        id: local.id,
        children: adoptNodeList(localChildren, freshChildren, depth),
      };
    }
    case 'map':
    case 'branch':
    case 'chunk-group': {
      // Kinds are equal (asserted by the caller), so the local side carries
      // children here as well — these kinds always do.
      const localChildren = childListOf(local);
      assert(localChildren !== null, 'modelAdoption: child-bearing kinds pair with children');
      return {
        ...fresh,
        id: local.id,
        children: adoptNodeList(localChildren, fresh.children, depth),
      };
    }
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'raw':
      // Leaves: the id transfers, the fresh payload stays.
      return replaceId(fresh, local.id);
    default: {
      const _exhaustive: never = fresh;
      return _exhaustive;
    }
  }
}

/** Branches (a cond's `then`/`else` arms) are positional: a branch always
 * pairs with the branch at the same index, its arms pairing like any other
 * child list. Kept apart from adoptNodeList because a cond's children are
 * BranchNode[], which the PageNode-typed walker cannot return. */
function adoptBranchList(
  localBranches: readonly BranchNode[],
  freshBranches: readonly BranchNode[],
  depth: number,
): BranchNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'modelAdoption: tree depth exceeds LIMITS.treeDepthMax');
  const shared = Math.min(localBranches.length, freshBranches.length);
  const adopted: BranchNode[] = [];
  for (let index = 0; index < shared; index += 1) {
    const localBranch = localBranches[index];
    const freshBranch = freshBranches[index];
    assert(localBranch !== undefined, 'modelAdoption: paired local branch missing');
    assert(freshBranch !== undefined, 'modelAdoption: paired fresh branch missing');
    adopted.push({
      ...freshBranch,
      id: localBranch.id,
      children: adoptNodeList(localBranch.children, freshBranch.children, depth + 1),
    });
  }
  for (let index = shared; index < freshBranches.length; index += 1) {
    const freshBranch = freshBranches[index];
    assert(freshBranch !== undefined, 'modelAdoption: fresh tail branch missing');
    adopted.push(freshBranch);
  }
  return adopted;
}

function sameSlot(local: PageNode, fresh: PageNode): boolean {
  if (local.kind !== fresh.kind) {
    return false;
  }
  return namesMatch(nodeName(local), nodeName(fresh));
}

/** Names must agree where both exist; a node without a name (text, expr, map
 * loop, comment) pairs on kind alone. For one well-formed kind the name
 * presence always agrees, so a mixed pair is treated as a mismatch. */
function namesMatch(localName: string | undefined, freshName: string | undefined): boolean {
  if (localName === undefined) {
    return freshName === undefined;
  }
  if (freshName === undefined) {
    return false;
  }
  return localName === freshName;
}

function nodeName(node: PageNode): string | undefined {
  switch (node.kind) {
    case 'component':
    case 'element':
    case 'raw':
    case 'branch':
    case 'chunk-group':
      return node.name;
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'map':
    case 'cond':
      return undefined;
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

/** Local-side children reader; the fresh side reads `children` directly from
 * its narrowed node. Null for the leaf kinds. */
function childListOf(node: PageNode): readonly PageNode[] | null {
  switch (node.kind) {
    case 'component':
    case 'element':
    case 'map':
    case 'cond':
    case 'branch':
    case 'chunk-group':
      return node.children;
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'raw':
      return null;
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

// Object spread distributes over the PageNode union, so every member keeps
// its own shape with only the id replaced.
function replaceId(node: PageNode, id: NodeId): PageNode {
  return { ...node, id };
}