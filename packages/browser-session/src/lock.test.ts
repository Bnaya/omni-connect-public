import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  LOCK_FILE,
  ProfileLockedError,
  acquireProfileLock,
  isPidAlive,
  profileLockHolder,
} from "./lock.ts";

const tmpDirs: string[] = [];
function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omni-lock-"));
  tmpDirs.push(dir);
  return join(dir, "yad2");
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("profile lock", () => {
  it("stops a second agent from sharing one profile", () => {
    const dir = profile();
    const first = acquireProfileLock(dir, { session: "yad2", agent: "agent-a" });
    assert.ok(existsSync(join(dir, LOCK_FILE)));
    assert.throws(
      () => acquireProfileLock(dir, { session: "yad2", agent: "agent-b" }),
      (err: unknown) => {
        assert.ok(err instanceof ProfileLockedError);
        assert.equal(err.info.agent, "agent-a");
        assert.match(err.message, /One browser per profile/);
        return true;
      },
    );
    first.release();
    const second = acquireProfileLock(dir, { session: "yad2", agent: "agent-b" });
    assert.equal(profileLockHolder(dir)?.agent, "agent-b");
    second.release();
    assert.equal(profileLockHolder(dir), null);
  });

  it("releases on `using`", () => {
    const dir = profile();
    {
      using lock = acquireProfileLock(dir, { session: "yad2" });
      assert.equal(lock.held, true);
    }
    assert.equal(existsSync(join(dir, LOCK_FILE)), false);
  });

  it("steals a lock whose holder is gone", () => {
    const dir = profile();
    acquireProfileLock(dir, { session: "yad2", agent: "agent-a" }); // deliberately not released
    // Rewrite it as if a long-dead process had left it behind.
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({
        pid: 999_999,
        session: "yad2",
        agent: "ghost",
        host: "x",
        since: new Date().toISOString(),
      }),
    );
    const taken = acquireProfileLock(dir, { session: "yad2", agent: "agent-b" });
    assert.equal(profileLockHolder(dir)?.agent, "agent-b");
    taken.release();
  });

  it("steals a lock that is simply too old", () => {
    const dir = profile();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({
        pid: process.pid, // alive, but ancient
        session: "yad2",
        agent: "forgotten",
        host: "x",
        since: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      }),
    );
    const taken = acquireProfileLock(dir, {
      session: "yad2",
      agent: "agent-b",
      staleAfterMs: 6 * 60 * 60 * 1000,
    });
    assert.equal(profileLockHolder(dir)?.agent, "agent-b");
    taken.release();
  });

  it("does not delete a lock that was stolen from it", () => {
    const dir = profile();
    const mine = acquireProfileLock(dir, { session: "yad2", agent: "agent-a" });
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({
        pid: process.pid,
        session: "yad2",
        agent: "agent-b",
        host: "x",
        since: new Date().toISOString(),
      }),
    );
    mine.release();
    assert.equal(
      profileLockHolder(dir)?.agent,
      "agent-b",
      "releasing must not evict the new holder",
    );
  });

  it("knows which pids are alive", () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(999_999), false);
  });
});
