# @omni/concurrency

Polite fan-out for connectors: bounded concurrency, cancellation, rate limits and retries.
It's our own AbortSignal-first take on [p-map](https://github.com/sindresorhus/p-map), with no runtime dependencies.

```ts
import { createRateLimiter, delay, pMap, pMapIterable, pMapSkip, retry } from "@omni/concurrency";
```

## `pMap(input, mapper, options?)`

Maps a sync or async iterable (of values or promises) and resolves to the results **in input order**.

```ts
const pages = await pMap(
  listingIds,
  async (id, index, { signal }) => {
    const res = await fetch(`https://example.com/item/${id}`, { signal });
    if (res.status === 404) return pMapSkip; // left out of the result
    return res.json();
  },
  {
    concurrency: 4,
    signal: AbortSignal.timeout(60_000),
    rateLimit: { perInterval: 2, intervalMs: 1_000 },
  },
);
```

| option        | default    | meaning                                                                                                                       |
| ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `concurrency` | `Infinity` | max mappers running at once (integer >= 1 or `Infinity`, validated)                                                           |
| `stopOnError` | `true`     | `true`: reject with the first error. `false`: finish everything, then reject with an `AggregateError` (errors in input order) |
| `signal`      | none       | cancel: rejects with `signal.reason`, stops pulling input and calls `iterator.return()`                                       |
| `rateLimit`   | none       | `{ perInterval, intervalMs }` for a private limiter, or a shared `RateLimiter`                                                |

The mapper's `context.signal` combines your `signal` (via `AbortSignal.any`) with an internal one that aborts
when the map fails (with `stopOnError`), so in-flight `fetch`es get cancelled. Input is pulled one element
at a time (never concurrent `next()` calls), and only as fast as `concurrency` allows.

## `pMapIterable(input, mapper, options?)`

An async generator that yields results in input order as soon as they're ready, with bounded buffering.

```ts
for await (const listing of pMapIterable(searchPages(), fetchListing, {
  concurrency: 3,
  backpressure: 6,
})) {
  if (isOldEnough(listing)) break; // aborts in-flight mappers and closes searchPages()
}
```

- `concurrency`: as above. `backpressure` (default `concurrency`): max results running or waiting for the consumer.
- `signal` and `rateLimit`: as above. On abort, the pending `next()` rejects with `signal.reason`.
- Errors are thrown in order (earlier results are still yielded first).
- Leaving early (`break`, `return()`, `await using`) aborts in-flight mappers and calls `iterator.return()` on the source.
- Arguments are validated synchronously.

## `createRateLimiter({ perInterval, intervalMs })`

A FIFO sliding-window limiter (at most `perInterval` grants in any `intervalMs` window). Share one per host
across several `pMap` calls. It's `Disposable`: disposing clears its timer and rejects waiters with
`RateLimiterDisposedError`.

```ts
using yad2 = createRateLimiter({ perInterval: 1, intervalMs: 2_000 });
await pMap(searchUrls, fetchPage, { concurrency: 2, rateLimit: yad2 });
await pMap(itemUrls, fetchItem, { concurrency: 2, rateLimit: yad2 }); // same budget
await yad2.acquire({ signal }); // or use it directly
```

## `delay(ms, { signal }?)`

A promise that resolves after `ms`, or rejects with `signal.reason` (and clears the timer) on abort.

## `retry(fn, options?)`

```ts
const data = await retry(
  async ({ attempt, signal }) => {
    const res = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!res.ok) throw new HttpError(res);
    return res.json();
  },
  {
    retries: 4, // up to 5 calls
    backoff: exponentialBackoff({ initialMs: 500, maxMs: 30_000 }), // the default is 200ms x2, full jitter
    signal,
    // false = give up, true = retry after the backoff, number = retry after that many ms (Retry-After)
    shouldRetry: (error) =>
      error instanceof HttpError && error.status === 429 ? error.retryAfterMs : error.status >= 500,
  },
);
```

- Rejects with the last error, or with `signal.reason` on abort (checked before each attempt and during the wait).
- The default `shouldRetry` retries everything except `AbortError` (per-attempt `TimeoutError`s are retried).
- `backoff` is a number (fixed ms) or `(attempt, error) => ms`. `onRetry(error, { attempt, retriesLeft, delayMs })` is for logging.

## Tests

`node --test` in this directory (node:test, with mock timers for the rate-limit and backoff timing).
