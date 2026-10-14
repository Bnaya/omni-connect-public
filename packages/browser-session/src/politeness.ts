/**
 * Per-host rate limiting and request budgets, on top of `@omni/concurrency`.
 *
 * Three separate promises to the site (guide §12):
 * - **spacing**: at most N requests per interval, per host (a sliding window, FIFO);
 * - **a daily cap**: a hard ceiling per host per UTC day, persisted, so restarting the process does
 *   not reset it;
 * - **back-off**: repeated rate-limit / auth answers stop us for a while instead of hammering.
 *
 * The state file is shared by every process that points at the same directory, which is how two
 * agents working on the same site stay inside one budget.
 */
import type { RateLimiter } from "@omni/concurrency";
import { createRateLimiter } from "@omni/concurrency";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostOf } from "./paths.ts";

export type HostPolicy = {
  /** Requests allowed per `intervalMs`. Default 1. */
  perInterval?: number;
  /** Window length. Default 5000 ms — "a few seconds between page loads". */
  intervalMs?: number;
  /** Hard ceiling per UTC day. Default 200. */
  dailyCap?: number;
  /** Consecutive strikes before the back-off starts. Default 2. */
  strikesToBackoff?: number;
  /** How long the back-off lasts. Default 1 h. */
  backoffMs?: number;
};

export type HostState = {
  day: string;
  requests: number;
  strikes: number;
  backoffUntil: string | null;
  lastError: string | null;
};

export type BudgetState = Record<string, HostState>;

export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
  reason: "daily_cap" | "backoff";
  host: string;
  until: string;
  constructor(reason: "daily_cap" | "backoff", host: string, until: string, message: string) {
    super(message);
    this.reason = reason;
    this.host = host;
    this.until = until;
  }
}

export type PolitenessOptions = {
  /** JSON file holding the per-host budgets. null keeps them in memory (tests). */
  file?: string | null;
  defaults?: HostPolicy;
  /** Per-host overrides, keyed by hostname. */
  hosts?: Record<string, HostPolicy>;
  now?: () => Date;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

const freshState = (day: string): HostState => ({
  day,
  requests: 0,
  strikes: 0,
  backoffUntil: null,
  lastError: null,
});

export class Politeness implements Disposable {
  #file: string | null;
  #defaults: Required<HostPolicy>;
  #hosts: Record<string, HostPolicy>;
  #now: () => Date;
  #log: (message: string, data?: Record<string, unknown>) => void;
  #limiters = new Map<string, RateLimiter>();
  #memory: BudgetState = {};
  #disposed = false;

  constructor(opts: PolitenessOptions = {}) {
    this.#file = opts.file ?? null;
    this.#defaults = {
      perInterval: opts.defaults?.perInterval ?? 1,
      intervalMs: opts.defaults?.intervalMs ?? 5_000,
      dailyCap: opts.defaults?.dailyCap ?? 200,
      strikesToBackoff: opts.defaults?.strikesToBackoff ?? 2,
      backoffMs: opts.defaults?.backoffMs ?? 60 * 60_000,
    };
    this.#hosts = opts.hosts ?? {};
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? (() => {});
  }

  policy(host: string): Required<HostPolicy> {
    return { ...this.#defaults, ...this.#hosts[host] };
  }

  #limiter(host: string): RateLimiter {
    let limiter = this.#limiters.get(host);
    if (!limiter) {
      const { perInterval, intervalMs } = this.policy(host);
      limiter = createRateLimiter({ perInterval, intervalMs });
      this.#limiters.set(host, limiter);
    }
    return limiter;
  }

  #read(): BudgetState {
    if (!this.#file) return this.#memory;
    try {
      return JSON.parse(readFileSync(this.#file, "utf8")) as BudgetState;
    } catch {
      return {};
    }
  }

  #write(state: BudgetState): void {
    if (!this.#file) {
      this.#memory = state;
      return;
    }
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, this.#file);
  }

  /** Today's counters for a host (resets itself on a new UTC day). */
  state(host: string): HostState {
    const day = utcDay(this.#now());
    const stored = this.#read()[host];
    if (!stored) return freshState(day);
    return stored.day === day ? stored : { ...stored, day, requests: 0 };
  }

  #update(host: string, next: HostState): void {
    const state = this.#read();
    state[host] = next;
    this.#write(state);
  }

  /** Throws `BudgetExceededError` instead of spending when we are capped or backing off. */
  checkBudget(url: string): void {
    const host = hostOf(url);
    const policy = this.policy(host);
    const state = this.state(host);
    const now = this.#now();
    if (state.backoffUntil && new Date(state.backoffUntil) > now) {
      throw new BudgetExceededError(
        "backoff",
        host,
        state.backoffUntil,
        `Backing off from ${host} until ${state.backoffUntil} after repeated "${state.lastError}" answers.`,
      );
    }
    if (state.requests >= policy.dailyCap) {
      const until = `${utcDay(new Date(now.getTime() + 86_400_000))}T00:00:00.000Z`;
      throw new BudgetExceededError(
        "daily_cap",
        host,
        until,
        `Daily cap of ${policy.dailyCap} requests to ${host} reached (resets ${until}).`,
      );
    }
  }

  /** Check the budget, wait for a slot, then count the request. Call once per network request. */
  async acquire(url: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#disposed) throw new Error("Politeness was disposed");
    const host = hostOf(url);
    this.checkBudget(url);
    await this.#limiter(host).acquire(options.signal ? { signal: options.signal } : {});
    const state = this.state(host);
    this.#update(host, { ...state, requests: state.requests + 1 });
  }

  /** A real answer: clears the strike counter and any back-off. */
  success(url: string): void {
    const host = hostOf(url);
    const state = this.state(host);
    if (state.strikes || state.backoffUntil) {
      this.#update(host, { ...state, strikes: 0, backoffUntil: null, lastError: null });
    }
  }

  /** A rate-limit / auth / block answer. Returns true when this started a back-off. */
  strike(url: string, kind: string): boolean {
    const host = hostOf(url);
    const policy = this.policy(host);
    const state = this.state(host);
    const strikes = state.strikes + 1;
    const starting = strikes >= policy.strikesToBackoff && !state.backoffUntil;
    const backoffUntil = starting
      ? new Date(this.#now().getTime() + policy.backoffMs).toISOString()
      : state.backoffUntil;
    this.#update(host, { ...state, strikes, lastError: kind, backoffUntil });
    if (starting) this.#log("browser-session: backing off", { host, kind, until: backoffUntil });
    return starting;
  }

  /** Clear a back-off a human has decided is over. */
  resume(url: string): void {
    const host = hostOf(url);
    this.#update(host, { ...this.state(host), strikes: 0, backoffUntil: null });
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const limiter of this.#limiters.values()) limiter.dispose();
    this.#limiters.clear();
  }

  dispose(): void {
    this[Symbol.dispose]();
  }
}
