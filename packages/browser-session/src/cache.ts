/**
 * On-disk response cache. "Cache responses instead of refetching" is a politeness rule, not an
 * optimisation (guide §12), and during development it is the difference between one live request
 * and fifty.
 *
 * One JSON file per entry under `<dir>/`, named by a hash of the request. Challenge pages are never
 * cached as answers; `saveChallenge` keeps them under `<dir>/blocked/` for diagnosis instead.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TransportResponse } from "./transports.ts";

export type CacheEntry = {
  key: string;
  savedAt: string;
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
  transport: TransportResponse["transport"];
};

export type CacheKeyParts = {
  url: string;
  method?: string;
  body?: string;
};

export function cacheKey(parts: CacheKeyParts): string {
  return `${(parts.method ?? "GET").toUpperCase()} ${parts.url}${parts.body ? ` ${parts.body}` : ""}`;
}

export class ResponseCache {
  readonly dir: string | null;
  readonly ttlMs: number;
  #now: () => Date;

  constructor(dir: string | null, ttlMs = 30 * 60_000, now: () => Date = () => new Date()) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.#now = now;
  }

  path(key: string): string | null {
    if (!this.dir) return null;
    return join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  }

  get(key: string): CacheEntry | undefined {
    if (this.ttlMs <= 0) return undefined;
    const path = this.path(key);
    if (!path) return undefined;
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
      if (entry.key !== key) return undefined; // hash collision or a stale file
      if (this.#now().getTime() - Date.parse(entry.savedAt) > this.ttlMs) return undefined;
      return entry;
    } catch {
      return undefined;
    }
  }

  set(key: string, response: TransportResponse): CacheEntry | undefined {
    const path = this.path(key);
    if (!path || !this.dir) return undefined;
    const entry: CacheEntry = {
      key,
      savedAt: this.#now().toISOString(),
      status: response.status,
      url: response.url,
      headers: response.headers,
      body: response.body,
      transport: response.transport,
    };
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, path);
    return entry;
  }

  /**
   * Keep a challenge page for diagnosis. Never readable as an answer: it lives in a separate
   * directory and `get` never looks there.
   */
  saveChallenge(key: string, body: string, label = "blocked"): string | undefined {
    if (!this.dir) return undefined;
    const dir = join(this.dir, "blocked");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${this.#now().toISOString().replace(/[:.]/g, "-")}-${label}.html`);
    writeFileSync(file, `<!-- ${key} -->\n${body}`);
    return file;
  }
}
