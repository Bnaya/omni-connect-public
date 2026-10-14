import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exponentialBackoff, retry } from "./retry.ts";
import { flush } from "./testing.ts";

function failTimes<R>(times: number, value: R): (context: { attempt: number }) => Promise<R> {
  return async ({ attempt }) => {
    if (attempt <= times) throw new Error(`attempt ${attempt} failed`);
    return value;
  };
}

describe("retry", () => {
  it("returns the first success", async () => {
    let calls = 0;
    assert.equal(await retry(() => ++calls, { backoff: 0 }), 1);
    assert.equal(calls, 1);
  });

  it("retries until it succeeds", async () => {
    assert.equal(await retry(failTimes(2, "ok"), { retries: 2, backoff: 0 }), "ok");
  });

  it("gives up after `retries` and rethrows the last error", async () => {
    let calls = 0;
    await assert.rejects(
      retry(
        async ({ attempt }) => {
          calls++;
          throw new Error(`attempt ${attempt}`);
        },
        { retries: 2, backoff: 0 },
      ),
      /attempt 3/,
    );
    assert.equal(calls, 3);
  });

  it("retries: 0 means a single attempt", async () => {
    await assert.rejects(retry(failTimes(1, "x"), { retries: 0 }), /attempt 1 failed/);
  });

  it("waits the backoff between attempts (mock timers)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const attempts: number[] = [];
    const backoffCalls: number[] = [];
    const promise = retry(
      async ({ attempt }) => {
        attempts.push(Date.now());
        if (attempt < 4) throw new Error("again");
        return "done";
      },
      {
        retries: 5,
        backoff: (attempt) => {
          backoffCalls.push(attempt);
          return attempt * 100;
        },
      },
    );
    for (const ms of [100, 200, 300]) {
      await flush();
      t.mock.timers.tick(ms);
    }
    assert.equal(await promise, "done");
    assert.deepEqual(attempts, [0, 100, 300, 600]);
    assert.deepEqual(backoffCalls, [1, 2, 3]);
  });

  it("shouldRetry can stop early or override the delay (e.g. Retry-After)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    class HttpError extends Error {
      readonly status: number;
      constructor(status: number) {
        super(`HTTP ${status}`);
        this.status = status;
      }
    }
    const statuses = [429, 503, 404];
    const seen: Array<[number, number]> = [];
    const promise = retry(
      async ({ attempt }) => {
        seen.push([attempt, Date.now()]);
        throw new HttpError(statuses[attempt - 1]!);
      },
      {
        retries: 10,
        backoff: 50,
        shouldRetry: (error) => {
          if (!(error instanceof HttpError) || error.status === 404) return false;
          return error.status === 429 ? 5_000 : true;
        },
      },
    );
    promise.catch(() => {});
    await flush();
    t.mock.timers.tick(5_000);
    await flush();
    t.mock.timers.tick(50);
    await assert.rejects(promise, /HTTP 404/);
    assert.deepEqual(seen, [
      [1, 0],
      [2, 5_000],
      [3, 5_050],
    ]);
  });

  it("calls onRetry with the decision context", async () => {
    const calls: Array<[string, number, number, number]> = [];
    await retry(failTimes(2, 1), {
      retries: 3,
      backoff: 0,
      onRetry: (error, { attempt, retriesLeft, delayMs }) =>
        calls.push([(error as Error).message, attempt, retriesLeft, delayMs]),
    });
    assert.deepEqual(calls, [
      ["attempt 1 failed", 1, 2, 0],
      ["attempt 2 failed", 2, 1, 0],
    ]);
  });

  it("does not retry AbortErrors by default, but does retry TimeoutErrors", async () => {
    let calls = 0;
    await assert.rejects(
      retry(
        async () => {
          calls++;
          throw new DOMException("aborted", "AbortError");
        },
        { backoff: 0 },
      ),
      { name: "AbortError" },
    );
    assert.equal(calls, 1);

    let timeoutCalls = 0;
    const result = await retry(
      async () => {
        if (++timeoutCalls < 3) throw new DOMException("slow", "TimeoutError");
        return "eventually";
      },
      { backoff: 0 },
    );
    assert.equal(result, "eventually");
  });

  it("aborting during the backoff wait rejects with signal.reason", async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = retry(
      async () => {
        calls++;
        throw new Error("flaky");
      },
      { backoff: 60_000, signal: controller.signal },
    );
    await flush();
    controller.abort(new Error("shutdown"));
    await assert.rejects(promise, /shutdown/);
    assert.equal(calls, 1);
  });

  it("passes the signal to fn and stops when the attempt is aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = retry(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          calls++;
          signal.addEventListener("abort", () => reject(new Error("fetch aborted")));
        }),
      { signal: controller.signal, backoff: 0 },
    );
    await flush();
    controller.abort("user");
    await assert.rejects(promise, (reason) => reason === "user");
    assert.equal(calls, 1);
  });

  it("rejects a pre-aborted signal without calling fn", async () => {
    let calls = 0;
    await assert.rejects(
      retry(() => calls++, { signal: AbortSignal.abort("no") }),
      (r) => r === "no",
    );
    assert.equal(calls, 0);
  });

  it("validates retries", async () => {
    await assert.rejects(
      retry(() => 1, { retries: -1 }),
      TypeError,
    );
    await assert.rejects(
      retry(() => 1, { retries: 1.5 }),
      TypeError,
    );
  });
});

describe("exponentialBackoff", () => {
  it("grows by factor and caps at maxMs", () => {
    const backoff = exponentialBackoff({ initialMs: 100, factor: 3, maxMs: 1_000, jitter: false });
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((attempt) => backoff(attempt, undefined)),
      [100, 300, 900, 1_000, 1_000],
    );
  });

  it("full jitter stays within [0, delay]", () => {
    const backoff = exponentialBackoff({ initialMs: 100, maxMs: 400 });
    for (let attempt = 1; attempt < 10; attempt++) {
      const value = backoff(attempt, undefined);
      assert.ok(value >= 0 && value <= Math.min(400, 100 * 2 ** (attempt - 1)));
    }
  });
});
