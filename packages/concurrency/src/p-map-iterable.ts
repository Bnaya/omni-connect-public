import {
  closeIterator,
  getIterator,
  isValidLimit,
  raceSignal,
  validateConcurrency,
  validateInput,
  validateMapper,
  type MapInput,
} from "./internal.ts";
import {
  pMapSkip,
  resolveRateLimit,
  type Mapper,
  type MapperContext,
  type PMapSkip,
} from "./p-map.ts";
import {
  isRateLimiter,
  validateRateLimitOptions,
  type RateLimiter,
  type RateLimitOptions,
} from "./rate-limiter.ts";

export interface PMapIterableOptions {
  /** Max number of mappers running at once. Integer >= 1 or `Infinity` (default). */
  readonly concurrency?: number;
  /**
   * Max number of results (running + finished but not yet consumed) held ahead of the consumer.
   * Integer >= `concurrency` or `Infinity`. Defaults to `concurrency`.
   */
  readonly backpressure?: number;
  /** Cancel: the pending `next()` rejects with `signal.reason`, in-flight mappers are aborted and the source is closed. */
  readonly signal?: AbortSignal | undefined;
  /** Throttle mapper starts; see `PMapOptions.rateLimit`. */
  readonly rateLimit?: RateLimiter | RateLimitOptions | undefined;
}

type Outcome<R> =
  | { readonly kind: "value"; readonly value: R }
  | { readonly kind: "skip" }
  | { readonly kind: "done" }
  | { readonly kind: "error"; readonly error: unknown };

/**
 * Like `pMap`, but yields results in input order as soon as they are ready,
 * without buffering the whole output. Breaking out of `for await` (or
 * `await using` the generator) aborts in-flight mappers and closes the source.
 *
 * Arguments are validated eagerly (throws synchronously), unlike a plain async generator.
 */
export function pMapIterable<T, R>(
  input: MapInput<T>,
  mapper: Mapper<T, R>,
  options: PMapIterableOptions = {},
): AsyncGenerator<Exclude<R, PMapSkip>, void, undefined> {
  const { concurrency = Number.POSITIVE_INFINITY, signal: outerSignal } = options;
  validateInput<T>(input);
  validateMapper(mapper);
  validateConcurrency(concurrency);
  const backpressure = options.backpressure ?? concurrency;
  if (!isValidLimit(backpressure, concurrency)) {
    throw new TypeError(
      `Expected \`backpressure\` to be an integer from \`concurrency\` (${concurrency}) and up or \`Infinity\`, got \`${String(backpressure)}\` (${typeof backpressure})`,
    );
  }
  if (options.rateLimit && !isRateLimiter(options.rateLimit)) {
    validateRateLimitOptions(options.rateLimit);
  }
  return generate(input, mapper, concurrency, backpressure, outerSignal, options.rateLimit);
}

async function* generate<T, R>(
  input: MapInput<T>,
  mapper: Mapper<T, R>,
  concurrency: number,
  backpressure: number,
  outerSignal: AbortSignal | undefined,
  rateLimit: RateLimiter | RateLimitOptions | undefined,
): AsyncGenerator<Exclude<R, PMapSkip>, void, undefined> {
  const iterator = getIterator(input);
  if (outerSignal?.aborted) {
    closeIterator(iterator);
    throw outerSignal.reason;
  }
  const { limiter, owned } = resolveRateLimit(rateLimit);
  const controller = new AbortController();
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, controller.signal])
    : controller.signal;
  const context: MapperContext = { signal };

  // In input order: entries being pulled, mapped, or finished and waiting for the consumer.
  // Entries never reject, so abandoned ones cannot cause unhandled rejections.
  const queue: Array<Promise<Outcome<R>>> = [];
  let running = 0;
  let pulling = false;
  let sourceDone = false;
  // Set when the consumer is gone (break/return/throw/abort).
  let stopped = false;
  // Index of the first failed element; nothing is pulled or started after it.
  let firstErrorIndex = Number.POSITIVE_INFINITY;
  let nextIndex = 0;

  const spawn = (): void => {
    // One pull at a time (like `for await`); the next pull is spawned once this one resolves.
    if (pulling || stopped || sourceDone || firstErrorIndex !== Number.POSITIVE_INFINITY) return;
    if (running >= concurrency || queue.length >= backpressure) return;
    pulling = true;
    running++;

    // Assigned synchronously below, long before the first `await` inside can resume.
    let entry: Promise<Outcome<R>> | undefined;
    entry = (async (): Promise<Outcome<R>> => {
      let item: IteratorResult<T | PromiseLike<T>>;
      try {
        item = await iterator.next();
      } catch (error) {
        sourceDone = true;
        pulling = false;
        running--;
        return { kind: "error", error };
      }
      pulling = false;
      if (item.done) {
        sourceDone = true;
        running--;
        return { kind: "done" };
      }
      const index = nextIndex++;
      spawn();

      let outcome: Outcome<R>;
      try {
        const element = await item.value;
        if (stopped || index > firstErrorIndex) {
          outcome = { kind: "skip" };
        } else {
          if (limiter) await limiter.acquire({ signal });
          const value = await mapper(element, index, context);
          outcome = value === pMapSkip ? { kind: "skip" } : { kind: "value", value };
        }
      } catch (error) {
        // Stop spawning more work; the consumer throws when it reaches this entry.
        firstErrorIndex = Math.min(firstErrorIndex, index);
        outcome = { kind: "error", error };
      }
      running--;
      if (outcome.kind === "skip") {
        // A skipped entry that isn't at the head shouldn't count against backpressure.
        const position = entry === undefined ? -1 : queue.indexOf(entry);
        if (position > 0) queue.splice(position, 1);
      }
      spawn();
      return outcome;
    })();
    queue.push(entry);
  };

  try {
    spawn();
    while (queue.length > 0) {
      const head = queue[0]!;
      const outcome = await raceSignal(head, outerSignal);
      if (queue[0] === head) queue.shift();
      switch (outcome.kind) {
        case "error":
          throw outcome.error;
        case "done":
          return;
        case "skip":
          spawn();
          continue;
        case "value":
          spawn();
          yield outcome.value as Exclude<R, PMapSkip>;
      }
    }
  } finally {
    stopped = true;
    controller.abort(
      outerSignal?.aborted
        ? outerSignal.reason
        : new DOMException("pMapIterable was closed", "AbortError"),
    );
    if (!sourceDone) closeIterator(iterator);
    if (owned) limiter?.dispose();
  }
}
