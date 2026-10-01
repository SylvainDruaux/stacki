// Enqueue before waiting: several callers waiting on the same current task
// would otherwise all start together when it settles. A failure only rejects
// its caller and never prevents the following task from running.

type Task<T> = () => Promise<T> | T;

function createSerialQueue(): <T>(task: Task<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: Task<T>): Promise<T> => {
    const result: Promise<T> = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}

// One pending result per key, while different keys still share the same serial
// resource. Cancellation also invalidates active work at its next checkpoint.
function createKeyedQueue<T>(): {
  run(key: string, task: (assertActive: () => void) => Promise<T> | T): Promise<T>;
  cancel(): void;
} {
  const queue = createSerialQueue();
  const pending = new Map<string, Promise<T>>();
  let era = 0;
  return {
    run(key: string, task: (assertActive: () => void) => Promise<T> | T): Promise<T> {
      const existing = pending.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const startedIn = era;
      const assertActive = (): void => {
        if (startedIn !== era) {
          throw new Error('The operation was cancelled.');
        }
      };
      const result = queue(() => {
        assertActive();
        return task(assertActive);
      });
      pending.set(key, result);
      const clear = (): void => {
        if (pending.get(key) === result) {
          pending.delete(key);
        }
      };
      result.then(clear, clear);
      return result;
    },
    cancel(): void {
      era++;
      pending.clear();
    },
  };
}

export { createSerialQueue, createKeyedQueue };
