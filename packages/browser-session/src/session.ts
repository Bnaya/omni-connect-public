/**
 * A named, long-lived browser session that connectors borrow.
 *
 *   await using session = await openBrowserSession({ name: "yad2-anon", url: "https://www.yad2.co.il/vehicles/cars" });
 *   const { status, body } = await session.pageFetch("https://gw.yad2.co.il/vehicles-feed/cars?...");
 *
 * Rules baked in, from `docs/playwright-cli-agent-guide.md` and CLAUDE.md:
 * - always `-s=<name>` **and** an explicit absolute `--profile`, so a restart never silently drops
 *   the login into an in-memory profile (gotcha 1);
 * - `open` only when the session is not already running; otherwise `goto` (gotcha 1);
 * - the CLI runs with cwd `.local/captures/<name>/`, so its output dir never lands in the shared
 *   repo-root `.playwright-cli/` (gotcha 5);
 * - one browser per profile, enforced by a lock file before we launch (gotcha 3);
 * - `close-all` / `kill-all` are never called — other agents share this machine;
 * - releasing the handle (`await using`) **keeps the browser alive** by default. A handoff needs the
 *   session to stay open, and a logged-in profile is expensive to rebuild. Pass
 *   `releaseAction: "close"` for a one-shot scrape.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CliRunner } from "./cli.ts";
import { NOT_OPEN_RE, PlaywrightCli, parseRawValue } from "./cli.ts";
import type { ProfileLockHandle } from "./lock.ts";
import { acquireProfileLock } from "./lock.ts";
import type { SessionPaths } from "./paths.ts";
import {
  ensureSessionDirs,
  hostOf,
  isRotatingProfileDir,
  rotatingProfileDir,
  sessionPaths,
  siteOf,
} from "./paths.ts";

export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
};

export type PageFetchRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Navigate the page to this origin first when it is somewhere else. */
  warmUpUrl?: string;
  timeoutMs?: number;
};

