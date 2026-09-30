import { assert } from '../../../shared/assert';

type Answer = string | null;
type Query = (path: string, keys: string[]) => Promise<Record<string, Answer> | null>;
type Entry = { value?: Answer; promise: Promise<Answer>; resolve: (value: Answer) => void };

// A pending answer and the function that settles it. The executor runs
// synchronously inside the constructor, so the settle function exists on return.
function deferAnswer(): Pick<Entry, 'promise' | 'resolve'> {
  const settle: { resolve?: Entry['resolve'] } = {};
  const promise = new Promise<Answer>((done) => {
    settle.resolve = done;
  });
  assert(settle.resolve !== undefined, 'A promise executor runs synchronously');
  return { promise, resolve: settle.resolve };
}

/** Batch a render's requests by element, deduplicate outstanding work, and discard
 * replies from before an invalidation. Undefined means pending; null means the
 * page could not answer, so consumers can settle on their fallback. */
export function createQueryCache(query: Query) {
  let entries = new Map<string, Map<string, Entry>>();
  let queued = new Map<string, Set<string>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scope: unknown[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  function clear(notifyListeners = true) {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = null;
    for (const values of entries.values()) {
      for (const entry of values.values()) {
        if (entry.value === undefined) {
          entry.resolve(null);
        }
      }
    }
    entries = new Map();
    queued = new Map();
    if (notifyListeners) {
      notify();
    }
  }

  function flush() {
    const batch = queued;
    const generation = entries;
    queued = new Map();
    timer = null;
    for (const [path, keys] of batch) {
      // Promise.resolve also contains a bridge that throws before returning.
      void Promise.resolve()
        .then(() => query(path, [...keys]))
        .catch(() => null)
        .then((answer) => {
          if (generation !== entries) {
            return;
          }
          // Same generation, so every queued key still has the entry `get` made for it.
          const values = entries.get(path);
          assert(values !== undefined, `Queued path ${path} has entries`);
          for (const key of keys) {
            const entry = values.get(key);
            assert(entry !== undefined, `Queued key ${key} has an entry`);
            entry.value = answer?.[key] ?? null;
            entry.resolve(entry.value);
          }
          notify();
        });
    }
  }

  return {
    clear,
    // Called during render as well as effects: paths are reused by different
    // documents. Never show a cached value from the previously open file.
    setScope(next: unknown[]) {
      if (scope.length === next.length && scope.every((value, i) => value === next[i])) {
        return;
      }
      scope = next;
      clear(false);
    },
    read(path: string, key: string): Answer | undefined {
      return entries.get(path)?.get(key)?.value;
    },
    request(path: string, key: string): Promise<Answer> {
      let values = entries.get(path);
      if (!values) {
        entries.set(path, (values = new Map()));
      }
      const existing = values.get(key);
      if (existing) {
        return existing.promise;
      }
      const { promise, resolve } = deferAnswer();
      values.set(key, { promise, resolve });
      let keys = queued.get(path);
      if (!keys) {
        queued.set(path, (keys = new Set()));
      }
      keys.add(key);
      if (timer === null) {
        timer = setTimeout(flush, 0);
      }
      return promise;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
