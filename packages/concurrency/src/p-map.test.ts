import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { delay } from "./delay.ts";
import { pMap, pMapSkip } from "./p-map.ts";
import { createRateLimiter } from "./rate-limiter.ts";
import { concurrencyProbe, deferred, flush, sleep, trackedAsyncSource } from "./testing.ts";

describe("pMap", () => {
  it("maps and preserves input order regardless of completion order", async () => {
    const delays = [30, 5, 20, 1, 10];
    const result = await pMap(delays, async (ms, index) => {
      await sleep(ms);
      return `${index}:${ms}`;
    });
    assert.deepEqual(result, ["0:30", "1:5", "2:20", "3:1", "4:10"]);
  });

  it("resolves an empty input to an empty array", async () => {
    assert.deepEqual(await pMap([], () => 1), []);
    assert.deepEqual(await pMap((async function* () {})(), () => 1), []);
  });

  it("awaits promises in the input and supports sync mappers", async () => {
    const result = await pMap([Promise.resolve(1), 2, sleep(5).then(() => 3)], (n) => n * 10);
    assert.deepEqual(result, [10, 20, 30]);
  });

  it("never runs more than `concurrency` mappers at once", async () => {
    for (const concurrency of [1, 2, 5]) {
      const probe = concurrencyProbe();
      await pMap(
        Array.from({ length: 20 }, (_, i) => i),
        async (i) => {
          probe.enter();
          await sleep(i % 3);
          probe.leave();
        },
        { concurrency },
      );
      assert.equal(probe.max, concurrency);
    }
  });

  it("starts everything at once with the default Infinity concurrency", async () => {
    const probe = concurrencyProbe();
    const gate = deferred();
    const done = pMap(
      Array.from({ length: 50 }, (_, i) => i),
      async () => {
        probe.enter();
        await gate.promise;
        probe.leave();
      },
    );
    await flush();
    assert.equal(probe.running, 50);
    gate.resolve();
    await done;
  });

  it("passes the index and a context with an AbortSignal", async () => {
    const seen: Array<[string, number, boolean]> = [];
    await pMap(["a", "b"], (value, index, { signal }) => {
      seen.push([value, index, signal instanceof AbortSignal]);
    });
    assert.deepEqual(seen, [
      ["a", 0, true],
      ["b", 1, true],
    ]);
  });

  it("validates arguments", async () => {
    for (const concurrency of [0, -1, 1.5, Number.NaN, "2" as unknown as number]) {
      await assert.rejects(
        pMap([1], (x) => x, { concurrency }),
        TypeError,
      );
    }
    await assert.rejects(
      pMap(42 as unknown as number[], (x) => x),
      TypeError,
    );
    await assert.rejects(
      pMap(null as unknown as number[], (x) => x),
      TypeError,
    );
    await assert.rejects(pMap([1], "nope" as unknown as () => number), TypeError);
    await assert.rejects(
      pMap([1], (x) => x, { rateLimit: { perInterval: 0, intervalMs: 10 } }),
      TypeError,
    );
    assert.deepEqual(await pMap([1], (x) => x, { concurrency: Number.POSITIVE_INFINITY }), [1]);
  });

  describe("pMapSkip", () => {
    it("drops skipped results, including several of them", async () => {
      const result = await pMap([1, 2, 3, 4, 5, 6], async (n) => (n % 2 === 0 ? pMapSkip : n), {
        concurrency: 2,
      });
      assert.deepEqual(result, [1, 3, 5]);
    });

    it("can skip everything", async () => {
      assert.deepEqual(await pMap([1, 2], () => pMapSkip), []);
    });
  });

  describe("errors with stopOnError: true (default)", () => {
    it("rejects with the first error, aborts in-flight mappers and starts no more", async () => {
      const boom = new Error("boom");
      const started: number[] = [];
      const abortReasons: unknown[] = [];
      await assert.rejects(
        pMap(
          [0, 1, 2, 3, 4, 5],
          async (i, _index, { signal }) => {
            started.push(i);
            if (i === 1) {
              await sleep(5);
              throw boom;
            }
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => {
                abortReasons.push(signal.reason);
                resolve();
              });
            });
          },
          { concurrency: 3 },
        ),
        boom,
      );
      await flush();
      assert.deepEqual(started, [0, 1, 2]);
      assert.deepEqual(abortReasons, [boom, boom]);
    });

    it("rejects on a synchronous mapper throw", async () => {
      await assert.rejects(
        pMap([1], () => {
          throw new RangeError("sync");
        }),
        RangeError,
      );
    });

    it("rejects when an input promise rejects", async () => {
      const error = new Error("input");
      await assert.rejects(
        pMap([1, Promise.reject(error)], (x) => x),
        error,
      );
    });

    it("closes the source iterator", async () => {
      let closed = false;
      function* source() {
        try {
          for (let i = 0; ; i++) yield i;
        } finally {
          closed = true;
        }
      }
      await assert.rejects(
        pMap(
          source(),
          (i) => {
            if (i === 3) throw new Error("stop");
            return i;
          },
          { concurrency: 2 },
        ),
        /stop/,
      );
      assert.equal(closed, true);
    });

    it("rejects when the iterator itself throws", async () => {
      const error = new Error("iterator broke");
      async function* source() {
        yield 1;
        throw error;
      }
      await assert.rejects(
        pMap(source(), (x) => x),
        error,
      );
    });
  });

  describe("errors with stopOnError: false", () => {
    it("runs everything, then rejects with an AggregateError in input order", async () => {
      const ran: number[] = [];
      const error = await pMap(
        [0, 1, 2, 3, 4],
        async (i, _index, { signal }) => {
          await sleep(10 - i * 2); // later items fail first
          ran.push(i);
          assert.equal(signal.aborted, false);
          if (i % 2 === 1) throw new Error(`fail ${i}`);
          return i;
        },
        { concurrency: 2, stopOnError: false },
      ).then(
        () => assert.fail("should reject"),
        (reason: unknown) => reason,
      );
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((e: unknown) => (e as Error).message),
        ["fail 1", "fail 3"],
      );
      assert.deepEqual(ran.toSorted(), [0, 1, 2, 3, 4]);
    });

    it("resolves normally when nothing fails, skipping pMapSkip", async () => {
      const result = await pMap([1, 2, 3], (n) => (n === 2 ? pMapSkip : n), { stopOnError: false });
      assert.deepEqual(result, [1, 3]);
    });
  });

  describe("AbortSignal", () => {
    it("rejects with signal.reason when aborted before starting, and closes the iterator", async () => {
      let mapperCalls = 0;
      let closed = false;
      function* source() {
        try {
          yield 1;
        } finally {
          closed = true;
        }
      }
      const generator = source();
      const reason = new Error("cancelled early");
      await assert.rejects(
        pMap(generator, () => mapperCalls++, { signal: AbortSignal.abort(reason) }),
        reason,
      );
      assert.equal(mapperCalls, 0);
      // `return()` on a not-yet-started generator finishes it without running `finally`.
      assert.equal(closed, false);
      assert.deepEqual(generator.next(), { done: true, value: undefined });
    });

    it("rejects with signal.reason when aborted mid-way, cancels mappers and stops pulling", async () => {
      const controller = new AbortController();
      const source = trackedAsyncSource(100);
      const mapperAborts: unknown[] = [];
      const promise = pMap(
        source,
        async (_value, _index, { signal }) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              mapperAborts.push(signal.reason);
              resolve();
            });
          });
        },
        { concurrency: 3, signal: controller.signal },
      );
      await flush(10);
      assert.equal(source.pulled, 3);
      const reason = new DOMException("user cancelled", "AbortError");
      controller.abort(reason);
      await assert.rejects(promise, (error) => error === reason);
      await flush(10);
      assert.equal(source.returned, true);
      assert.equal(source.pulled, 3);
      assert.deepEqual(mapperAborts, [reason, reason, reason]);
    });

    it("the mapper signal follows the outer signal (AbortSignal.any)", async () => {
      const controller = new AbortController();
      let innerSignal: AbortSignal | undefined;
      const promise = pMap(
        [1],
        async (_v, _i, { signal }) => {
          innerSignal = signal;
          await delay(1_000, { signal });
        },
        { signal: controller.signal },
      );
      await flush();
      assert.notEqual(innerSignal, controller.signal);
      assert.equal(innerSignal?.aborted, false);
      controller.abort("because");
      await assert.rejects(promise, (reason) => reason === "because");
      assert.equal(innerSignal?.reason, "because");
    });

    it("works with AbortSignal.timeout", async () => {
      await assert.rejects(
        pMap([1, 2], (_v, _i, { signal }) => delay(1_000, { signal }), {
          signal: AbortSignal.timeout(10),
        }),
        { name: "TimeoutError" },
      );
    });

    it("ignores an abort after completion", async () => {
      const controller = new AbortController();
      assert.deepEqual(await pMap([1], (x) => x, { signal: controller.signal }), [1]);
      controller.abort();
    });
  });

  describe("async iterable input", () => {
    it("pulls one element at a time and lazily (bounded by concurrency)", async () => {
      const source = trackedAsyncSource(12);
      const pulledWhenStarted: number[] = [];
      const result = await pMap(
        source,
        async (value) => {
          pulledWhenStarted.push(source.pulled);
          await sleep(2);
          return value * 2;
        },
        { concurrency: 3 },
      );
      assert.deepEqual(
        result,
        Array.from({ length: 12 }, (_, i) => i * 2),
      );
      assert.equal(source.maxConcurrentNext, 1);
      // Never more than `concurrency` elements pulled ahead of what's finished.
      assert.ok(pulledWhenStarted.every((pulled, index) => pulled <= index + 3));
    });

    it("works with an async generator of promises", async () => {
      async function* source() {
        yield Promise.resolve("a");
        yield "b";
      }
      assert.deepEqual(await pMap(source(), (s) => s.toUpperCase()), ["A", "B"]);
    });
  });

  describe("rateLimit", () => {
    it("throttles mapper starts with an inline limit (mock timers)", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const starts: number[] = [];
      const promise = pMap(
        [1, 2, 3, 4, 5],
        (n) => {
          starts.push(Date.now());
          return n;
        },
        { rateLimit: { perInterval: 2, intervalMs: 1_000 } },
      );
      await flush();
      assert.deepEqual(starts, [0, 0]);
      t.mock.timers.tick(999);
      await flush();
      assert.deepEqual(starts, [0, 0]);
      t.mock.timers.tick(1);
      await flush();
      assert.deepEqual(starts, [0, 0, 1_000, 1_000]);
      t.mock.timers.tick(1_000);
      assert.deepEqual(await promise, [1, 2, 3, 4, 5]);
      assert.deepEqual(starts, [0, 0, 1_000, 1_000, 2_000]);
    });

    it("shares a limiter between calls and does not dispose it", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      using limiter = createRateLimiter({ perInterval: 1, intervalMs: 100 });
      const starts: string[] = [];
      const a = pMap(["a1", "a2"], (s) => starts.push(`${s}@${Date.now()}`), {
        rateLimit: limiter,
      });
      const b = pMap(["b1", "b2"], (s) => starts.push(`${s}@${Date.now()}`), {
        rateLimit: limiter,
      });
      for (let i = 0; i < 4; i++) {
        await flush();
        t.mock.timers.tick(100);
      }
      await Promise.all([a, b]);
      assert.deepEqual(starts, ["a1@0", "b1@100", "a2@200", "b2@300"]);
      assert.equal(limiter.disposed, false);
    });

    it("aborting cancels calls waiting on the limiter", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const controller = new AbortController();
      const started: number[] = [];
      const promise = pMap([1, 2, 3], (n) => started.push(n), {
        signal: controller.signal,
        rateLimit: { perInterval: 1, intervalMs: 1_000 },
      });
      await flush();
      controller.abort(new Error("stop"));
      await assert.rejects(promise, /stop/);
      t.mock.timers.tick(5_000);
      await flush();
      assert.deepEqual(started, [1]);
    });
  });
});
