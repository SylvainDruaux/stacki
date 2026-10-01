// What the visual editor may do with the node it shows as selected (plan §6,
// step 7). The engine classifies projected nodes (shared/source-projection.ts);
// the renderer holds the same parse as a page tree, so it asks the same
// function the same question — one classification, not a second opinion. A node
// the engine would refuse says so beside its panels instead of looking
// editable and saving some other way.
import { assert } from '../../shared/core/assert';
import type { Capability } from '../../shared/capability';
import type { EditorModel, EditorNode } from './pageView';
import { LIMITS } from '../../shared/core/limits';
import { classifyNode } from '../../shared/source-projection';

/** The capability of node `nodeId` in `model`, or undefined when the model has
 * no such node (the frontmatter subject, a node already gone). Markdown and MDX
 * pages are classified like any page since step 10: a table or an ESM block
 * is kept verbatim (read-only), everything else is editable. */
export function nodeCapability(model: EditorModel, nodeId: string): Capability | undefined {
  const found = findWithAncestry(model.nodes, nodeId);
  if (found === undefined) {
    return undefined;
  }
  if (found.insideChunk) {
    // Another file's markup (a Fragment's .html chunk): the page's actor
    // cannot edit it, and no chunk has node intents yet (step 9).
    return 'read-only-opaque';
  }
  // The projection's own rule: a node inside a loop body is one source node
  // rendered once per item, whatever its kind.
  const capability = classifyNode(found.node, { repeated: found.insideLoop });
  assert(
    found.insideLoop ? capability === 'repeated-source-node' : true,
    'A node inside a loop classifies as repeated',
  );
  return capability;
}

/** Whether the panels should show the capability beside the selection: every
 * capability but plain `editable` changes what an edit means or where it goes. */
export function capabilityNeedsNotice(capability: Capability): boolean {
  switch (capability) {
    case 'editable':
      return false;
    case 'repeated-source-node':
    case 'read-only-opaque':
    case 'runtime-aggregate':
    case 'unsupported':
      return true;
    default: {
      const exhaustive: never = capability;
      return exhaustive;
    }
  }
}

interface Found {
  readonly node: EditorNode;
  readonly insideLoop: boolean;
  readonly insideChunk: boolean;
}

// Iterative preorder walk carrying whether a `map` or a chunk file encloses
// each node: the depth bound is the tree's, not the call stack's.
function findWithAncestry(roots: readonly EditorNode[], nodeId: string): Found | undefined {
  const stack: Found[] = [];
  for (let index = roots.length - 1; index >= 0; index--) {
    const root = roots[index];
    assert(root !== undefined, 'A root index lies inside the list');
    stack.push({ node: root, insideLoop: false, insideChunk: false });
  }
  for (let visited = 0; visited <= LIMITS.treeNodesMax; visited++) {
    const entry = stack.pop();
    if (entry === undefined) {
      return undefined;
    }
    if (entry.node.id === nodeId) {
      return entry;
    }
    const children = entry.node.children ?? [];
    const insideLoop = entry.insideLoop || entry.node.kind === 'map';
    const insideChunk = entry.insideChunk || entry.node.chunkFile !== undefined;
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      assert(child !== undefined, 'A child index lies inside the list');
      stack.push({ node: child, insideLoop, insideChunk });
    }
  }
  throw new Error('Assertion failed: a page tree stays inside its node bound');
}
