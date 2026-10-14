/**
 * "Try the cheap way first, and remember what actually worked for this host."
 *
 * Yad2 learned that plain Node fetch gets one answer and then a Radware challenge, while the
 * browser's in-page fetch keeps working; Facebook learned that page 1 works over Node but
 * pagination needs the browser. Both learned it by hand, in prose, in a NOTES.md. This records it
 * per host at runtime instead, so the first call pays for the discovery and the rest do not.
 *
 * The memory is a preference, never a cage: a remembered transport that starts failing is dropped
 * and the ladder is climbed again.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Challenge, Verdict } from "./challenge.ts";
import { detectChallenge } from "./challenge.ts";
import { hostOf } from "./paths.ts";
import type {
  Transport,
  TransportName,
  TransportRequest,
  TransportResponse,
} from "./transports.ts";
import { TransportError } from "./transports.ts";

export type Attempt = {
  transport: TransportName;
  status: number;
  verdict: Verdict["kind"] | "error";
  challenge?: Challenge;
  error?: string;
  ms: number;
};

export type PickOutcome =
  | { ok: true; response: TransportResponse; attempts: Attempt[] }
  /** Nothing worked. `challenge` is the most informative one seen (needs_human beats transient). */
  | {
      ok: false;
      challenge: Challenge | undefined;
      verdict: Verdict["kind"] | "error";
      attempts: Attempt[];
      /** The last response we got, so the caller can keep the wall itself for diagnosis. */
      lastResponse?: TransportResponse;
    };

export type HostMemory = {
  transport: TransportName;
  updatedAt: string;
  successes: number;
  failures: number;
};

export type PickerOptions = {
  transports: Transport[];
  /** JSON file for the per-host memory, so it survives process restarts. null = memory only. */
  memoryFile?: string | null;
  /** Drop a remembered transport after this many consecutive failures. Default 2. */
  forgetAfterFailures?: number;
  now?: () => Date;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

/**
 * Tries transports cheapest-first (or the remembered one first) and returns the first response that
 * `detectChallenge` calls `ok`. A transient challenge is *not* retried here — that is the
 * fetcher's single, deliberate retry; here it only means "try the next transport".
 */
export class TransportPicker {
  readonly transports: Transport[];
  #memory = new Map<string, HostMemory>();
  #file: string | null;
  #forgetAfter: number;
  #now: () => Date;
  #log: (message: string, data?: Record<string, unknown>) => void;

  constructor(opts: PickerOptions) {
    this.transports = [...opts.transports].sort((a, b) => a.cost - b.cost);
    this.#file = opts.memoryFile ?? null;
    this.#forgetAfter = opts.forgetAfterFailures ?? 2;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? (() => {});
    this.#load();
  }

  #load(): void {
    if (!this.#file) return;
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8")) as Record<string, HostMemory>;
      for (const [host, entry] of Object.entries(raw)) {
        if (entry && typeof entry.transport === "string") this.#memory.set(host, entry);
      }
    } catch {
      // no memory yet
    }
  }

  #save(): void {
    if (!this.#file) return;
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(this.#memory), null, 2)}\n`);
      renameSync(tmp, this.#file);
    } catch {
      // the memory is an optimisation; never fail a request over it
    }
  }

  /** What worked last time for this host. */
  preferred(host: string): TransportName | undefined {
    return this.#memory.get(host)?.transport;
  }

  memory(): Record<string, HostMemory> {
    return Object.fromEntries(this.#memory);
  }

  forget(host: string): void {
    this.#memory.delete(host);
    this.#save();
  }

  /** Cheapest-first, with the remembered transport pulled to the front. */
  order(host: string): Transport[] {
    const preferred = this.preferred(host);
    if (!preferred) return this.transports;
    const hit = this.transports.find((t) => t.name === preferred);
    if (!hit) return this.transports;
    return [hit, ...this.transports.filter((t) => t !== hit)];
  }

  #remember(host: string, transport: TransportName, outcome: "success" | "failure"): void {
    const current = this.#memory.get(host);
    const at = this.#now().toISOString();
    if (outcome === "success") {
      this.#memory.set(host, {
        transport,
        updatedAt: at,
        successes: (current?.transport === transport ? current.successes : 0) + 1,
        failures: 0,
      });
      this.#save();
      return;
    }
    if (!current || current.transport !== transport) return;
    const failures = current.failures + 1;
    if (failures >= this.#forgetAfter) {
      this.#log("browser-session: forgetting a transport preference", {
        host,
        transport,
        failures,
      });
      this.#memory.delete(host);
    } else {
      this.#memory.set(host, { ...current, failures, updatedAt: at });
    }
    this.#save();
  }

  async fetch(
    req: TransportRequest,
    opts: { expect?: "any" | "json" | "html" | "authenticated" } = {},
  ): Promise<PickOutcome> {
    const host = hostOf(req.url);
    const attempts: Attempt[] = [];
    let worst: Challenge | undefined;
    let worstKind: Verdict["kind"] | "error" = "error";
    let lastResponse: TransportResponse | undefined;

    for (const transport of this.order(host)) {
      const started = Date.now();
      try {
        const response = await transport.fetch(req);
        lastResponse = response;
        const verdict = detectChallenge({
          status: response.status,
          body: response.body,
          url: req.url,
          finalUrl: response.url,
          headers: response.headers,
          expect: opts.expect ?? (req.accept === "json" ? "json" : "any"),
        });
        attempts.push({
          transport: transport.name,
          status: response.status,
          verdict: verdict.kind,
          ...(verdict.kind === "ok" ? {} : { challenge: verdict.challenge }),
          ms: Date.now() - started,
        });
        if (verdict.kind === "ok") {
          this.#remember(host, transport.name, "success");
          return { ok: true, response, attempts };
        }
        this.#remember(host, transport.name, "failure");
        if (
          worst === undefined ||
          (worstKind !== "needs_human" && verdict.kind === "needs_human")
        ) {
          worst = verdict.challenge;
          worstKind = verdict.kind;
        }
        // A login wall or an expired session will look the same from every transport.
        if (verdict.kind === "needs_human" && isTerminal(verdict.challenge)) break;
      } catch (err) {
        const message = err instanceof TransportError ? err.message : String(err);
        attempts.push({
          transport: transport.name,
          status: 0,
          verdict: "error",
          error: message,
          ms: Date.now() - started,
        });
        this.#remember(host, transport.name, "failure");
        if (req.signal?.aborted) throw err;
      }
    }
    return {
      ok: false,
      challenge: worst,
      verdict: worst ? worstKind : "error",
      attempts,
      ...(lastResponse ? { lastResponse } : {}),
    };
  }
}

/** Challenges that no other transport will dodge: the site knows who we are (or are not). */
function isTerminal(challenge: Challenge): boolean {
  return (
    challenge.kind === "login_wall" ||
    challenge.kind === "session_expired" ||
    challenge.kind === "cloudflare_blocked" ||
    challenge.kind === "akamai_denied"
  );
}
