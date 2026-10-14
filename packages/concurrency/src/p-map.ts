import {
  closeIterator,
  getIterator,
  validateConcurrency,
  validateInput,
  validateMapper,
  type MapInput,
} from "./internal.ts";
import {
  createRateLimiter,
  isRateLimiter,
  type RateLimiter,
  type RateLimitOptions,
} from "./rate-limiter.ts";

/** Return this from a mapper to leave the element out of the results. */
export const pMapSkip: unique symbol = Symbol("pMapSkip");
export type PMapSkip = typeof pMapSkip;

export interface MapperContext {
  /**
   * Aborted when the caller's `signal` aborts, or when the whole map fails
   * (`stopOnError`) / the consumer stops iterating. Pass it to `fetch` etc.
   */
  readonly signal: AbortSignal;
}

export type Mapper<T, R> = (
  element: T,
  index: number,
  context: MapperContext,
) => R | PromiseLike<R>;

export interface PMapOptions {
  /** Max number of mappers running at once. Integer >= 1 or `Infinity` (default). */
  readonly concurrency?: number;
  /**
   * `true` (default): reject with the first error and abort the rest.
   * `false`: keep going, then reject with an `AggregateError` of all errors (in input order).
   */
  readonly stopOnError?: boolean;
  /** Cancel the whole map: rejects with `signal.reason`, stops pulling input and closes the iterator. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Throttle mapper *starts*. Pass options to get a private limiter for this call,
   * or a shared `RateLimiter` (from `createRateLimiter`) to budget several calls together.
   */
  readonly rateLimit?: RateLimiter | RateLimitOptions | undefined;
}

export function resolveRateLimit(rateLimit: RateLimiter | RateLimitOptions | undefined): {
  limiter: RateLimiter | undefined;
  owned: boolean;
} {
  if (rateLimit === undefined) return { limiter: undefined, owned: false };
  if (isRateLimiter(rateLimit)) return { limiter: rateLimit, owned: false };
  return { limiter: createRateLimiter(rateLimit), owned: true };
}

/**
 * Map over a (sync or async) iterable with bounded concurrency, preserving input order.
 *
 * Elements may be promises; they are awaited before being passed to the mapper.
 */
export async function pMap<T, R>(
  input: MapInput<T>,
  mapper: Mapper<T, R>,
  options: PMapOptions = {},
): Promise<Array<Exclude<R, PMapSkip>>> {
  const {
    concurrency = Number.POSITIVE_INFINITY,
    stopOnError = true,
    signal: outerSignal,
  } = options;
  validateInput<T>(input);
  validateMapper(mapper);
  validateConcurrency(concurrency);
  const { limiter, owned } = resolveRateLimit(options.rateLimit);

  const iterator = getIterator(input);
  const controller = new AbortController();
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, controller.signal])
    : controller.signal;
  const context: MapperContext = { signal };

  const { promise, resolve, reject } = Promise.withResolvers<Array<Exclude<R, PMapSkip>>>();
  const results: Array<R> = [];
  const errors: Array<{ index: number; error: unknown }> = [];
  let settled = false;
  let sourceDone = false;
  let active = 0;
  let nextIndex = 0;
  let wakePump: (() => void) | undefined;

  const wake = (): void => {
    const fn = wakePump;
    wakePump = undefined;
    fn?.();
  };

  const cleanup = (): void => {
    outerSignal?.removeEventListener("abort", onAbort);
    if (owned) limiter?.dispose();
    wake();
  };

  const fail = (reason: unknown): void => {
    if (settled) return;
    settled = true;
    reject(reason);
    // Cancel in-flight mappers, stop pulling, and let the source release its resources.
    controller.abort(reason);
    if (!sourceDone) closeIterator(iterator);
    cleanup();
  };

  function onAbort(): void {
    fail(outerSignal?.reason);
  }

  const maybeFinish = (): void => {
    if (settled || !sourceDone || active > 0) return;
    settled = true;
    cleanup();
    if (errors.length > 0) {
      errors.sort((a, b) => a.index - b.index);
      reject(
        new AggregateError(
          errors.map(({ error }) => error),
          `${errors.length} of ${nextIndex} pMap mappers failed`,
        ),
      );
      return;
    }
    resolve(results.filter((value): value is Exclude<R, PMapSkip> => value !== pMapSkip));
  };

  const run = async (value: T | PromiseLike<T>, index: number): Promise<void> => {
    try {
      const element = await value;
      if (settled) return;
      if (limiter) await limiter.acquire({ signal });
      if (settled) return;
      results[index] = await mapper(element, index, context);
    } catch (error) {
      if (settled) return;
      if (stopOnError) fail(error);
      else errors.push({ index, error });
    } finally {
      active--;
      wake();
      maybeFinish();
    }
  };

  // Pulls one element at a time (like `for await`), so generators and queues never see concurrent `next()` calls.
  const pump = async (): Promise<void> => {
    while (!settled) {
      if (active >= concurrency) {
        await new Promise<void>((resolveWake) => {
          wakePump = resolveWake;
        });
        continue;
      }
      let item: IteratorResult<T | PromiseLike<T>>;
      try {
        item = await iterator.next();
      } catch (error) {
        // A throwing iterator is finished; it would most likely keep throwing.
        sourceDone = true;
        fail(error);
        return;
      }
      if (settled) return;
      if (item.done) {
        sourceDone = true;
        maybeFinish();
        return;
      }
      active++;
      void run(item.value, nextIndex++);
    }
  };

  if (outerSignal?.aborted) {
    fail(outerSignal.reason);
  } else {
    outerSignal?.addEventListener("abort", onAbort, { once: true });
    void pump();
  }
  return promise;
}
