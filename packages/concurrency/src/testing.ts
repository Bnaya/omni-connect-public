import { setImmediate as nextMacrotask } from "node:timers/promises";

/** Let pending promise chains settle (setImmediate is never mocked by our tests). */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await nextMacrotask();
}

/** A promise you resolve/reject by hand, to control exactly when a mapper finishes. */
export function deferred<T = void>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

/** Tracks how many tasks run at once. */
export function concurrencyProbe(): {
  readonly max: number;
  readonly running: number;
  enter(): void;
  leave(): void;
} {
  let running = 0;
  let max = 0;
  return {
    get max() {
      return max;
    },
    get running() {
      return running;
    },
    enter() {
      running++;
      max = Math.max(max, running);
    },
    leave() {
      running--;
    },
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** An async iterator that records concurrent `next()` calls and whether it was closed. */
export function trackedAsyncSource(count: number): AsyncIterable<number> & {
  readonly pulled: number;
  readonly maxConcurrentNext: number;
  readonly returned: boolean;
} {
  let pulled = 0;
  let inNext = 0;
  let maxConcurrentNext = 0;
  let returned = false;
  return {
    get pulled() {
      return pulled;
    },
    get maxConcurrentNext() {
      return maxConcurrentNext;
    },
    get returned() {
      return returned;
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<number>> {
          inNext++;
          maxConcurrentNext = Math.max(maxConcurrentNext, inNext);
          await flush(1);
          inNext--;
          if (returned || pulled >= count) return { done: true, value: undefined };
          return { done: false, value: pulled++ };
        },
        async return(): Promise<IteratorResult<number>> {
          returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
}
