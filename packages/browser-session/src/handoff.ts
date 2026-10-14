/**
 * Handing the live browser to the human (guide §9 and §10).
 *
 * The protocol is: freeze, do **not** close the session, screenshot, expose the viewer, ask one
 * specific question, wait. This file does the mechanical half — start/stop the `playwright-cli show`
 * viewer, capture the screenshot, and assemble core's `Handoff` — and documents the remote half
 * rather than guessing at it.
 *
 * ## Reaching the viewer from the owner's laptop over Tailscale — **not implemented on purpose**
 *
 * The dashboard has **no authentication**, and whoever reaches the port controls every browser
 * session on the machine, including logged-in ones. So this package starts it bound to localhost
 * and stops there. The guide's verified options, in order of preference:
 *
 * A. **SSH local port-forward** (safest; what `tailscaleHint()` prints):
 *      agent:  the viewer is already bound to localhost
 *      human:  `ssh -N -L 9400:localhost:9400 <user>@<machine>` over the tailnet, then
 *              open `http://localhost:9400`
 *    mosh does not forward ports — open a separate plain `ssh` for the tunnel. If `localhost` on
 *    the remote resolves to `127.0.0.1` only, start the viewer with `host: "127.0.0.1"` and forward
 *    `-L 9400:127.0.0.1:9400`.
 * B. **Bind to the Tailscale IP** (`host: (await tailscaleIp()) ?? undefined`): no SSH needed, but
 *    then *everything the tailnet ACLs allow* can drive the logged-in browser, with no auth. Only on
 *    a tailnet the owner trusts, and stop it immediately afterwards.
 * C. `tailscale serve` → **403**: serve forwards `Host: <machine>.<tailnet>.ts.net` and the
 *    loopback-bound dashboard rejects any Host but localhost/127.0.0.1/[::1]. Don't.
 * D. Cloudflare Tunnel: public HTTPS to an unauthenticated dashboard. Only with explicit approval,
 *    behind Cloudflare Access, torn down right after.
 *
 * **Never** `--host=0.0.0.0`. Ask the human before exposing anything you are unsure about.
 */
import type { Handoff, HandoffKind } from "@omni/core";
import { HandoffRequired, needsHuman } from "@omni/core";
import type { NeedsHuman } from "@omni/core";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { Challenge } from "./challenge.ts";
import { challengeToHandoff } from "./challenge.ts";
import { resolveCliBinary } from "./cli.ts";
import { findRepoRoot } from "./paths.ts";
import type { BrowserSession } from "./session.ts";

const execFileAsync = promisify(execFile);

