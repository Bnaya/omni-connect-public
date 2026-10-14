import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createRateLimiter, RateLimiterDisposedError } from "./rate-limiter.ts";
import { flush } from "./testing.ts";

describe("createRateLimiter", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }));
  afterEach(() => mock.timers.reset());

  it("grants `perInterval` immediately, then one window later", async () => {
    using limiter = createRateLimiter({ perInterval: 3, intervalMs: 1_000 });
    const granted: Array<[number, number]> = [];
    for (let i = 0; i < 7; i++) void limiter.acquire().then(() => granted.push([i, Date.now()]));
    await flush();
    assert.deepEqual(granted, [
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    assert.equal(limiter.pending, 4);
    mock.timers.tick(1_000);
    await flush();
    assert.equal(granted.length, 6);
    mock.timers.tick(1_000);
    await flush();
    assert.deepEqual(
      granted.map(([i]) => i),
      [0, 1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(granted.at(-1), [6, 2_000]);
    assert.equal(limiter.pending, 0);
  });

  it("uses a sliding window (never more than perInterval in any intervalMs)", async () => {
    using limiter = createRateLimiter({ perInterval: 2, intervalMs: 1_000 });
    const granted: number[] = [];
    await limiter.acquire();
    granted.push(Date.now());
    mock.timers.tick(600);
    await limiter.acquire();
    granted.push(Date.now());
    const third = limiter.acquire().then(() => granted.push(Date.now()));
    const fourth = limiter.acquire().then(() => granted.push(Date.now()));
    mock.timers.tick(400);
    await third;
    mock.timers.tick(600);
    await fourth;
    assert.deepEqual(granted, [0, 600, 1_000, 1_600]);
  });

  it("is FIFO: new callers don't jump the queue once slots free up", async () => {
    using limiter = createRateLimiter({ perInterval: 1, intervalMs: 100 });
    const order: string[] = [];
    await limiter.acquire();
    const a = limiter.acquire().then(() => order.push("a"));
    mock.timers.tick(100);
    // Slot is free by the clock, but "a" is queued first.
    const b = limiter.acquire().then(() => order.push("b"));
    await flush();
    mock.timers.tick(100);
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a", "b"]);
  });

  it("an aborted waiter rejects with signal.reason and gives its place away", async () => {
    using limiter = createRateLimiter({ perInterval: 1, intervalMs: 100 });
    await limiter.acquire();
    const controller = new AbortController();
    const cancelled = limiter.acquire({ signal: controller.signal });
    const next = limiter.acquire();
    controller.abort("gave up");
    await assert.rejects(cancelled, (reason) => reason === "gave up");
    assert.equal(limiter.pending, 1);
    mock.timers.tick(100);
    await next;
    assert.equal(Date.now(), 100);
  });

  it("rejects immediately with a pre-aborted signal", async () => {
    using limiter = createRateLimiter({ perInterval: 1, intervalMs: 100 });
    await assert.rejects(limiter.acquire({ signal: AbortSignal.abort("x") }), (r) => r === "x");
  });

  it("disposing (e.g. at the end of a `using` block) rejects waiters and later calls", async () => {
    let waiting: Promise<void> | undefined;
    let escaped: ReturnType<typeof createRateLimiter> | undefined;
    {
      using limiter = createRateLimiter({ perInterval: 1, intervalMs: 1_000 });
      escaped = limiter;
      await limiter.acquire();
      waiting = limiter.acquire();
      waiting.catch(() => {});
    }
    await assert.rejects(waiting, RateLimiterDisposedError);
    assert.equal(escaped.disposed, true);
    await assert.rejects(escaped.acquire(), RateLimiterDisposedError);
    escaped.dispose(); // idempotent
  });

  it("validates options", () => {
    for (const options of [
      { perInterval: 0, intervalMs: 10 },
      { perInterval: 1.5, intervalMs: 10 },
      { perInterval: 1, intervalMs: -1 },
      { perInterval: 1, intervalMs: Number.POSITIVE_INFINITY },
    ]) {
      assert.throws(() => createRateLimiter(options), TypeError);
    }
  });
});
