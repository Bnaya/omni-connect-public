/** Anything `pMap` / `pMapIterable` accept as input: a sync or async iterable of values or promises. */
export type MapInput<T> = Iterable<T | PromiseLike<T>> | AsyncIterable<T | PromiseLike<T>>;

/** The minimal iterator shape shared by sync and async iterators. */
export interface AnyIterator<T> {
  next(): IteratorResult<T> | PromiseLike<IteratorResult<T>>;
  return?(): unknown;
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as Partial<AsyncIterable<T>>)[Symbol.asyncIterator] === "function"
  );
}

function isIterable<T>(value: unknown): value is Iterable<T> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as Partial<Iterable<T>>)[Symbol.iterator] === "function"
  );
}

export function validateInput<T>(input: unknown): asserts input is MapInput<T> {
  if (!isAsyncIterable(input) && !isIterable(input)) {
    throw new TypeError(
      `Expected \`input\` to be an Iterable or AsyncIterable, got ${input === null ? "null" : typeof input}`,
    );
  }
}

export function validateMapper(mapper: unknown): void {
  if (typeof mapper !== "function") {
    throw new TypeError(`Expected \`mapper\` to be a function, got ${typeof mapper}`);
  }
}

export function isValidLimit(value: unknown, min = 1): value is number {
  return (
    value === Number.POSITIVE_INFINITY ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= min)
  );
}

export function validateConcurrency(concurrency: unknown): asserts concurrency is number {
  if (!isValidLimit(concurrency)) {
    throw new TypeError(
      `Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${String(concurrency)}\` (${typeof concurrency})`,
    );
  }
}

export function getIterator<T>(input: MapInput<T>): AnyIterator<T | PromiseLike<T>> {
  return isAsyncIterable<T | PromiseLike<T>>(input)
    ? input[Symbol.asyncIterator]()
    : input[Symbol.iterator]();
}

/**
 * Close the source (like `for await` does on early exit) so it can release resources.
 * Deliberately not awaited by callers: a source blocked in `next()` must not block us.
 */
export function closeIterator(iterator: AnyIterator<unknown>): void {
  try {
    const result = iterator.return?.();
    if (result instanceof Promise) result.catch(() => {});
  } catch {
    // A throwing `return()` must not mask the original outcome.
  }
}

/** Resolve/reject a promise, but reject early with `signal.reason` when the signal aborts. */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  const { promise: raced, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = (): void => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  return raced;
}
