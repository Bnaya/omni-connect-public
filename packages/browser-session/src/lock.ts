/**
 * One browser per profile. Chrome enforces it with its own ProcessSingleton (guide gotcha 3), but
 * that error arrives late and reads like a crash; this lock makes "another agent is using
 * `.local/profiles/yad2`" an explicit, attributable failure *before* we launch anything.
 *
 * The lock file lives inside the profile directory, so it travels with the profile and is obvious
 * to a human looking for who is holding it.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const LOCK_FILE = ".omni-session.lock";

export type LockInfo = {
  pid: number;
  /** Session name the holder opened. */
  session: string;
  /** Free-form "who am I" (agent name, task id). */
  agent: string;
  host: string;
  since: string;
};

export class ProfileLockedError extends Error {
  override name = "ProfileLockedError";
  info: LockInfo;
  lockPath: string;
  constructor(lockPath: string, info: LockInfo) {
    super(
      `Profile is locked by ${info.agent} (pid ${info.pid}, session "${info.session}", since ${info.since}) on ${info.host}. ` +
        `One browser per profile: wait, use a different profile, or delete ${lockPath} if that process is gone.`,
    );
    this.info = info;
    this.lockPath = lockPath;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

export interface ProfileLockHandle extends Disposable {
  readonly path: string;
  readonly info: LockInfo;
  readonly held: boolean;
  release(): void;
}

export type AcquireLockOptions = {
  session: string;
  agent?: string;
  /** A lock whose holder is gone, or older than this, is stolen. Default 6 h. */
  staleAfterMs?: number;
  now?: () => Date;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

/** Takes the lock, or throws `ProfileLockedError`. Synchronous on purpose: it must be atomic. */
export function acquireProfileLock(
  profileDir: string,
  opts: AcquireLockOptions,
): ProfileLockHandle {
  const path = join(profileDir, LOCK_FILE);
  const now = opts.now ?? (() => new Date());
  const staleAfterMs = opts.staleAfterMs ?? 6 * 60 * 60 * 1000;
  const log = opts.log ?? (() => {});
  const info: LockInfo = {
    pid: process.pid,
    session: opts.session,
    agent: opts.agent ?? process.env.OMNI_AGENT ?? `pid:${process.pid}`,
    host: hostname(),
    since: now().toISOString(),
  };
  mkdirSync(profileDir, { recursive: true });

  const contents = `${JSON.stringify(info, null, 2)}\n`;
  const write = (): void => {
    writeFileSync(path, contents, { flag: "wx" });
  };

  try {
    write();
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
    const existing = readLock(path);
    if (existing !== null) {
      const stale =
        !isPidAlive(existing.pid) || now().getTime() - Date.parse(existing.since) > staleAfterMs;
      if (!stale) throw new ProfileLockedError(path, existing);
      log("browser-session: stealing a stale profile lock", {
        path,
        heldBy: existing.agent,
        pid: existing.pid,
      });
    }
    unlinkSync(path);
    write();
  }

  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    // Only remove the file if it is still ours byte for byte (someone may have stolen it as stale).
    try {
      if (readFileSync(path, "utf8") !== contents) return;
      unlinkSync(path);
    } catch {
      // already gone
    }
  };
  return {
    path,
    info,
    get held() {
      return held;
    },
    release,
    [Symbol.dispose]: release,
  };
}

export function readLock(path: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    return typeof info?.pid === "number" ? info : null;
  } catch {
    return null;
  }
}

/** Who holds the lock on this profile, if anyone (for status output and error messages). */
export function profileLockHolder(profileDir: string): LockInfo | null {
  return readLock(join(profileDir, LOCK_FILE));
}
