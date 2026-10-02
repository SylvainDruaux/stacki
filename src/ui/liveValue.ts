// A value that changes often and is read in few places. State at the App root
// re-renders the whole app on every change — every panel, the navigator, the
// style panel — so a value that changes per chunk of dev-server output, or per
// row the pointer crosses, cost a full render each time for the one small
// component that shows it. A live value is held outside React: setting it
// notifies only the components that read it with useLiveValue.

import { useSyncExternalStore } from 'react';
import { assert } from '../../shared/core/assert';

/** Readers of one value at once: a handful of components, never a list's rows. */
const LISTENERS_MAX = 64;

export interface LiveValue<T> {
  readonly get: () => T;
  /** A value equal (Object.is) to the current one notifies no one. */
  readonly set: (next: T) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createLiveValue<T>(initial: T): LiveValue<T> {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      if (Object.is(next, current)) {
        return;
      }
      current = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe: (listener) => {
      assert(!listeners.has(listener), 'A listener subscribes once');
      listeners.add(listener);
      assert(listeners.size <= LISTENERS_MAX, 'A live value has a handful of readers');
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** No text, ever: what a component reads when it was given no live text, so it
 * can call useLiveValue unconditionally. */
export const NO_LIVE_TEXT: LiveValue<string> = createLiveValue('');

/** The value now, re-rendering this component — and only it — when it changes. */
export function useLiveValue<T>(source: LiveValue<T>): T {
  return useSyncExternalStore(source.subscribe, source.get);
}
