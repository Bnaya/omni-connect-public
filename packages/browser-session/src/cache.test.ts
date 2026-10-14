import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ResponseCache, cacheKey } from "./cache.ts";
import { RequestLog } from "./request-log.ts";
import type { TransportResponse } from "./transports.ts";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omni-cache-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const response = (body: string): TransportResponse => ({
  status: 200,
  url: "https://gw.yad2.co.il/feed",
  headers: { "content-type": "application/json" },
  body,
  transport: "in-page",
});

describe("ResponseCache", () => {
  it("round-trips a response", () => {
    const cache = new ResponseCache(tmp(), 60_000);
    const key = cacheKey({ url: "https://gw.yad2.co.il/feed" });
    assert.equal(cache.get(key), undefined);
    cache.set(key, response('{"ok":true}'));
    const hit = cache.get(key);
    assert.equal(hit?.body, '{"ok":true}');
    assert.equal(hit?.transport, "in-page");
  });

  it("keys on method and body, not just the URL", () => {
    const cache = new ResponseCache(tmp(), 60_000);
    const get = cacheKey({ url: "https://x/api" });
    const post = cacheKey({ url: "https://x/api", method: "POST", body: "a=1" });
    assert.notEqual(get, post);
    cache.set(get, response("one"));
    assert.equal(cache.get(post), undefined);
  });

  it("expires entries by TTL", () => {
    let now = new Date("2026-10-07T10:00:00Z");
    const cache = new ResponseCache(tmp(), 60_000, () => now);
    const key = cacheKey({ url: "https://x/api" });
    cache.set(key, response("fresh"));
    now = new Date("2026-10-07T10:00:59Z");
    assert.equal(cache.get(key)?.body, "fresh");
    now = new Date("2026-10-07T10:01:30Z");
    assert.equal(cache.get(key), undefined);
  });

  it("is a no-op with a null directory (tests, --no-cache)", () => {
    const cache = new ResponseCache(null, 60_000);
    const key = cacheKey({ url: "https://x/api" });
    assert.equal(cache.set(key, response("x")), undefined);
    assert.equal(cache.get(key), undefined);
  });

  it("keeps challenge pages apart from answers", () => {
    const dir = tmp();
    const cache = new ResponseCache(dir, 60_000);
    const key = cacheKey({ url: "https://gw.yad2.co.il/feed" });
    const file = cache.saveChallenge(key, "<html>Are you for real</html>", "radware_captcha");
    assert.ok(file && existsSync(file));
    assert.match(readFileSync(file, "utf8"), /Are you for real/);
    // It must never come back as a cached answer.
    assert.equal(cache.get(key), undefined);
    assert.deepEqual(readdirSync(dir), ["blocked"]);
  });
});

describe("RequestLog", () => {
  it("appends JSONL and reads it back, with no bodies or cookies in it", () => {
    const file = join(tmp(), "requests.jsonl");
    const log = new RequestLog(file, { session: "yad2-anon" });
    log.append({
      host: "gw.yad2.co.il",
      method: "GET",
      url: "https://gw.yad2.co.il/feed",
      transport: "in-page",
      status: 200,
      verdict: "ok",
      ms: 812,
    });
    log.append({
      host: "gw.yad2.co.il",
      method: "GET",
      url: "https://gw.yad2.co.il/feed?page=2",
      transport: "node",
      status: 200,
      verdict: "needs_human",
      challenge: "radware_captcha",
      ms: 120,
    });
    const entries = log.readAll();
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.session, "yad2-anon");
    assert.equal(entries[1]?.challenge, "radware_captcha");
    assert.equal(log.recent().length, 2);
    const raw = readFileSync(file, "utf8");
    assert.ok(!/cookie|set-cookie|body/i.test(raw), "the log carries no bodies or cookies");
  });

  it("works without a file", () => {
    const log = new RequestLog(null);
    log.append({
      host: "x",
      method: "GET",
      url: "https://x",
      transport: "node",
      status: 200,
      verdict: "ok",
      ms: 1,
    });
    assert.equal(log.readAll().length, 1);
  });
});
