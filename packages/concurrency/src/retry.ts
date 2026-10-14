import { delay } from "./delay.ts";

export interface RetryContext {
  /** 1-based attempt number. */
  readonly attempt: number;
  /** Aborts when the caller's signal aborts. Pass it on to `fetch` etc. */
  readonly signal: AbortSignal;
}

export interface RetryDecisionContext {
  /** The attempt that just failed (1-based). */
  readonly attempt: number;
  /** Retries left after this one. */
  readonly retriesLeft: number;
  /** The delay the backoff would use before the next attempt. */
  readonly delayMs: number;
}

/**
 * Computes the delay (ms) before the next attempt. `attempt` is the attempt that just failed (1-based).
 */
export type Backoff = (attempt: number, error: unknown) => number;

export interface RetryOptions {
  /** Retries after the first attempt (so `retries: 3` means up to 4 calls). Default 3. */
  readonly retries?: number;
  /** A fixed delay in ms, or a `Backoff` function. Default: `exponentialBackoff()`. */
  readonly backoff?: number | Backoff;
  /** Cancels waiting and the running attempt (through `context.signal`). Rejects with `signal.reason`. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Decide whether to retry after an error. Return `false` to give up (the error is rethrown),
   * `true` to retry after the backoff delay, or a number of ms to override the delay
   * (e.g. from a `Retry-After` header). Default: retry everything except `AbortError`s.
   */
  readonly shouldRetry?: (
    error: unknown,
    context: RetryDecisionContext,
  ) => boolean | number | PromiseLike<boolean | number>;
  /** Called before waiting for the next attempt; handy for logging. */
  readonly onRetry?: (error: unknown, context: RetryDecisionContext) => void;
}

export interface ExponentialBackoffOptions {
  /** Delay after the first failure. Default 200 ms. */
  readonly initialMs?: number;
  /** Growth per attempt. Default 2. */
  readonly factor?: number;
  /** Upper bound. Default 30 s. */
  readonly maxMs?: number;
  /** "Full jitter": pick uniformly in `[0, delay]` to avoid thundering herds. Default true. */
  readonly jitter?: boolean;
}

export function exponentialBackoff({
  initialMs = 200,
  factor = 2,
  maxMs = 30_000,
  jitter = true,
}: ExponentialBackoffOptions = {}): Backoff {
  return (attempt) => {
    const base = Math.min(maxMs, initialMs * factor ** (attempt - 1));
    return jitter ? Math.round(Math.random() * base) : base;
  };
}

function isAbortError(error: unknown): boolean {
  // Per-attempt timeouts (`TimeoutError`) are retried; plain aborts are not.
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Call `fn` until it succeeds, it has been retried `retries` times, or `shouldRetry` says stop.
 * Rejects with the last error (or `signal.reason` when aborted).
 */
export async function retry<R>(
  fn: (context: RetryContext) => R | PromiseLike<R>,
  options: RetryOptions = {},
): Promise<R> {
  const {
    retries = 3,
    backoff = exponentialBackoff(),
    signal = new AbortController().signal,
    shouldRetry = (error: unknown) => !isAbortError(error),
    onRetry,
  } = options;
  if (!(retries === Number.POSITIVE_INFINITY || (Number.isSafeInteger(retries) && retries >= 0))) {
    throw new TypeError(
      `Expected \`retries\` to be an integer >= 0 or \`Infinity\`, got \`${String(retries)}\``,
    );
  }
  const backoffFn: Backoff = typeof backoff === "number" ? () => backoff : backoff;

  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await fn({ attempt, signal });
    } catch (error) {
      // An abort from our own signal is final, whatever `shouldRetry` would say.
      signal.throwIfAborted();
      const retriesLeft = retries - attempt;
      if (retriesLeft < 0) throw error;
      const decisionContext: RetryDecisionContext = {
        attempt,
        retriesLeft,
        delayMs: Math.max(0, backoffFn(attempt, error)),
      };
      const decision = await shouldRetry(error, decisionContext);
      if (decision === false) throw error;
      const delayMs =
        typeof decision === "number" ? Math.max(0, decision) : decisionContext.delayMs;
      const context = { ...decisionContext, delayMs };
      onRetry?.(error, context);
      await delay(delayMs, { signal });
    }
  }
}
