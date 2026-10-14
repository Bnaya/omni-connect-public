import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  challengeToHandoff,
  challengeToResult,
  detectChallenge,
  extractReference,
  isSessionStale,
  parseRetryAfter,
} from "./challenge.ts";
import type { Challenge, Verdict } from "./challenge.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

function challengeOf(verdict: Verdict): Challenge {
  assert.notEqual(verdict.kind, "ok", "expected a challenge");
  if (verdict.kind === "ok") throw new Error("unreachable");
  return verdict.challenge;
}

describe("detectChallenge — saved vendor pages", () => {
  it("reads the real Yad2 Radware/ShieldSquare captcha page as needs_human", () => {
    // The genuine article: HTTP **200** with a captcha page in the body.
    const verdict = detectChallenge({
      status: 200,
      body: fixture("yad2-radware-captcha.html"),
      url: "https://gw.yad2.co.il/vehicles-feed/cars?manufacturer=27",
    });
    assert.equal(verdict.kind, "needs_human");
    const c = challengeOf(verdict);
    assert.equal(c.kind, "radware_captcha");
    assert.equal(c.handoffKind, "captcha");
    assert.match(
      verdict.kind === "needs_human" ? (verdict.challenge.reference ?? "") : "",
      /^radware-/,
    );
  });

  it("separates Radware's silent JS check (transient) from its captcha (needs_human)", () => {
    const verdict = detectChallenge({ status: 200, body: fixture("radware-jscheck.html") });
    assert.equal(verdict.kind, "transient");
    const c = challengeOf(verdict);
    assert.equal(c.kind, "radware_jscheck");
    assert.ok(verdict.kind === "transient" && (verdict.challenge.retryAfterMs ?? 0) > 0);
  });

  it("reads a Cloudflare interstitial as transient and a 1020 block as needs_human", () => {
    const interstitial = detectChallenge({
      status: 403,
      body: fixture("cloudflare-interstitial.html"),
    });
    assert.equal(interstitial.kind, "transient");
    assert.equal(challengeOf(interstitial).kind, "cloudflare_interstitial");

    const blocked = detectChallenge({ status: 403, body: fixture("cloudflare-blocked.html") });
    assert.equal(blocked.kind, "needs_human");
    assert.equal(challengeOf(blocked).kind, "cloudflare_blocked");
    // Not a CAPTCHA: no human can "solve" an IP block, so it is a question, not a captcha prompt.
    assert.equal(challengeOf(blocked).handoffKind, "question");
  });

  it("reads Akamai's Access Denied page and keeps its reference", () => {
    const verdict = detectChallenge({ status: 403, body: fixture("akamai-access-denied.html") });
    assert.equal(verdict.kind, "needs_human");
    assert.equal(challengeOf(verdict).kind, "akamai_denied");
    assert.match(
      verdict.kind === "needs_human" ? (verdict.challenge.reference ?? "") : "",
      /^akamai-ref:18\./,
    );
  });

  it("reads a Facebook login wall as login_wall when anonymous", () => {
    const verdict = detectChallenge({ status: 200, body: fixture("facebook-login-wall.html") });
    assert.equal(verdict.kind, "needs_human");
    assert.equal(challengeOf(verdict).kind, "login_wall");
    assert.equal(challengeOf(verdict).handoffKind, "login");
    assert.equal(isSessionStale(verdict), true);
  });

  it("reads the SAME login wall as a stale session when we expected to be logged in", () => {
    const verdict = detectChallenge({
      status: 200,
      body: fixture("facebook-login-wall.html"),
      expect: "authenticated",
    });
    assert.equal(challengeOf(verdict).kind, "session_expired");
    assert.match(challengeOf(verdict).message, /stale|log in again/i);
  });

  it("reads AliExpress-style silent cookie expiry out of a 200 JSON body", () => {
    const verdict = detectChallenge({
      status: 200,
      body: fixture("aliexpress-session-expired.json"),
      expect: "json",
    });
    assert.equal(verdict.kind, "needs_human");
    assert.equal(challengeOf(verdict).kind, "session_expired");
    assert.equal(challengeOf(verdict).evidence, "FAIL_SYS_SESSION_EXPIRED");
  });

  it("treats a real JSON answer as ok", () => {
    const verdict = detectChallenge({
      status: 200,
      body: fixture("gateway-ok.json"),
      expect: "json",
    });
    assert.equal(verdict.kind, "ok");
  });
});

