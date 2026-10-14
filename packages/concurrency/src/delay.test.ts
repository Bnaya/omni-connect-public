import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { delay } from "./delay.ts";
import { flush } from "./testing.ts";

describe("delay", () => {
  it("resolves after the given time", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let done = false;
    const promise = delay(100).then(() => (done = true));
    t.mock.timers.tick(99);
    await flush();
    assert.equal(done, false);
    t.mock.timers.tick(1);
    await promise;
    assert.equal(done, true);
  });

  it("rejects with signal.reason on abort", async () => {
    const controller = new AbortController();
    const promise = delay(10_000, { signal: controller.signal });
    const reason = new Error("stop waiting");
    controller.abort(reason);
    await assert.rejects(promise, reason);
  });

  it("rejects immediately with a pre-aborted signal", async () => {
    await assert.rejects(
      delay(10, { signal: AbortSignal.abort("already") }),
      (r) => r === "already",
    );
  });

  it("rejects invalid durations", async () => {
    await assert.rejects(delay(-1), TypeError);
    await assert.rejects(delay(Number.NaN), TypeError);
  });
});