export type ShowViewerOptions = {
  /** 0 (default) asks the CLI for a random free port. */
  port?: number;
  /** Bind address. Default: localhost. Read the module comment before changing it. */
  host?: string;
  /** Focus the viewer on one session. */
  session?: string;
  root?: string;
  bin?: string;
  cwd?: string;
  startTimeoutMs?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

/**
 * A `playwright-cli show --port=…` server we own.
 *
 * `stop()` kills **our** child process only. It never runs `show --kill`, which stops the shared
 * dashboard daemon other agents may be using (`stopSharedDashboard()` exists for when the human
 * asks for exactly that).
 */
export class ShowViewer implements AsyncDisposable {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  /**
   * The dashboard is a singleton daemon, and depending on how it was started it **can outlive
   * `stop()`** (started from a detached shell it printed `Dashboard is running pid=<n>` and stayed
   * up; started from here, killing our child took it down too). It is shared with every other agent
   * on the machine, so this package never kills it by name; the pid, when the CLI prints one, is
   * here for a human who wants to.
   */
  readonly daemonPid: number | undefined;
  #child: ChildProcess;
  #stopped = false;

  constructor(init: {
    url: string;
    port: number;
    host: string;
    child: ChildProcess;
    daemonPid?: number;
  }) {
    this.url = init.url;
    this.port = init.port;
    this.host = init.host;
    this.daemonPid = init.daemonPid;
    this.#child = init.child;
  }

  get running(): boolean {
    return !this.#stopped && this.#child.exitCode === null;
  }

  /** What to tell the human so they can reach this viewer from their laptop. */
  hint(machine = "<this machine>"): string {
    return tailscaleHint(this.port, { host: this.host, machine });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGTERM");
      // The child handle is unref'd (so it never keeps the process alive), which means its `exit`
      // event may never get a turn. A short *ref'd* timer bounds the wait either way.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        this.#child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.#child.stdout?.destroy();
    this.#child.stderr?.destroy();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}

export async function startShowViewer(opts: ShowViewerOptions = {}): Promise<ShowViewer> {
  const root = opts.root ?? findRepoRoot();
  const bin = opts.bin ?? resolveCliBinary(root);
  const host = opts.host ?? "localhost";
  const args = [
    ...(opts.session ? [`-s=${opts.session}`] : []),
    "show",
    `--port=${opts.port ?? 0}`,
    ...(opts.host ? [`--host=${opts.host}`] : []),
  ];
  const child = spawn(bin, args, { cwd: opts.cwd ?? root, stdio: ["ignore", "pipe", "pipe"] });
  const log = opts.log ?? (() => {});

  let buffer = "";
  // Two observed behaviours [verified on @playwright/cli 0.1.21]:
  //  - no dashboard running  → the command blocks and prints `Listening on http://localhost:<port>`;
  //  - one already running   → it prints `Dashboard is running pid=<n>` and exits 0, with no URL.
  // In the second case the port belongs to a daemon someone else may have started, so we look it up
  // instead of starting a competing one.
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `playwright-cli show did not report a URL within ${opts.startTimeoutMs ?? 15_000} ms: ${buffer.slice(0, 300)}`,
        ),
      );
    }, opts.startTimeoutMs ?? 15_000);
    const onChunk = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const hit = /(https?:\/\/[^\s]+)/.exec(buffer);
      if (hit) {
        clearTimeout(timer);
        resolve(hit[1]!.replace(/[.,)]$/, ""));
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      const pid = Number(/pid=(\d+)/.exec(buffer)?.[1]);
      if (code === 0 && Number.isInteger(pid) && pid > 0) {
        listeningPortOf(pid).then(
          (found) => {
            clearTimeout(timer);
            if (found === null) {
              reject(
                new Error(
                  `A playwright-cli dashboard is already running (pid ${pid}) but its port could not be found. Ask the human to run \`playwright-cli show\` and send you the URL.`,
                ),
              );
            } else {
              resolve(`http://localhost:${found}`);
            }
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
        return;
      }
      clearTimeout(timer);
      reject(new Error(`playwright-cli show exited with code ${code}: ${buffer.slice(0, 300)}`));
    });
  });
  // The dashboard daemon inherits these pipes, so leaving them referenced would keep *our* process
  // alive long after the work is done. Drain and unref instead.
  child.stdout?.resume();
  child.stderr?.resume();
  (child.stdout as { unref?: () => void } | null)?.unref?.();
  (child.stderr as { unref?: () => void } | null)?.unref?.();
  child.unref();

  const port = Number(new URL(url).port || (opts.port ?? 0));
  const daemonPid = Number(/pid=(\d+)/.exec(buffer)?.[1]);
  log("browser-session: viewer started", { url });
  return new ShowViewer({
    url,
    port,
    host,
    child,
    ...(Number.isInteger(daemonPid) && daemonPid > 0 ? { daemonPid } : {}),
  });
}

/** The TCP port a process is listening on, via `lsof`. Used to find an already-running dashboard. */
export async function listeningPortOf(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-Pan",
      "-p",
      String(pid),
      "-i",
      "-sTCP:LISTEN",
    ]);
    const port = /:(\d+)\s+\(LISTEN\)/.exec(stdout)?.[1];
    return port ? Number(port) : null;
  } catch {
    return null;
  }
}

/** Stops the **shared** dashboard daemon. Other agents may be using it — only on request. */
export async function stopSharedDashboard(
  opts: { root?: string; bin?: string } = {},
): Promise<void> {
  const root = opts.root ?? findRepoRoot();
  await execFileAsync(opts.bin ?? resolveCliBinary(root), ["show", "--kill"]).catch(() => {});
}

/** This machine's Tailscale IPv4, when the CLI is installed. For option B in the module comment. */
export async function tailscaleIp(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["ip", "-4"]);
    return stdout.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

