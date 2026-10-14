import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ResponseCache, cacheKey } from "./cache.ts";
import { SessionFetcher } from "./fetcher.ts";
import { TransportPicker } from "./pick.ts";
import { Politeness } from "./politeness.ts";
import { RequestLog } from "./request-log.ts";
import { FakeTransport } from "./testing.ts";
import type { Transport } from "./transports.ts";

const RADWARE = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "yad2-radware-captcha.html"),
  "utf8",
);
const LOGIN_WALL = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "facebook-login-wall.html"),
  "utf8",
);
const URL_A = "https://gw.yad2.co.il/vehicles-feed/cars";
const JSON_OK = '{"data":{"ads":[{"token":"a"}]}}';

function fetcher(
  transports: Transport[],
  opts: { cache?: ResponseCache; politeness?: Politeness } = {},
): SessionFetcher {
  const politeness =
    opts.politeness ?? new Politeness({ defaults: { perInterval: 100, intervalMs: 1 } });
  return new SessionFetcher({
    picker: new TransportPicker({ transports }),
    politeness,
    ownsPoliteness: true,
    cache: opts.cache ?? new ResponseCache(null, 0),
    requestLog: new RequestLog(null, { session: "yad2-anon" }),
    log: () => {},
  });
}

describe("SessionFetcher", () => {
  it("serves a cache hit without touching the network", async () => {
    const cache = new ResponseCache(null, 60_000);
    // A null-dir cache cannot store, so prove the fast path with a stub instead.
    const key = cacheKey({ url: URL_A });
    const stub = {
      get: () => ({
        key,
        savedAt: new Date().toISOString(),
        status: 200,
        url: URL_A,
        headers: {},
        body: JSON_OK,
        transport: "in-page" as const,
      }),
      set: () => undefined,
      saveChallenge: () => undefined,
    } as unknown as ResponseCache;
    const node = new FakeTransport("node", 1, [{ status: 200, body: JSON_OK }]);
    using f = fetcher([node], { cache: stub });
    const out = await f.fetch({ url: URL_A, accept: "json" });
    assert.equal(out.status, "ok");
    assert.equal(out.status === "ok" && out.fromCache, true);
    assert.equal(node.calls, 0);
    assert.equal(f.stats.cacheHits, 1);
    assert.equal(f.requestLog.recent()[0]?.transport, "cache");
    void cache;
  });

  it("retries a transient challenge exactly once, then succeeds", async () => {
    // 429 with Retry-After: 0 so the single wait costs nothing in a test.
    const node = new FakeTransport("node", 1, [
      { status: 429, body: "slow down", headers: { "retry-after": "0" } },
      { status: 200, body: JSON_OK },
    ]);
    using f = fetcher([node]);
    const out = await f.fetch({ url: URL_A, accept: "json" });
    assert.equal(out.status, "ok");
    assert.equal(node.calls, 2);
    assert.equal(f.stats.retries, 1);
  });

  it("gives up after that one retry — never a loop", async () => {
    const node = new FakeTransport("node", 1, [
      { status: 429, body: "slow down", headers: { "retry-after": "0" } },
      { status: 429, body: "slow down", headers: { "retry-after": "0" } },
      { status: 200, body: JSON_OK },
    ]);
    using f = fetcher([node]);
    const out = await f.fetch({ url: URL_A, accept: "json" });
    assert.equal(out.status, "error");
    assert.equal(out.status === "error" && out.code, "rate_limited");
    assert.equal(out.status === "error" && out.retryable, true);
    assert.equal(node.calls, 2, "two attempts total, not three");
  });

  it("turns a CAPTCHA into a ready-to-return needs_human result and strikes the host", async () => {
    const politeness = new Politeness({
      defaults: { perInterval: 100, intervalMs: 1, strikesToBackoff: 2 },
    });
    const node = new FakeTransport("node", 1, [{ status: 200, body: RADWARE }]);
    using f = fetcher([node], { politeness });
    const out = await f.fetch({ url: URL_A, accept: "json", goal: "search cars for the owner" });
    assert.equal(out.status, "needs_human");
    if (out.status !== "needs_human") throw new Error("unreachable");
    assert.equal(out.challenge.kind, "radware_captcha");
    assert.equal(out.result.status, "needs_human");
    assert.equal(out.result.handoff.kind, "captcha");
    assert.match(out.result.handoff.message, /search cars for the owner/);
    assert.equal(politeness.state("gw.yad2.co.il").strikes, 1);
    assert.equal(f.stats.handoffs, 1);
    assert.equal(f.requestLog.recent()[0]?.challenge, "radware_captcha");
  });

  it("reports a stale session as needs_human login when we expected to be logged in", async () => {
    const node = new FakeTransport("node", 1, [{ status: 200, body: LOGIN_WALL }]);
    using f = fetcher([node]);
    const out = await f.fetch({
      url: "https://www.facebook.com/marketplace/",
      expect: "authenticated",
    });
    assert.equal(out.status, "needs_human");
    if (out.status !== "needs_human") throw new Error("unreachable");
    assert.equal(out.challenge.kind, "session_expired");
    assert.equal(out.result.handoff.kind, "login");
  });

  it("stops before the request when the budget is spent, and says when it resets", async () => {
    const politeness = new Politeness({
      defaults: { perInterval: 100, intervalMs: 1, dailyCap: 1 },
    });
    const node = new FakeTransport("node", 1, [
      { status: 200, body: JSON_OK },
      { status: 200, body: JSON_OK },
    ]);
    using f = fetcher([node], { politeness });
    assert.equal((await f.fetch({ url: URL_A, accept: "json" })).status, "ok");
    const out = await f.fetch({ url: `${URL_A}?page=2`, accept: "json" });
    assert.equal(out.status, "error");
    assert.equal(out.status === "error" && out.code, "daily_cap");
    assert.equal(node.calls, 1, "the second request never left the house");
  });

  it("clears a back-off after a good answer", async () => {
    const politeness = new Politeness({
      defaults: { perInterval: 100, intervalMs: 1, strikesToBackoff: 5 },
    });
    politeness.strike(URL_A, "radware_captcha");
    const node = new FakeTransport("node", 1, [{ status: 200, body: JSON_OK }]);
    using f = fetcher([node], { politeness });
    await f.fetch({ url: URL_A, accept: "json" });
    assert.equal(politeness.state("gw.yad2.co.il").strikes, 0);
  });

  it("json() parses for you", async () => {
    const node = new FakeTransport("node", 1, [{ status: 200, body: JSON_OK }]);
    using f = fetcher([node]);
    const out = await f.json<{ data: { ads: { token: string }[] } }>({ url: URL_A });
    assert.equal(out.status, "ok");
    assert.equal(out.data?.data.ads[0]?.token, "a");
  });
});