describe("detectChallenge — rules", () => {
  it("does not cry wolf over a JSON body that merely mentions a vendor", () => {
    const body = JSON.stringify({ data: [{ title: "Radware engineer, Are you for real" }] });
    assert.equal(detectChallenge({ status: 200, body, expect: "json" }).kind, "ok");
  });

  it("maps 429 to a transient rate limit, honouring Retry-After", () => {
    const verdict = detectChallenge({
      status: 429,
      body: "too many requests",
      headers: { "Retry-After": "30" },
    });
    assert.equal(verdict.kind, "transient");
    assert.equal(challengeOf(verdict).kind, "rate_limited");
    assert.equal(verdict.kind === "transient" ? verdict.challenge.retryAfterMs : 0, 30_000);
  });

  it("maps a bare 403 to needs_human, because it is usually the egress IP", () => {
    const verdict = detectChallenge({ status: 403, body: "<html><body>Forbidden</body></html>" });
    assert.equal(verdict.kind, "needs_human");
    assert.equal(challengeOf(verdict).kind, "forbidden");
  });

  it("maps 5xx and a dead transport to transient", () => {
    assert.equal(detectChallenge({ status: 503, body: "<h1>503</h1>" }).kind, "transient");
    assert.equal(
      detectChallenge({ status: 0, body: "in-page fetch failed: TypeError" }).kind,
      "transient",
    );
    assert.equal(challengeOf(detectChallenge({ status: 0, body: "" })).kind, "transport_error");
  });

  it("treats 401 as a stale session whatever the body is", () => {
    assert.equal(
      challengeOf(detectChallenge({ status: 401, body: '{"error":"nope"}' })).kind,
      "session_expired",
    );
    assert.equal(
      challengeOf(detectChallenge({ status: 401, body: "nope" })).kind,
      "session_expired",
    );
  });

  it("notices a redirect to a login page", () => {
    const verdict = detectChallenge({
      status: 302,
      body: "",
      url: "https://www.facebook.com/marketplace/",
      headers: { location: "https://www.facebook.com/login/?next=%2Fmarketplace" },
    });
    assert.equal(challengeOf(verdict).kind, "login_wall");
  });

  it("flags a non-JSON answer when JSON was expected, without claiming to know the vendor", () => {
    const verdict = detectChallenge({ status: 200, body: "<html>surprise</html>", expect: "json" });
    assert.equal(verdict.kind, "transient");
    assert.equal(challengeOf(verdict).kind, "transport_error");
  });

  it("parses Retry-After as seconds or as an HTTP date", () => {
    assert.equal(parseRetryAfter({ "retry-after": "12" }), 12_000);
    const at = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter({ "retry-after": at }) ?? 0;
    assert.ok(ms > 50_000 && ms <= 61_000, `got ${ms}`);
    assert.equal(parseRetryAfter({}), undefined);
    assert.equal(parseRetryAfter(new Headers({ "retry-after": "5" })), 5_000);
  });

  it("extracts the vendor reference a human would have to quote", () => {
    assert.equal(
      extractReference("<h2>Transaction ID: 9f8e7d6c5b4a3210aabb</h2>"),
      "radware-tx:9f8e7d6c5b4a3210aabb",
    );
    assert.equal(
      extractReference("", new Headers({ "cf-ray": "8f1a2b3c4d5e6f70" })),
      "cf-ray:8f1a2b3c4d5e6f70",
    );
    assert.equal(extractReference("nothing here"), undefined);
  });
});

describe("challenge → core handoff", () => {
  it("fills core's Handoff with everything guide §9 asks for", () => {
    const verdict = detectChallenge({ status: 200, body: fixture("yad2-radware-captcha.html") });
    const challenge = verdict.kind === "ok" ? undefined : verdict.challenge;
    assert.ok(challenge);
    const handoff = challengeToHandoff(challenge, {
      goal: "search cars on yad2",
      screenshotPath: "/x/.local/screenshots/yad2-captcha.png",
      liveSessionUrl: "http://localhost:9400",
      pageUrl: "https://www.yad2.co.il/vehicles/cars",
      session: "yad2-anon",
    });
    assert.equal(handoff.kind, "captcha");
    assert.match(handoff.message, /search cars on yad2/);
    assert.match(handoff.bestGuess ?? "", /radware_captcha/);
    assert.match(handoff.bestGuess ?? "", /yad2-anon/);
    assert.equal(handoff.screenshotPath, "/x/.local/screenshots/yad2-captcha.png");
    assert.equal(handoff.liveSessionUrl, "http://localhost:9400");

    const result = challengeToResult(challenge, { session: "yad2-anon" });
    assert.equal(result.status, "needs_human");
    assert.equal(result.handoff.kind, "captcha");
  });
});
