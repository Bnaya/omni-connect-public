/**
 * Where a session's state lives. Everything is under `.local/`, which is never shared
 * (CLAUDE.md, and `docs/playwright-cli-agent-guide.md` §11 "Where things go").
 *
 *   .local/profiles/<name>/              the identity (cookies, localStorage) — never share
 *   .local/captures/<name>/              cwd for playwright-cli, so its default `./.playwright-cli/`
 *                                        output dir lands here instead of the shared repo root
 *   .local/captures/<name>/http-cache/   cached responses + the request log + per-host budgets
 *   .local/screenshots/<name>/           handoff screenshots
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

/** Walk up from `from` to the pnpm workspace root; falls back to `from`. */
export function findRepoRoot(from: string = import.meta.dirname): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/** Session/profile names become directory names, so keep them boring. */
export function assertSessionName(name: string): void {
  if (!NAME_RE.test(name) || name.includes("..")) {
    throw new Error(
      `Invalid session name ${JSON.stringify(name)} (use letters, digits, ".", "-", "_")`,
    );
  }
}

export type SessionPaths = {
  root: string;
  /** Persistent browser profile (`--profile`). Absolute, per gotcha 6 in the guide. */
  profileDir: string;
  /** cwd for playwright-cli. */
  captureDir: string;
  /** Where the CLI drops auto-named snapshots and console logs. */
  outputDir: string;
  screenshotsDir: string;
  /** Response cache, request log and budget state. */
  httpCacheDir: string;
};

export function sessionPaths(
  name: string,
  opts: { root?: string; profileDir?: string } = {},
): SessionPaths {
  assertSessionName(name);
  const root = opts.root ?? findRepoRoot();
  const local = join(root, ".local");
  const captureDir = join(local, "captures", name);
  return {
    root,
    profileDir: opts.profileDir ? resolve(opts.profileDir) : join(local, "profiles", name),
    captureDir,
    outputDir: join(captureDir, ".playwright-cli"),
    screenshotsDir: join(local, "screenshots", name),
    httpCacheDir: join(captureDir, "http-cache"),
  };
}

/**
 * A throwaway profile directory, the trick `WolfikOz/israel-post-tracking` uses against Radware
 * (see `docs/research/openclaw-and-skill-ecosystems.md` §5.9). Only for **anonymous** scraping:
 * a fresh profile has no cookies, so a logged-in connector must use the stable profile instead.
 */
export function rotatingProfileDir(name: string, opts: { root?: string } = {}): string {
  assertSessionName(name);
  const root = opts.root ?? findRepoRoot();
  return join(
    root,
    ".local",
    "profiles",
    `${name}-rot-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
  );
}

/** True for a directory produced by `rotatingProfileDir` (safe to delete). */
export function isRotatingProfileDir(dir: string): boolean {
  return /-rot-[0-9a-z]+-[0-9a-f]{8}$/.test(dir);
}

export async function ensureSessionDirs(paths: SessionPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.captureDir, { recursive: true }),
    mkdir(dirname(paths.profileDir), { recursive: true }),
    mkdir(paths.screenshotsDir, { recursive: true }),
  ]);
}

/** Registrable-ish domain, good enough to decide "is the page on the right site". */
export function siteOf(hostname: string): string {
  const parts = hostname.toLowerCase().split(".");
  if (parts.length <= 2) return parts.join(".");
  // Handles co.il, co.uk, com.au, ac.il…
  const twoLevelTld = /^(co|com|net|org|gov|ac|edu|muni|idf|k12)$/.test(parts[parts.length - 2]!);
  return parts.slice(twoLevelTld ? -3 : -2).join(".");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
