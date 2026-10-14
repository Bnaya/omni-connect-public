import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BudgetExceededError, Politeness } from "./politeness.ts";

const tmpDirs: string[] = [];
function tmpFile(name = "budget.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "omni-polite-"));
  tmpDirs.push(dir);
  return join(dir, name);
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const YAD2 = "https://gw.yad2.co.il/vehicles-feed/cars";
const FB = "https://www.facebook.com/marketplace/";

describe("Politeness — spacing", () => {
  it("spaces requests to one host without delaying another", async () => {
    using politeness = new Politeness({
      defaults: { perInterval: 1, intervalMs: 80 },
    });
    const started = Date.now();
    await politeness.acquire(YAD2);
    await politeness.acquire(FB); // different host, no wait
    assert.ok(Date.now() - started < 60, "hosts have their own windows");
    await politeness.acquire(YAD2);
    assert.ok(Date.now() - started >= 70, `second yad2 call waited (${Date.now() - started} ms)`);
  });

  it("respects a per-host override", () => {
    using politeness = new Politeness({
      defaults: { perInterval: 1, intervalMs: 5_000, dailyCap: 200 },
      hosts: { "gw.yad2.co.il": { intervalMs: 10_000, dailyCap: 40 } },
    });
    assert.equal(politeness.policy("gw.yad2.co.il").intervalMs, 10_000);
    assert.equal(politeness.policy("gw.yad2.co.il").dailyCap, 40);
    assert.equal(politeness.policy("www.facebook.com").intervalMs, 5_000);
  });

  it("rejects an acquire whose signal is aborted", async () => {
    using politeness = new Politeness({ defaults: { perInterval: 1, intervalMs: 10_000 } });
    await politeness.acquire(YAD2);
    const controller = new AbortController();
    const pending = politeness.acquire(YAD2, { signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await assert.rejects(pending, /caller gave up/);
  });
});

describe("Politeness — budgets", () => {
  it("enforces a daily cap and says when it resets", async () => {
    using politeness = new Politeness({
      defaults: { perInterval: 10, intervalMs: 1, dailyCap: 2 },
    });
    await politeness.acquire(YAD2);
    await politeness.acquire(YAD2);
    await assert.rejects(politeness.acquire(YAD2), (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "daily_cap");
      assert.equal(err.host, "gw.yad2.co.il");
      assert.match(err.message, /Daily cap of 2/);
      return true;
    });
    // Another host still has its own budget.
    await politeness.acquire(FB);
  });

  it("rolls the counter over at midnight UTC", async () => {
    let now = new Date("2026-10-07T23:59:00Z");
    using politeness = new Politeness({
      defaults: { perInterval: 10, intervalMs: 1, dailyCap: 1 },
      now: () => now,
    });
    await politeness.acquire(YAD2);
    await assert.rejects(politeness.acquire(YAD2), BudgetExceededError);
    now = new Date("2026-10-08T00:01:00Z");
    await politeness.acquire(YAD2);
    assert.equal(politeness.state("gw.yad2.co.il").requests, 1);
  });

  it("backs off after repeated strikes, and a success clears them", async () => {
    let now = new Date("2026-10-07T10:00:00Z");
    using politeness = new Politeness({
      defaults: { perInterval: 10, intervalMs: 1, strikesToBackoff: 2, backoffMs: 3_600_000 },
      now: () => now,
    });
    assert.equal(politeness.strike(YAD2, "radware_captcha"), false);
    assert.equal(
      politeness.strike(YAD2, "radware_captcha"),
      true,
      "second strike starts the back-off",
    );
    await assert.rejects(politeness.acquire(YAD2), (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "backoff");
      assert.match(err.message, /radware_captcha/);
      return true;
    });

    now = new Date("2026-10-07T11:01:00Z"); // the back-off expired
    await politeness.acquire(YAD2);
    politeness.success(YAD2);
    assert.equal(politeness.state("gw.yad2.co.il").strikes, 0);
    assert.equal(politeness.state("gw.yad2.co.il").backoffUntil, null);
  });

  it("shares the budget between processes through the state file", async () => {
    const file = tmpFile();
    {
      using first = new Politeness({
        file,
        defaults: { perInterval: 10, intervalMs: 1, dailyCap: 3 },
      });
      await first.acquire(YAD2);
      await first.acquire(YAD2);
    }
    assert.match(readFileSync(file, "utf8"), /"requests": 2/);
    using second = new Politeness({
      file,
      defaults: { perInterval: 10, intervalMs: 1, dailyCap: 3 },
    });
    assert.equal(second.state("gw.yad2.co.il").requests, 2);
    await second.acquire(YAD2);
    await assert.rejects(second.acquire(YAD2), BudgetExceededError);
  });

  it("lets a human resume after a back-off", () => {
    using politeness = new Politeness({ defaults: { strikesToBackoff: 1 } });
    politeness.strike(FB, "login_wall");
    assert.notEqual(politeness.state("www.facebook.com").backoffUntil, null);
    politeness.resume(FB);
    assert.equal(politeness.state("www.facebook.com").backoffUntil, null);
  });
});
