export interface RateLimitOptions {
  /** How many acquisitions are allowed within any window of `intervalMs`. */
  readonly perInterval: number;
  /** Window length in milliseconds. */
  readonly intervalMs: number;
}

export interface AcquireOptions {
  /** Give up waiting for a slot. The promise rejects with `signal.reason`. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * A sliding-window rate limiter: at most `perInterval` acquisitions in any
 * `intervalMs` window, granted in FIFO order. Share one instance between
 * several `pMap` calls to put a global budget on a host.
 */
export interface RateLimiter extends Disposable {
  /** Resolve once a slot is available. Rejects with `signal.reason` on abort, or when the limiter is disposed. */
  acquire(options?: AcquireOptions): Promise<void>;
  /** Number of callers currently waiting for a slot. */
  readonly pending: number;
  readonly disposed: boolean;
  /** Stop the timer and reject all waiters. Also available as `using limiter = createRateLimiter(...)`. */
  dispose(): void;
}

export class RateLimiterDisposedError extends Error {
  override name = "RateLimiterDisposedError";
  constructor() {
    super("The rate limiter was disposed");
  }
}

interface Waiter {
  resolve(): void;
  reject(reason: unknown): void;
  cleanup(): void;
}

export function validateRateLimitOptions(options: RateLimitOptions): void {
  const { perInterval, intervalMs } = options;
  if (!(Number.isSafeInteger(perInterval) && perInterval >= 1)) {
    throw new TypeError(
      `Expected \`perInterval\` to be an integer from 1 and up, got \`${String(perInterval)}\``,
    );
  }
  if (!(typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs >= 0)) {
    throw new TypeError(
      `Expected \`intervalMs\` to be a finite number >= 0, got \`${String(intervalMs)}\``,
    );
  }
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  validateRateLimitOptions(options);
  const { perInterval, intervalMs } = options;

  // Timestamps (Date.now(), so node:test mock timers can drive it) of grants in the current window.
  const grants: number[] = [];
  const waiters: Waiter[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const prune = (now: number): void => {
    while (grants.length > 0 && now - grants[0]! >= intervalMs) grants.shift();
  };

  const tryGrant = (): boolean => {
    const now = Date.now();
    prune(now);
    if (grants.length >= perInterval) return false;
    grants.push(now);
    return true;
  };

  const schedule = (): void => {
    if (timer !== undefined || waiters.length === 0 || disposed) return;
    const wait = Math.max(0, grants[0]! + intervalMs - Date.now());
    timer = setTimeout(drain, wait);
  };

  function drain(): void {
    timer = undefined;
    while (waiters.length > 0 && tryGrant()) {
      const waiter = waiters.shift()!;
      waiter.cleanup();
      waiter.resolve();
    }
    schedule();
  }

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    timer = undefined;
    const error = new RateLimiterDisposedError();
    for (const waiter of waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(error);
    }
  };

  return {
    acquire({ signal } = {}) {
      if (disposed) return Promise.reject(new RateLimiterDisposedError());
      if (signal?.aborted) return Promise.reject(signal.reason);
      // Only jump straight in when nobody is queued, to keep FIFO fairness.
      if (waiters.length === 0 && tryGrant()) return Promise.resolve();

      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const onAbort = (): void => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(signal?.reason);
        if (waiters.length === 0) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(waiter);
      schedule();
      return promise;
    },
    get pending() {
      return waiters.length;
    },
    get disposed() {
      return disposed;
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}

export function isRateLimiter(value: RateLimiter | RateLimitOptions): value is RateLimiter {
  return typeof (value as Partial<RateLimiter>).acquire === "function";
}