export type PageFetchResponse = {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type OpenSessionOptions = {
  /** Session name; also the default profile and capture directory name. */
  name: string;
  /** Page to open (or navigate to) when the session starts. */
  url?: string;
  /** Absolute profile dir. Default `.local/profiles/<name>`. */
  profileDir?: string;
  /**
   * Use a throwaway profile dir (removed on release). The Israel Post trick against Radware —
   * **anonymous scraping only**: a fresh profile has no cookies, so logged-in work must use the
   * stable profile.
   */
  rotateProfile?: boolean;
  /** Default true. Headless leaks `HeadlessChrome/…` in the UA and gets blocked more (gotcha 4). */
  headed?: boolean;
  /** `0` = never idle out; use it before a human handoff. Default: 0 for headed, 1 h for headless. */
  idleTimeoutMs?: number;
  /** Emulate a generic mobile device: lighter pages, fewer tokens. */
  mobile?: boolean;
  device?: string;
  browser?: string;
  /** Wait after opening/navigating, so anti-bot JS can run. Default 3000 ms. */
  settleMs?: number;
  /** Attach to an already-running session instead of restarting it. Default true. */
  reuse?: boolean;
  /** Take the profile lock. Default true. Only turn it off for read-only inspection. */
  lock?: boolean;
  /** Who is holding the lock, for the error message another agent will read. */
  agent?: string;
  /** What `release()`/`await using` does. Default "keep": leave the browser running. */
  releaseAction?: "keep" | "close";
  root?: string;
  cli?: CliRunner;
  signal?: AbortSignal;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

export class BrowserSession {
  readonly name: string;
  readonly paths: SessionPaths;
  readonly headed: boolean;
  /** True when this handle opened the browser, false when it attached to a running one. */
  readonly opened: boolean;
  readonly rotating: boolean;
  readonly cli: CliRunner;
  #lock: ProfileLockHandle | null;
  #releaseAction: "keep" | "close";
  #settleMs: number;
  #log: (message: string, data?: Record<string, unknown>) => void;
  #released = false;

  constructor(init: {
    name: string;
    paths: SessionPaths;
    headed: boolean;
    opened: boolean;
    rotating: boolean;
    cli: CliRunner;
    lock: ProfileLockHandle | null;
    releaseAction: "keep" | "close";
    settleMs: number;
    log: (message: string, data?: Record<string, unknown>) => void;
  }) {
    this.name = init.name;
    this.paths = init.paths;
    this.headed = init.headed;
    this.opened = init.opened;
    this.rotating = init.rotating;
    this.cli = init.cli;
    this.#lock = init.lock;
    this.#releaseAction = init.releaseAction;
    this.#settleMs = init.settleMs;
    this.#log = init.log;
  }

  get profileDir(): string {
    return this.paths.profileDir;
  }

  async #raw<T>(args: string[], opts: { nested?: boolean } = {}): Promise<T> {
    const res = await this.cli.run(["--raw", ...args]);
    return parseRawValue<T>(res.stdout, opts.nested === false ? { nested: false } : {});
  }

  /** Is the browser for this session running? */
  async isAlive(): Promise<boolean> {
    const res = await this.cli.run(["--raw", "eval", "() => location.href"], { tolerant: true });
    return res.ok && !NOT_OPEN_RE.test(res.output);
  }

  async currentUrl(): Promise<string> {
    return this.#raw<string>(["eval", "() => location.href"], { nested: false });
  }

  async title(): Promise<string> {
    return this.#raw<string>(["eval", "() => document.title"], { nested: false });
  }

  async goto(url: string, opts: { settleMs?: number } = {}): Promise<void> {
    await this.cli.run(["goto", url]);
    await settle(opts.settleMs ?? this.#settleMs);
  }

  async reload(): Promise<void> {
    await this.cli.run(["reload"]);
    await settle(this.#settleMs);
  }

  /** Run `() => …` in the page and parse the result. */
  async eval<T>(fnSource: string): Promise<T> {
    return this.#raw<T>(["eval", fnSource]);
  }

  /** Run `async page => …` (full Playwright `page` API) in the live session. */
  async runCode<T>(code: string): Promise<T> {
    return this.#raw<T>(["run-code", code]);
  }

  /** a11y snapshot, saved under the capture dir. Returns the file path the CLI printed. */
  async snapshot(filename?: string): Promise<string> {
    const target = filename ?? join(this.paths.captureDir, `snapshot-${stamp()}.yml`);
    await this.cli.run(["snapshot", `--filename=${target}`]);
    return target;
  }

  /** Screenshot for a handoff. Returns the absolute path. */
  async screenshot(hint = "handoff"): Promise<string> {
    const file = join(this.paths.screenshotsDir, `${this.name}-${hint}-${stamp()}.png`);
    await this.cli.run(["screenshot", `--filename=${file}`]);
    return file;
  }

  /**
   * Cookies of the live profile, **in memory only**. Never write these to disk: they are the login.
   * (`state-save` exists for a deliberate backup; this is not it.)
   */
  async cookies(forUrl?: string): Promise<Cookie[]> {
    const arg = forUrl ? JSON.stringify([new URL(forUrl).origin]) : "[]";
    return this.runCode<Cookie[]>(
      `async page => JSON.stringify(await page.context().cookies(...[${arg}].filter(a => a.length)))`,
    );
  }

  /** Is the page on `url`'s site? In-page fetch only inherits cookies when it is. */
  async isOnSiteOf(url: string): Promise<boolean> {
    const here = await this.currentUrl().catch(() => "");
    const want = siteOf(hostOf(url));
    return want !== "" && siteOf(hostOf(here)) === want;
  }

  /**
   * `fetch()` **inside the live page**: inherits the profile's cookies, the real TLS/HTTP2
   * fingerprint and the page's origin. This is what gets past Radware on Yad2 (NOTES.md).
   * A throw inside the page comes back as `status: 0`, which `detectChallenge` reads as transient.
   */
  async pageFetch(req: PageFetchRequest): Promise<PageFetchResponse> {
    const warmUp = req.warmUpUrl ?? new URL(req.url).origin;
    if (!(await this.isOnSiteOf(req.url))) {
      this.#log("browser-session: warming up the page for an in-page fetch", { url: warmUp });
      await this.goto(warmUp);
    }
    const init = {
      method: req.method ?? "GET",
      headers: req.headers ?? {},
      ...(req.body === undefined ? {} : { body: req.body }),
    };
    const code = `async () => {
      try {
        const r = await fetch(${JSON.stringify(req.url)}, { ...${JSON.stringify(init)}, credentials: "include" });
        const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
        return JSON.stringify({ status: r.status, url: r.url, headers: h, body: await r.text() });
      } catch (e) {
        return JSON.stringify({ status: 0, url: ${JSON.stringify(req.url)}, headers: {}, body: "in-page fetch failed: " + String(e) + " | page: " + document.title });
      }
    }`;
    return this.eval<PageFetchResponse>(code);
  }

  /** Close the browser. The profile stays on disk. Never closes anyone else's session. */
  async close(): Promise<void> {
    await this.cli.run(["close"], { tolerant: true });
  }

  /**
   * Give the profile back. Default: the browser keeps running (a handoff needs it alive, and a
   * logged-in profile is expensive to rebuild) and only the lock is dropped.
   */
  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    if (this.#releaseAction === "close" || this.rotating) await this.close();
    this.#lock?.release();
    this.#lock = null;
    if (this.rotating && isRotatingProfileDir(this.paths.profileDir)) {
      // Cookies are flushed lazily (gotcha 2); a rotating profile is throwaway anyway.
      await rm(this.paths.profileDir, { recursive: true, force: true }).catch(() => {});
      this.#log("browser-session: removed the rotating profile", { dir: this.paths.profileDir });
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }
}

export async function openBrowserSession(opts: OpenSessionOptions): Promise<BrowserSession> {
  const headed = opts.headed ?? true;
  const log = opts.log ?? (() => {});
  const rotating = opts.rotateProfile === true;
  const profileDir = rotating
    ? rotatingProfileDir(opts.name, opts.root ? { root: opts.root } : {})
    : opts.profileDir;
  const paths = sessionPaths(opts.name, {
    ...(opts.root ? { root: opts.root } : {}),
    ...(profileDir ? { profileDir } : {}),
  });
  await ensureSessionDirs(paths);

  const cli =
    opts.cli ??
    new PlaywrightCli({ session: opts.name, cwd: paths.captureDir, root: paths.root, log });

  const lock =
    opts.lock === false
      ? null
      : acquireProfileLock(paths.profileDir, {
          session: opts.name,
          ...(opts.agent ? { agent: opts.agent } : {}),
          log,
        });

  try {
    const probe = await cli.run(["--raw", "eval", "() => location.href"], { tolerant: true });
    const running = probe.ok && !NOT_OPEN_RE.test(probe.output);
    const settleMs = opts.settleMs ?? 3_000;
    let opened = false;

    if (running && opts.reuse !== false) {
      log("browser-session: attaching to a running session", { session: opts.name });
      if (opts.url) {
        const here = probe.stdout.trim().replace(/^"|"$/g, "");
        if (siteOf(hostOf(here)) !== siteOf(hostOf(opts.url))) {
          await cli.run(["goto", opts.url]);
          await settle(settleMs);
        }
      }
    } else {
      // `open` on a live session restarts it (gotcha 1), so only get here when it is not running.
      const idle = opts.idleTimeoutMs ?? (headed ? 0 : undefined);
      const args = [
        "open",
        ...(opts.url ? [opts.url] : []),
        `--profile=${paths.profileDir}`,
        ...(headed ? ["--headed"] : []),
        ...(idle === undefined ? [] : [`--idle-timeout=${idle}`]),
        ...(opts.mobile ? ["--mobile"] : []),
        ...(opts.device ? [`--device=${opts.device}`] : []),
        ...(opts.browser ? [`--browser=${opts.browser}`] : []),
      ];
      log("browser-session: opening", { session: opts.name, profile: paths.profileDir, headed });
      await cli.run(args);
      opened = true;
      await settle(settleMs);
    }

    return new BrowserSession({
      name: opts.name,
      paths,
      headed,
      opened,
      rotating,
      cli,
      lock,
      releaseAction: opts.releaseAction ?? "keep",
      settleMs,
      log,
    });
  } catch (err) {
    lock?.release();
    throw err;
  }
}

const settle = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
