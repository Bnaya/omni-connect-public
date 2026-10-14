import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { TransportPicker } from "./pick.ts";
import { FakeTransport } from "./testing.ts";

const RADWARE = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "yad2-radware-captcha.html"),
  "utf8",
);
const LOGIN_WALL = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "facebook-login-wall.html"),
  "utf8",
);
const JSON_OK = '{"data":{"ads":[]}}';
const URL_A = "https://gw.yad2.co.il/vehicles-feed/cars";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omni-pick-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("TransportPicker", () => {
  it("uses the cheapest transport that works and never wakes the expensive one", async () => {
    const node = new FakeTransport("node", 1, [{ status: 200, body: JSON_OK }]);
    const inPage = new FakeTransport("in-page", 3, [{ status: 200, body: JSON_OK }]);
    const picker = new TransportPicker({ transports: [inPage, node] });

    const out = await picker.fetch({ url: URL_A, accept: "json" });
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.response.transport, "node");
    assert.equal(inPage.calls, 0);
  });

  it("climbs the ladder when the cheap one is challenged, and remembers what worked", async () => {
    const node = new FakeTransport("node", 1, [{ status: 200, body: RADWARE }]);
    const inPage = new FakeTransport("in-page", 3, [{ status: 200, body: JSON_OK }]);
    const picker = new TransportPicker({ transports: [node, inPage] });

    const out = await picker.fetch({ url: URL_A, accept: "json" });
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.response.transport, "in-page");
    assert.equal(out.attempts.length, 2);
    assert.equal(out.attempts[0]?.challenge?.kind, "radware_captcha");
    assert.equal(picker.preferred("gw.yad2.co.il"), "in-page");

    // Next call for that host starts with the browser — the discovery is paid for once.
    const node2 = new FakeTransport("node", 1, [{ status: 200, body: RADWARE }]);
    const inPage2 = new FakeTransport("in-page", 3, [{ status: 200, body: JSON_OK }]);
    const picker2 = new TransportPicker({ transports: [node2, inPage2] });
    picker2.order("gw.yad2.co.il"); // no memory yet in this instance
    assert.equal(picker2.preferred("gw.yad2.co.il"), undefined);
  });

  it("persists the per-host memory to a file", async () => {
    const file = join(tmp(), "transports.json");
    const first = new TransportPicker({
      transports: [
        new FakeTransport("node", 1, [{ status: 200, body: RADWARE }]),
        new FakeTransport("in-page", 3, [{ status: 200, body: JSON_OK }]),
      ],
      memoryFile: file,
    });
    await first.fetch({ url: URL_A, accept: "json" });
    assert.match(readFileSync(file, "utf8"), /in-page/);

    const node = new FakeTransport("node", 1, [{ status: 200, body: JSON_OK }]);
    const inPage = new FakeTransport("in-page", 3, [{ status: 200, body: JSON_OK }]);
    const second = new TransportPicker({ transports: [node, inPage], memoryFile: file });
    assert.equal(second.preferred("gw.yad2.co.il"), "in-page");
    const out = await second.fetch({ url: URL_A, accept: "json" });
    assert.equal(out.ok && out.response.transport, "in-page");
    assert.equal(node.calls, 0, "the remembered transport goes first");
  });

  it("forgets a preference that stops working", async () => {
    const file = join(tmp(), "transports.json");
    const picker = new TransportPicker({
      transports: [
        new FakeTransport("node", 1, [
          { status: 200, body: JSON_OK },
          { status: 503, body: "down" },
          { status: 503, body: "down" },
        ]),
        new FakeTransport("in-page", 3, [
          { status: 503, body: "down" },
          { status: 503, body: "down" },
          { status: 503, body: "down" },
        ]),
      ],
      memoryFile: file,
      forgetAfterFailures: 2,
    });
    await picker.fetch({ url: URL_A, accept: "json" });
    assert.equal(picker.preferred("gw.yad2.co.il"), "node");
    await picker.fetch({ url: URL_A, accept: "json" });
    assert.equal(picker.preferred("gw.yad2.co.il"), "node", "one failure is not enough");
    await picker.fetch({ url: URL_A, accept: "json" });
    assert.equal(picker.preferred("gw.yad2.co.il"), undefined);
  });

  it("stops the ladder on a login wall: no transport dodges that", async () => {
    const node = new FakeTransport("node", 1, [{ status: 200, body: LOGIN_WALL }]);
    const inPage = new FakeTransport("in-page", 3, [{ status: 200, body: JSON_OK }]);
    const picker = new TransportPicker({ transports: [node, inPage] });

    const out = await picker.fetch({ url: "https://www.facebook.com/marketplace/" });
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.challenge?.kind, "login_wall");
    assert.equal(inPage.calls, 0);
  });

  it("walks past a transport that throws", async () => {
    const node = new FakeTransport("node", 1, [new Error("ECONNRESET")]);
    const inPage = new FakeTransport("in-page", 3, [{ status: 200, body: JSON_OK }]);
    const picker = new TransportPicker({ transports: [node, inPage] });

    const out = await picker.fetch({ url: URL_A, accept: "json" });
    assert.equal(out.ok, true);
    assert.equal(out.attempts[0]?.verdict, "error");
    assert.match(out.attempts[0]?.error ?? "", /ECONNRESET/);
  });

  it("reports the most serious challenge when nothing works, with the body for diagnosis", async () => {
    const node = new FakeTransport("node", 1, [{ status: 503, body: "oops" }]);
    const inPage = new FakeTransport("in-page", 3, [{ status: 200, body: RADWARE }]);
    const picker = new TransportPicker({ transports: [node, inPage] });

    const out = await picker.fetch({ url: URL_A, accept: "json" });
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("unreachable");
    assert.equal(out.verdict, "needs_human", "needs_human outranks transient");
    assert.equal(out.challenge?.kind, "radware_captcha");
    assert.match(out.lastResponse?.body ?? "", /Bot Manager Captcha/);
  });
});
