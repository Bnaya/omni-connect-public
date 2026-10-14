import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectChallenge } from "./challenge.ts";
import { formatHandoff, prepareHandoff, tailscaleHint } from "./handoff.ts";
import {
  assertSessionName,
  hostOf,
  isRotatingProfileDir,
  rotatingProfileDir,
  siteOf,
} from "./paths.ts";
import type { BrowserSession } from "./session.ts";

function fakeSession(): BrowserSession {
  return {
    name: "yad2-anon",
    async screenshot(hint: string) {
      return `/repo/.local/screenshots/yad2-anon/${hint}.png`;
    },
    async currentUrl() {
      return "https://www.yad2.co.il/vehicles/cars";
    },
  } as unknown as BrowserSession;
}

describe("prepareHandoff", () => {
  it("freezes, screenshots and points the human at the live browser", async () => {
    const verdict = detectChallenge({
      status: 403,
      body: "<html>Access Denied\nReference #18.abc123</html>",
    });
    assert.notEqual(verdict.kind, "ok");
    if (verdict.kind === "ok") throw new Error("unreachable");
    const handoff = await prepareHandoff(verdict.challenge, {
      session: fakeSession(),
      viewer: { url: "http://localhost:9400" },
      goal: "track a parcel",
    });
    assert.equal(handoff.screenshotPath, "/repo/.local/screenshots/yad2-anon/akamai_denied.png");
    assert.equal(handoff.pageUrl, "https://www.yad2.co.il/vehicles/cars");
    assert.equal(handoff.liveSessionUrl, "http://localhost:9400");
    assert.match(handoff.message, /track a parcel/);

    const text = formatHandoff(handoff, { site: "israel-post", session: "israelpost" });
    assert.match(text, /^HANDOFF israel-post \/ session israelpost$/m);
    assert.match(text, /Live view: http:\/\/localhost:9400/);
    assert.match(text, /the session stays open/);
  });

  it("prints the ssh tunnel for a loopback viewer, and a warning for a tailnet-bound one", () => {
    const loopback = tailscaleHint(9400, { machine: "mac-mini" });
    assert.match(loopback, /ssh -N -L 9400:localhost:9400 <user>@mac-mini/);
    assert.match(loopback, /mosh does not forward ports/);
    const tailnet = tailscaleHint(9400, { host: "100.64.0.1", machine: "mac-mini" });
    assert.match(tailnet, /NO authentication/);
  });
});

describe("paths", () => {
  it("treats subdomains of one site as the same site", () => {
    assert.equal(siteOf("gw.yad2.co.il"), "yad2.co.il");
    assert.equal(siteOf("www.yad2.co.il"), "yad2.co.il");
    assert.equal(siteOf("mypost.israelpost.co.il"), "israelpost.co.il");
    assert.equal(siteOf("www.facebook.com"), "facebook.com");
    assert.equal(siteOf("example.com"), "example.com");
    assert.equal(hostOf("https://gw.yad2.co.il/x?y=1"), "gw.yad2.co.il");
    assert.equal(hostOf("not a url"), "");
  });

  it("refuses a session name that would escape .local/", () => {
    assert.throws(() => assertSessionName("../../etc"), /Invalid session name/);
    assert.throws(() => assertSessionName("a/b"), /Invalid session name/);
    assertSessionName("yad2-anon");
  });

  it("marks rotating profile dirs so only they are ever deleted", () => {
    const dir = rotatingProfileDir("israelpost", { root: "/repo" });
    assert.ok(isRotatingProfileDir(dir), dir);
    assert.equal(isRotatingProfileDir("/repo/.local/profiles/israelpost"), false);
  });
});
