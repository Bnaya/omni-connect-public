/**
 * The whole thing wired together: cache → budget → spacing → cheapest working transport →
 * challenge detection → one retry for a transient challenge → a typed `needs_human` handoff.
 *
 *   await using session = await openBrowserSession({ name: "yad2-anon" });
 *   using fetcher = createSessionFetcher(session, {
 *     warmUp: { "gw.yad2.co.il": "https://www.yad2.co.il/vehicles/cars" },
 *   });
 *   const out = await fetcher.fetch({ url, accept: "json" });
 *   if (out.status === "needs_human") return out.result;   // core's NeedsHuman, ready to return
 *   if (out.status === "error") throw new Error(out.message);
 *   const data = JSON.parse(out.response.body);
 *
 * One transient retry, never a loop: that is the promise the politeness rules make to the site.
 */
import { delay } from "@omni/concurrency";
import type { NeedsHuman } from "@omni/core";
import { needsHuman } from "@omni/core";
import { join } from "node:path";
import type { Challenge } from "./challenge.ts";
import { ResponseCache, cacheKey } from "./cache.ts";
import type { PickOutcome } from "./pick.ts";
import { TransportPicker } from "./pick.ts";
import { hostOf } from "./paths.ts";
import type { HostPolicy } from "./politeness.ts";
import { BudgetExceededError, Politeness } from "./politeness.ts";
import { RequestLog } from "./request-log.ts";
import type { ShowViewer } from "./handoff.ts";
import { prepareHandoff } from "./handoff.ts";
import type { BrowserSession } from "./session.ts";
import type { Transport, TransportRequest, TransportResponse } from "./transports.ts";
import { InPageTransport, NodeTransport, ProfileCookieTransport } from "./transports.ts";

export type FetchOutcome =
  | { status: "ok"; response: TransportResponse; fromCache: boolean; attempts: number }
  /** A human must act. `result` is core's `NeedsHuman`, ready to return from an operation. */
  | { status: "needs_human"; challenge: Challenge; result: NeedsHuman; attempts: number }
  /** Everything failed but nothing asked for a human (budget, back-off, transport errors). */
  | { status: "error"; message: string; code: string; retryable: boolean; attempts: number };

export type SessionFetchRequest = TransportRequest & {
  /** `"authenticated"` turns a login page into "the saved session went stale". */
  expect?: "any" | "json" | "html" | "authenticated";
  /** Per-request TTL override; 0 skips the cache for this call. */
  cacheTtlMs?: number;
  /** What the human should be told we were doing, if this ends in a handoff. */
  goal?: string;
};

