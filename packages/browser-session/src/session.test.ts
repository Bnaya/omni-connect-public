import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ProfileLockedError, acquireProfileLock } from "./lock.ts";
import { isRotatingProfileDir, sessionPaths, siteOf } from "./paths.ts";
import { openBrowserSession } from "./session.ts";
import { FakeCli } from "./testing.ts";

const tmpRoots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "omni-session-"));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

const NOT_OPEN = {
  ok: false,
  code: 1,
  stdout: "",
  stderr: "Error: browser is not open",
  output: "Error: browser is not open",
};

/** A CLI that behaves like a session which is not running yet. */
function closedCli(): FakeCli {
  const cli = new FakeCli("yad2-anon");
  let href = "";
  cli.on(/^--raw eval \(\) => location\.href/, () =>
    href === "" ? NOT_OPEN : JSON.stringify(href),
  );
  cli.on(/^open/, (args) => {
    href = args.find((a) => a.startsWith("http")) ?? "about:blank";
    return "";
  });
  cli.on(/^goto/, (args) => {
    href = args[1] ?? href;
    return "";
  });
  return cli;
}

describe("openBrowserSession", () => {
  it("opens with an explicit absolute profile, headed, and never idles out", async () => {
    const cli = closedCli();
    const session = await openBrowserSession({
      name: "yad2-anon",
      url: "https://www.yad2.co.il/vehicles/cars",
      root: root(),
      cli,
      settleMs: 0,
    });
    const open = cli.calls.find((c) => c[0] === "open");
    assert.ok(open, "it opened the session");
    assert.ok(
      open.includes("--headed"),
      "headed by default: headless leaks HeadlessChrome in the UA",
    );
    assert.ok(open.includes("--idle-timeout=0"), "a headed session never idles out");
    const profileArg = open.find((a) => a.startsWith("--profile="));
    assert.ok(profileArg?.startsWith("--profile=/"), `absolute profile path, got ${profileArg}`);
    assert.ok(profileArg?.endsWith("/.local/profiles/yad2-anon"));
    assert.equal(session.opened, true);
    await session.release();
  });

  it("runs the CLI inside .local/captures/<name>/ so output never lands in the repo root", async () => {
    const dir = root();
    const paths = sessionPaths("yad2-anon", { root: dir });
    assert.equal(paths.captureDir, join(dir, ".local", "captures", "yad2-anon"));
    assert.equal(paths.outputDir, join(paths.captureDir, ".playwright-cli"));
    const session = await openBrowserSession({
      name: "yad2-anon",
      root: dir,
      cli: closedCli(),
      settleMs: 0,
    });
    assert.equal(session.paths.captureDir, paths.captureDir);
    assert.ok(existsSync(paths.captureDir), "the capture dir exists before the CLI runs");
    await session.release();
  });

  it("attaches to a running session instead of re-opening it (gotcha 1)", async () => {
    const cli = new FakeCli("yad2-anon");
    cli.on(/^--raw eval \(\) => location\.href/, () =>
      JSON.stringify("https://www.yad2.co.il/vehicles/cars"),
    );
    const session = await openBrowserSession({
      name: "yad2-anon",
      url: "https://www.yad2.co.il/vehicles/cars?page=2",
      root: root(),
      cli,
      settleMs: 0,
    });
    assert.equal(session.opened, false);
    assert.equal(
      cli.commands.filter((c) => c.startsWith("open")).length,
      0,
      "`open` would restart it and drop the profile",
    );
    assert.equal(
      cli.commands.filter((c) => c.startsWith("goto")).length,
      0,
      "already on the same site",
    );
    await session.release();
  });

  it("navigates when the running session is on another site", async () => {
    const cli = new FakeCli("yad2-anon");
    cli.on(/^--raw eval \(\) => location\.href/, () => JSON.stringify("https://example.com/"));
    cli.on(/^goto/, () => "");
    const session = await openBrowserSession({
      name: "yad2-anon",
      url: "https://www.yad2.co.il/vehicles/cars",
      root: root(),
      cli,
      settleMs: 0,
    });
    assert.ok(cli.commands.some((c) => c.startsWith("goto https://www.yad2.co.il")));
    await session.release();
  });

  it("never calls close-all or kill-all, whatever happens", async () => {
    const cli = closedCli();
    const session = await openBrowserSession({
      name: "yad2-anon",
      root: root(),
      cli,
      settleMs: 0,
      releaseAction: "close",
    });
    await session.goto("https://www.yad2.co.il/vehicles/cars", { settleMs: 0 });
    await session.release();
    assert.ok(
      cli.commands.some((c) => c === "close"),
      "it closed its own session",
    );
    assert.ok(
      !cli.commands.some((c) => /close-all|kill-all/.test(c)),
      "other agents' browsers are untouched",
    );
  });

  it("keeps the browser alive on release by default — a handoff needs it", async () => {
    const cli = closedCli();
    const session = await openBrowserSession({ name: "yad2-anon", root: root(), cli, settleMs: 0 });
    await session.release();
    assert.ok(!cli.commands.includes("close"));
  });

  it("holds the profile lock while it lives", async () => {
    const dir = root();
    const session = await openBrowserSession({
      name: "yad2-anon",
      root: dir,
      cli: closedCli(),
      settleMs: 0,
      agent: "agent-a",
    });
    assert.throws(
      () => acquireProfileLock(session.profileDir, { session: "yad2-anon", agent: "agent-b" }),
      ProfileLockedError,
    );
    await session.release();
    acquireProfileLock(session.profileDir, { session: "yad2-anon", agent: "agent-b" }).release();
  });
});

