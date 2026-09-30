import { assert } from '../../shared/assert';
import { LIMITS } from '../../shared/limits';

// Scroll position is the one local mutation this coordinator owns on registered elements.
export interface ScrollPeer {
  scrollLeft: number;
}
export function createScrollSync() {
  const byColumns = new Map<number, Set<ScrollPeer>>();
  let peerCount = 0;
  let echoing = false;
  let cancelFrame: (() => void) | undefined;
  const release = () => {
    echoing = false;
    cancelFrame = undefined;
  };
  const register = (count: number, element: ScrollPeer | undefined) => {
    assert(Number.isSafeInteger(count), 'Variable scroll: columns must be an integer');
    assert(count >= 0, 'Variable scroll: columns must be nonnegative');
    assert(count <= LIMITS.scanEntriesMax, 'Variable scroll: column limit exceeded');
    if (!element) {
      return undefined;
    }
    const peers = byColumns.get(count) ?? new Set<ScrollPeer>();
    if (!peers.has(element)) {
      assert(peerCount < LIMITS.scanEntriesMax, 'Variable scroll: peer limit exceeded');
      peerCount++;
    }
    peers.add(element);
    byColumns.set(count, peers);
    return () => {
      if (peers.delete(element)) {
        peerCount--;
      }
      if (!peers.size && byColumns.get(count) === peers) {
        byColumns.delete(count);
      }
    };
  };
  const broadcast = (count: number, from: ScrollPeer, left: number) => {
    assert(Number.isFinite(left), 'Variable scroll: position must be finite');
    assert(peerCount <= LIMITS.scanEntriesMax, 'Variable scroll: peer limit exceeded');
    if (echoing) {
      return;
    }
    echoing = true;
    for (const element of byColumns.get(count) ?? []) {
      if (element !== from && Math.abs(element.scrollLeft - left) > 0.5) {
        element.scrollLeft = left;
      }
    }
    // One frame suppresses the scroll events caused by these assignments.
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(release);
      cancelFrame = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(release, 0);
      cancelFrame = () => clearTimeout(timer);
    }
  };
  const dispose = () => {
    cancelFrame?.();
    cancelFrame = undefined;
    echoing = false;
    for (const peers of byColumns.values()) {
      peers.clear();
    }
    byColumns.clear();
    peerCount = 0;
  };
  return { register, broadcast, dispose };
}