export type SessionFetcherOptions = {
  transports?: Transport[];
  /** Host → page to navigate to before an in-page fetch (e.g. a JSON gateway on another subdomain). */
  warmUp?: Record<string, string>;
  cacheDir?: string | null;
  cacheTtlMs?: number;
  politeness?: Politeness;
  politenessDefaults?: HostPolicy;
  hostPolicies?: Record<string, HostPolicy>;
  /** Share the viewer so a handoff can point the human at the live browser. */
  viewer?: ShowViewer | { url: string };
  /** Include `node` and `node+cookies` transports. Default true. */
  useNodeTransports?: boolean;
  userAgent?: string;
  now?: () => Date;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

export class SessionFetcher implements Disposable {
  readonly picker: TransportPicker;
  readonly politeness: Politeness;
  readonly cache: ResponseCache;
  readonly requestLog: RequestLog;
  readonly stats = { requests: 0, cacheHits: 0, retries: 0, handoffs: 0 };
  #session: BrowserSession | undefined;
  #viewer: ShowViewer | { url: string } | undefined;
  #ownsPoliteness: boolean;
  #log: (message: string, data?: Record<string, unknown>) => void;

  constructor(init: {
    picker: TransportPicker;
    politeness: Politeness;
    ownsPoliteness: boolean;
    cache: ResponseCache;
    requestLog: RequestLog;
    session?: BrowserSession;
    viewer?: ShowViewer | { url: string };
    log: (message: string, data?: Record<string, unknown>) => void;
  }) {
    this.picker = init.picker;
    this.politeness = init.politeness;
    this.#ownsPoliteness = init.ownsPoliteness;
    this.cache = init.cache;
    this.requestLog = init.requestLog;
    this.#session = init.session;
    this.#viewer = init.viewer;
    this.#log = init.log;
  }

  [Symbol.dispose](): void {
    if (this.#ownsPoliteness) this.politeness.dispose();
  }

  async fetch(req: SessionFetchRequest): Promise<FetchOutcome> {
    const key = cacheKey({
      url: req.url,
      ...(req.method ? { method: req.method } : {}),
      ...(req.body ? { body: req.body } : {}),
    });
    const host = hostOf(req.url);
    const started = Date.now();

    if (req.cacheTtlMs !== 0) {
      const hit = this.cache.get(key);
      if (hit) {
        this.stats.cacheHits++;
        this.requestLog.append({
          host,
          method: req.method ?? "GET",
          url: req.url,
          transport: "cache",
          status: hit.status,
          verdict: "ok",
          ms: Date.now() - started,
          fromCache: true,
        });
        return {
          status: "ok",
          fromCache: true,
          attempts: 0,
          response: {
            status: hit.status,
            url: hit.url,
            headers: hit.headers,
            body: hit.body,
            transport: hit.transport,
          },
        };
      }
    }

    let outcome: PickOutcome;
    let attempts = 0;
    for (let round = 0; ; round++) {
      try {
        await this.politeness.acquire(req.url, req.signal ? { signal: req.signal } : {});
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          this.requestLog.append({
            host,
            method: req.method ?? "GET",
            url: req.url,
            transport: "cache",
            status: 0,
            verdict: "error",
            challenge: err.reason,
            ms: Date.now() - started,
          });
          return {
            status: "error",
            code: err.reason,
            message: err.message,
            retryable: true,
            attempts,
          };
        }
        throw err;
      }
      this.stats.requests++;
      outcome = await this.picker.fetch(req, req.expect ? { expect: req.expect } : {});
      attempts += outcome.attempts.length;

      if (outcome.ok) break;
      const challenge = outcome.challenge;
      const transientOnce =
        round === 0 && outcome.verdict === "transient" && challenge !== undefined;
      if (!transientOnce) break;
      // Exactly one retry, after the wait the challenge asked for. Never a loop.
      this.stats.retries++;
      this.#log("browser-session: transient challenge, waiting once", {
        host,
        kind: challenge.kind,
        waitMs: challenge.retryAfterMs ?? 5_000,
      });
      await delay(challenge.retryAfterMs ?? 5_000, req.signal ? { signal: req.signal } : {});
    }

    const last = outcome.attempts.at(-1);
    this.requestLog.append({
      host,
      method: req.method ?? "GET",
      url: req.url,
      transport: last?.transport ?? "cache",
      status: last?.status ?? 0,
      verdict: outcome.ok ? "ok" : outcome.verdict,
      ...(outcome.ok ? {} : outcome.challenge ? { challenge: outcome.challenge.kind } : {}),
      ms: Date.now() - started,
      attempts: outcome.attempts.length,
    });

    if (outcome.ok) {
      this.politeness.success(req.url);
      if (req.cacheTtlMs !== 0) this.cache.set(key, outcome.response);
      return { status: "ok", response: outcome.response, fromCache: false, attempts };
    }

    const challenge = outcome.challenge;
    if (!challenge) {
      const message = outcome.attempts
        .map((a) => `${a.transport}: ${a.error ?? a.status}`)
        .join("; ");
      return {
        status: "error",
        code: "transport",
        message: message || "every transport failed",
        retryable: true,
        attempts,
      };
    }

    this.politeness.strike(req.url, challenge.kind);
    // Keep the wall itself for diagnosis; it lives apart from the cache and is never served as an answer.
    if (outcome.lastResponse)
      this.cache.saveChallenge(key, outcome.lastResponse.body, challenge.kind);

    if (outcome.verdict === "needs_human") {
      this.stats.handoffs++;
      const handoff = await prepareHandoff(challenge, {
        ...(this.#session ? { session: this.#session } : {}),
        ...(this.#viewer ? { viewer: this.#viewer } : {}),
        ...(req.goal ? { goal: req.goal } : {}),
      });
      return { status: "needs_human", challenge, result: needsHuman(handoff), attempts };
    }
    return {
      status: "error",
      code: challenge.kind,
      message: `${challenge.message} (${challenge.evidence}, HTTP ${challenge.status})`,
      retryable: true,
      attempts,
    };
  }

  /** `fetch` + `JSON.parse`, the shape most gateways want. */
  async json<T>(req: SessionFetchRequest): Promise<FetchOutcome & { data?: T }> {
    const out = await this.fetch({ accept: "json", ...req });
    if (out.status !== "ok") return out;
    return { ...out, data: JSON.parse(out.response.body) as T };
  }
}

/**
 * The default ladder for a session: plain Node fetch, then Node fetch with the profile's cookies,
 * then the browser's in-page fetch.
 */
export function createSessionFetcher(
  session: BrowserSession,
  opts: SessionFetcherOptions = {},
): SessionFetcher {
  const log = opts.log ?? (() => {});
  const transports = opts.transports ?? [
    ...(opts.useNodeTransports === false
      ? []
      : [
          new NodeTransport(opts.userAgent ? { userAgent: opts.userAgent } : {}),
          new ProfileCookieTransport(session, opts.userAgent ? { userAgent: opts.userAgent } : {}),
        ]),
    new InPageTransport(session, opts.warmUp ? { warmUp: opts.warmUp } : {}),
  ];

  const cacheDir =
    opts.cacheDir === undefined ? join(session.paths.httpCacheDir, "responses") : opts.cacheDir;
  const stateDir = session.paths.httpCacheDir;
  const politeness =
    opts.politeness ??
    new Politeness({
      file: opts.cacheDir === null ? null : join(stateDir, "budget.json"),
      ...(opts.politenessDefaults ? { defaults: opts.politenessDefaults } : {}),
      ...(opts.hostPolicies ? { hosts: opts.hostPolicies } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      log,
    });

  return new SessionFetcher({
    picker: new TransportPicker({
      transports,
      memoryFile: opts.cacheDir === null ? null : join(stateDir, "transports.json"),
      ...(opts.now ? { now: opts.now } : {}),
      log,
    }),
    politeness,
    ownsPoliteness: opts.politeness === undefined,
    cache: new ResponseCache(
      cacheDir,
      opts.cacheTtlMs ?? 30 * 60_000,
      opts.now ?? (() => new Date()),
    ),
    requestLog: new RequestLog(opts.cacheDir === null ? null : join(stateDir, "requests.jsonl"), {
      session: session.name,
    }),
    session,
    ...(opts.viewer ? { viewer: opts.viewer } : {}),
    log,
  });
}
