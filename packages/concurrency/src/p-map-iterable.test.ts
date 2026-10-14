import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { delay } from "./delay.ts";
import { pMapSkip } from "./p-map.ts";
import { pMapIterable } from "./p-map-iterable.ts";
import { concurrencyProbe, deferred, flush, sleep, trackedAsyncSource } from "./testing.ts";

function* naturals(onClose?: () => void): Generator<number> {
  try {
    for (let i = 0; ; i++) yield i;
  } finally {
    onClose?.();
  }
}

describe("pMapIterable", () => {
  it("yields results in input order", async () => {
    const delays = [20, 1, 10, 5];
    const result = await Array.fromAsync(
      pMapIterable(
        delays,
        async (ms) => {
          await sleep(ms);
          return ms;
        },
        { concurrency: 2 },
      ),
    );
    assert.deepEqual(result, [20, 1, 10, 5]);
  });

  it("yields the head as soon as it is ready, before slower later items finish", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const iterator = pMapIterable([0, 1, 2], async (i) => {
      await gates[i]!.promise;
      return i;
    });
    const first = iterator.next();
    gates[0]!.resolve();
    assert.deepEqual(await first, { done: false, value: 0 });
    gates[2]!.resolve();
    const second = iterator.next();
    await flush();
    gates[1]!.resolve();
    assert.deepEqual(await second, { done: false, value: 1 });
    assert.deepEqual(await iterator.next(), { done: false, value: 2 });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  });

  it("respects concurrency", async () => {
    const probe = concurrencyProbe();
    const result = await Array.fromAsync(
      pMapIterable(
        Array.from({ length: 15 }, (_, i) => i),
        async (i) => {
          probe.enter();
          await sleep(i % 4);
          probe.leave();
          return i;
        },
        { concurrency: 3 },
      ),
    );
    assert.equal(probe.max, 3);
    assert.equal(result.length, 15);
  });

  it("applies backpressure: never runs more than `backpressure` ahead of the consumer", async () => {
    let started = 0;
    const iterator = pMapIterable(
      naturals(),
      async (i) => {
        started++;
        return i;
      },
      { concurrency: 2, backpressure: 4 },
    );
    assert.deepEqual(await iterator.next(), { done: false, value: 0 });
    await flush(20);
    // 1 consumed + 4 buffered.
    assert.equal(started, 5);
    assert.deepEqual(await iterator.next(), { done: false, value: 1 });
    await flush(20);
    assert.equal(started, 6);
    await iterator.return();
  });

  it("defaults backpressure to concurrency", async () => {
    let started = 0;
    const iterator = pMapIterable(
      naturals(),
      (i) => {
        started++;
        return i;
      },
      { concurrency: 3 },
    );
    await iterator.next();
    await flush(20);
    assert.equal(started, 4);
    await iterator.return();
  });

  it("drops pMapSkip results", async () => {
    const result = await Array.fromAsync(
      pMapIterable([1, 2, 3, 4, 5], (n) => (n % 2 ? n : pMapSkip), { concurrency: 2 }),
    );
    assert.deepEqual(result, [1, 3, 5]);
  });

  it("skipped items do not stall backpressure", async () => {
    const result = await Array.fromAsync(
      pMapIterable(
        Array.from({ length: 20 }, (_, i) => i),
        async (n) => {
          await sleep(n % 3);
          return n < 18 ? pMapSkip : n;
        },
        { concurrency: 2, backpressure: 2 },
      ),
    );
    assert.deepEqual(result, [18, 19]);
  });

  it("yields earlier results, then throws the error in order, and closes the source", async () => {
    let closed = false;
    const seen: number[] = [];
    const error = new Error("item 3 failed");
    await assert.rejects(async () => {
      for await (const value of pMapIterable(
        naturals(() => (closed = true)),
        async (i) => {
          await sleep(i === 3 ? 0 : 3);
          if (i === 3) throw error;
          return i;
        },
        { concurrency: 4 },
      )) {
        seen.push(value);
      }
    }, error);
    assert.deepEqual(seen, [0, 1, 2]);
    assert.equal(closed, true);
  });

  it("an iterator that throws surfaces the error", async () => {
    async function* source() {
      yield 1;
      throw new Error("source broke");
    }
    await assert.rejects(Array.fromAsync(pMapIterable(source(), (x) => x)), /source broke/);
  });

  it("cleans up on early break: aborts in-flight mappers and closes the source", async () => {
    let closed = false;
    const aborted: Array<[number, string]> = [];
    for await (const value of pMapIterable(
      naturals(() => (closed = true)),
      async (i, _index, { signal }) => {
        try {
          await delay(i === 0 ? 0 : 50, { signal });
        } catch (error) {
          aborted.push([i, (error as Error).name]);
        }
        return i;
      },
      { concurrency: 3 },
    )) {
      assert.equal(value, 0);
      break;
    }
    assert.equal(closed, true);
    // Item 0 was consumed; its slot was refilled, so items 1-3 were in flight.
    assert.deepEqual(aborted, [
      [1, "AbortError"],
      [2, "AbortError"],
      [3, "AbortError"],
    ]);
  });

  it("works with `await using`", async () => {
    let closed = false;
    {
      await using iterator = pMapIterable(
        naturals(() => (closed = true)),
        (i) => i * 2,
      );
      assert.deepEqual(await iterator.next(), { done: false, value: 0 });
    }
    assert.equal(closed, true);
  });

  it("pulls async iterable input one element at a time and closes it on break", async () => {
    const source = trackedAsyncSource(1_000);
    for await (const value of pMapIterable(
      source,
      async (n) => {
        await sleep(1);
        return n;
      },
      { concurrency: 4 },
    )) {
      if (value === 10) break;
    }
    assert.equal(source.maxConcurrentNext, 1);
    assert.equal(source.returned, true);
    assert.ok(source.pulled <= 16, `pulled ${source.pulled}`);
  });

  describe("AbortSignal", () => {
    it("aborting while waiting rejects next() with signal.reason and cleans up", async () => {
      const controller = new AbortController();
      let closed = false;
      const mapperReasons: unknown[] = [];
      const iterator = pMapIterable(
        naturals(() => (closed = true)),
        async (i, _index, { signal }) => {
          try {
            await delay(1_000, { signal });
          } catch (error) {
            mapperReasons.push(error);
            throw error;
          }
          return i;
        },
        { concurrency: 2, signal: controller.signal },
      );
      const pending = iterator.next();
      await flush();
      const reason = new Error("cancel");
      controller.abort(reason);
      await assert.rejects(pending, reason);
      assert.equal(closed, true);
      await flush();
      assert.deepEqual(mapperReasons, [reason, reason]);
      assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    });

    it("a pre-aborted signal rejects the first next() and closes the source", async () => {
      const source = trackedAsyncSource(3);
      const iterator = pMapIterable(source, (x) => x, { signal: AbortSignal.abort("nope") });
      await assert.rejects(iterator.next(), (reason) => reason === "nope");
      assert.equal(source.pulled, 0);
      await flush();
      assert.equal(source.returned, true);
    });
  });

  it("validates arguments synchronously", () => {
    assert.throws(() => pMapIterable([1], (x) => x, { concurrency: 0 }), TypeError);
    assert.throws(
      () => pMapIterable([1], (x) => x, { concurrency: 4, backpressure: 2 }),
      TypeError,
    );
    assert.throws(() => pMapIterable([1], (x) => x, { backpressure: 1.5 }), TypeError);
    assert.throws(() => pMapIterable({} as unknown as number[], (x) => x), TypeError);
    assert.throws(() => pMapIterable([1], undefined as unknown as () => number), TypeError);
    assert.throws(
      () => pMapIterable([1], (x) => x, { rateLimit: { perInterval: 1, intervalMs: -5 } }),
      TypeError,
    );
    // Infinity backpressure with bounded concurrency is fine.
    pMapIterable([1], (x) => x, { concurrency: 2, backpressure: Number.POSITIVE_INFINITY });
  });

  it("throttles with rateLimit (mock timers)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const starts: number[] = [];
    const iterator = pMapIterable(
      [1, 2, 3],
      (n) => {
        starts.push(Date.now());
        return n;
      },
      { rateLimit: { perInterval: 1, intervalMs: 500 } },
    );
    const collected = Array.fromAsync(iterator);
    for (let i = 0; i < 3; i++) {
      await flush();
      t.mock.timers.tick(500);
    }
    assert.deepEqual(await collected, [1, 2, 3]);
    assert.deepEqual(starts, [0, 500, 1_000]);
  });
});