describe("BrowserSession", () => {
  it("fetches inside the page, warming up to the right site first", async () => {
    const cli = closedCli();
    const session = await openBrowserSession({
      name: "yad2-anon",
      url: "https://www.yad2.co.il/vehicles/cars",
      root: root(),
      cli,
      settleMs: 0,
    });
    cli.on(/^--raw eval async \(\) => \{/, () =>
      JSON.stringify(
        JSON.stringify({
          status: 200,
          url: "https://gw.yad2.co.il/feed",
          headers: {},
          body: '{"data":1}',
        }),
      ),
    );
    const res = await session.pageFetch({ url: "https://gw.yad2.co.il/feed" });
    assert.equal(res.status, 200);
    assert.equal(res.body, '{"data":1}');
    // gw.yad2.co.il and www.yad2.co.il are the same site, so no navigation was needed.
    assert.equal(siteOf("gw.yad2.co.il"), "yad2.co.il");
    assert.equal(cli.commands.filter((c) => c.startsWith("goto")).length, 0);

    const before = cli.commands.length;
    await session.pageFetch({
      url: "https://www.israelpost.co.il/track",
      warmUpUrl: "https://www.israelpost.co.il/",
    });
    assert.ok(
      cli.commands.slice(before).some((c) => c.startsWith("goto https://www.israelpost.co.il/")),
      "a different site is warmed up first, so the fetch inherits its cookies",
    );
    await session.release();
  });

  it("writes screenshots under .local/screenshots/<name>/", async () => {
    const dir = root();
    const cli = closedCli();
    const session = await openBrowserSession({ name: "yad2-anon", root: dir, cli, settleMs: 0 });
    const path = await session.screenshot("captcha");
    assert.ok(path.startsWith(join(dir, ".local", "screenshots", "yad2-anon")), path);
    assert.ok(cli.commands.some((c) => c.startsWith(`screenshot --filename=${path}`)));
    await session.release();
  });

  it("reads cookies through the context, keeping them in memory", async () => {
    const cli = closedCli();
    cli.on(/^--raw run-code/, () =>
      JSON.stringify(
        JSON.stringify([{ name: "__uzma", value: "secret", domain: ".yad2.co.il", path: "/" }]),
      ),
    );
    const session = await openBrowserSession({ name: "yad2-anon", root: root(), cli, settleMs: 0 });
    const cookies = await session.cookies("https://www.yad2.co.il/");
    assert.equal(cookies[0]?.name, "__uzma");
    const runCode = cli.calls.find((c) => c[1] === "run-code")?.join(" ") ?? "";
    assert.match(runCode, /context\(\)\.cookies/);
    await session.release();
  });

  it("uses a throwaway profile when asked, and removes it on release", async () => {
    const dir = root();
    const cli = closedCli();
    const session = await openBrowserSession({
      name: "israelpost",
      root: dir,
      cli,
      settleMs: 0,
      rotateProfile: true,
    });
    assert.ok(isRotatingProfileDir(session.profileDir), session.profileDir);
    assert.ok(existsSync(session.profileDir));
    await session.release();
    assert.equal(existsSync(session.profileDir), false, "a rotating profile is throwaway");
    assert.ok(cli.commands.includes("close"), "and its browser is closed with it");
  });
});
