// Defensive guards for the two DOM mutations React's reconciler throws on when a node it
// is tracking was already detached or moved out from under it — the classic, hard-to-trace
// "Failed to execute 'removeChild'/'insertBefore' on 'Node': The node … is not a child of
// this node." It shows up in production React (dev React schedules differently and often
// doesn't hit it) around Suspense reveals, portal churn, and fast mount/unmount races.
//
// The failing op is effectively a no-op on an already-gone node, so swallowing it keeps the
// real DOM in the state React intended — instead of letting the throw take down the whole
// extension with Webflow's fatal "Close App" screen. Each guard logs the elements involved
// (by tag + class, which survive minification) so the root cause can still be traced.
//
// Scope: patches Node.prototype inside the extension's own iframe only. Install once, before
// React mounts.

function describe(node: Node | null | undefined): string {
  if (!node) {
    return 'none';
  }
  if (node instanceof Element) {
    return `${node.tagName.toLowerCase()}.${node.className || '(no-class)'}`;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return `#text("${(node.textContent ?? '').slice(0, 20)}")`;
  }
  return node.nodeName;
}

let installed = false;

export function installDomSafetyGuards(): void {
  if (installed || typeof Node === 'undefined') {
    return;
  }
  installed = true;

  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function removeChildGuarded<T extends Node>(
    this: Node,
    child: T,
  ): T {
    if (child.parentNode !== this) {
      // Already detached elsewhere — removing it here is a no-op. Log which elements were
      // involved (parent React expected vs the node's real parent) and swallow the throw.
      console.warn('[moden] removeChild guard — node already detached:', {
        expectedParent: describe(this),
        child: describe(child),
        actualParent: describe(child.parentNode),
      });
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function insertBeforeGuarded<T extends Node>(
    this: Node,
    node: T,
    ref: Node | null,
  ): T {
    if (ref && ref.parentNode !== this) {
      // The reference node moved — append instead of crashing on a stale reference.
      console.warn('[moden] insertBefore guard — reference node detached:', {
        parent: describe(this),
        node: describe(node),
        ref: describe(ref),
        refActualParent: describe(ref.parentNode),
      });
      return originalInsertBefore.call(this, node, null) as T;
    }
    return originalInsertBefore.call(this, node, ref) as T;
  };
}