export function tailscaleHint(
  port: number,
  opts: { host?: string; machine?: string } = {},
): string {
  const machine = opts.machine ?? "<machine-name>";
  const loopback = opts.host === undefined || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(opts.host);
  if (loopback) {
    return (
      `The viewer is bound to localhost on ${machine}. From your laptop, over the tailnet:\n` +
      `  ssh -N -L ${port}:localhost:${port} <user>@${machine}\n` +
      `then open http://localhost:${port}  (mosh does not forward ports — use a plain ssh for this)`
    );
  }
  return (
    `The viewer is bound to ${opts.host}:${port}. Open http://${opts.host}:${port} from any device on the tailnet.\n` +
    `It has NO authentication and controls every browser session on ${machine}; stop it as soon as you are done.`
  );
}

export type PrepareHandoffOptions = {
  session?: BrowserSession;
  viewer?: ShowViewer | { url: string };
  /** What the connector was trying to do, in the human's words. */
  goal?: string;
  /** Overrides the challenge's own suggestion. */
  kind?: HandoffKind;
  message?: string;
  screenshot?: boolean;
  screenshotHint?: string;
};

/**
 * Freeze-and-ask, in one call: screenshot the live page, note where it is, and build core's
 * `Handoff`. The session is deliberately left open.
 */
export async function prepareHandoff(
  challenge: Challenge,
  opts: PrepareHandoffOptions = {},
): Promise<Handoff> {
  const session = opts.session;
  let screenshotPath: string | undefined;
  let pageUrl: string | undefined;
  if (session) {
    if (opts.screenshot !== false) {
      screenshotPath = await session
        .screenshot(opts.screenshotHint ?? challenge.kind)
        .catch(() => undefined);
    }
    pageUrl = await session.currentUrl().catch(() => undefined);
  }
  const handoff = challengeToHandoff(challenge, {
    ...(opts.goal ? { goal: opts.goal } : {}),
    ...(screenshotPath ? { screenshotPath } : {}),
    ...((pageUrl ?? challenge.url) ? { pageUrl: (pageUrl ?? challenge.url)! } : {}),
    ...(opts.viewer ? { liveSessionUrl: opts.viewer.url } : {}),
    ...(session ? { session: session.name } : {}),
  });
  if (opts.kind) handoff.kind = opts.kind;
  if (opts.message) handoff.message = opts.message;
  return handoff;
}

/** The same thing as a `needs_human` operation result. */
export async function handoffResult(
  challenge: Challenge,
  opts: PrepareHandoffOptions = {},
): Promise<NeedsHuman> {
  return needsHuman(await prepareHandoff(challenge, opts));
}

/** …or as the exception core's runtime turns into a `needs_human` result. */
export async function throwHandoff(
  challenge: Challenge,
  opts: PrepareHandoffOptions = {},
): Promise<never> {
  throw new HandoffRequired(await prepareHandoff(challenge, opts));
}

/** The message template from guide §9, for a human reading a terminal. */
export function formatHandoff(
  handoff: Handoff,
  opts: { site?: string; session?: string } = {},
): string {
  return [
    `HANDOFF ${opts.site ?? ""} / session ${opts.session ?? "?"}`.trim(),
    `Where: ${handoff.pageUrl ?? "?"}${handoff.screenshotPath ? ` (screenshot: ${handoff.screenshotPath})` : ""}`,
    `Stuck because: ${handoff.message}`,
    handoff.bestGuess ? `Best guess: ${handoff.bestGuess}` : undefined,
    `Need from you: ${needFor(handoff.kind)}`,
    handoff.liveSessionUrl ? `Live view: ${handoff.liveSessionUrl}` : undefined,
    "I'm waiting; the session stays open.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function needFor(kind: HandoffKind): string {
  switch (kind) {
    case "captcha":
      return "solve the challenge in the live dashboard, then tell me to continue";
    case "login":
      return "log in in the live dashboard, then tell me to continue";
    case "otp":
      return "the one-time code";
    case "credentials":
      return "set the missing environment variable(s)";
    case "confirm":
      return "yes or no";
    default:
      return "a decision on how to proceed";
  }
}
