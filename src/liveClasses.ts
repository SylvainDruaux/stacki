import { assert } from '../shared/assert';
import type { PageNode } from '../shared/page-node';
import { LIMITS } from '../shared/limits';
import { treeBudget, type TreeView } from './treeView';
// Whether a node puts an element of its OWN on the page.
//
// `<Fragment>` and `<slot>` do not. They render what is inside them and nothing
// else, so no element on the page is theirs: nothing carries their name,
// nothing has their classes, nothing measures as them.
//
// The page can only answer about elements, and it answers by path — so asked
// what `<Fragment slot="column2">` rendered with, the canvas finds the element
// between its markers and hands back what it found. That element is the root
// `<div class="feature-image_wrap">` of the component the Fragment holds, and
// it answers to the Fragment's path on purpose: it is how a click inside the
// slot finds its way back to the node that put it there.
//
// So the canvas cannot tell them apart, and it should not have to. The model
// knows: a Fragment is a Fragment. Without that, the navigator labelled the
// Fragment's row `feature-image_wrap` and drew the component beneath it — a
// component's own root shown as a page element wrapping the component.

/** A `<Fragment>` wrapper: it groups children and renders no element of its own. */
export function isFragmentNode(node: PageNode): boolean {
  return (node.kind === 'component' || node.kind === 'element') && node.name === 'Fragment';
}

/** @param {{name?: string}|undefined} node */
export function rendersOwnElement(node: { readonly name?: string } | undefined): boolean {
  if (!node) {
    return false;
  }
  return node.name !== 'Fragment' && node.name !== 'slot';
}

/**
 * What each node rendered with, keyed by node id — the map the navigator labels
 * its rows from, and the breadcrumb and the canvas chip after it.
 *
 * `classesByPath` is what the page reported; `prefix` is the open component's
 * namespace, or '' for a page.
 */
export function liveClassesById(
  classesByPath: Readonly<Record<string, readonly string[]>>,
  nodes: readonly TreeView[] | undefined,
  prefix = '',
): ReadonlyMap<string, readonly string[]> {
  const byId = new Map<string, readonly string[]>();
  const visit = treeBudget();
  const walk = (list: readonly TreeView[] | undefined, trail: readonly number[]): void => {
    const depth = trail.length;
    for (const [i, node] of (list || []).entries()) {
      visit(depth);
      assert(depth <= LIMITS.treeDepthMax, 'liveClassesById: depth limit');
      const path = [...trail, i];
      const hit = classesByPath[prefix + path.join('.')];
      // Only for a node that put an element of its own there: what the page
      // reports for a Fragment is whatever the Fragment holds.
      if (hit && hit.length && rendersOwnElement(node)) {
        byId.set(node.id, hit);
      }
      if (node.children !== undefined) {
        walk(node.children, path);
      }
    }
  };
  walk(nodes, []);
  return byId;
}

export default rendersOwnElement;
