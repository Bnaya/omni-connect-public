/**
 * Three ways to reach a site, behind one interface, so a connector can choose per call instead of
 * per codebase. Yad2 and Facebook each grew their own copy of exactly these three; this is the
 * third time, so it lives here.
 *
 *   node          plain Node `fetch`. Cheapest and the only one that works without a browser.
 *   node+cookies  Node `fetch` carrying the live profile's cookies, read out of the session and
 *                 kept **in memory only**. Good when the site checks the session but not the
 *                 browser fingerprint.
 *   in-page       `fetch()` inside the live page: cookies, TLS/HTTP2 fingerprint, headers and
 *                 origin are the browser's. The dependable path past Radware, and the expensive one.
 *
 * Transports do not retry, log in, solve CAPTCHAs or rate-limit. That is `politeness.ts` and
 * `fetcher.ts`.
 */
import type { BrowserSession, Cookie } from "./session.ts";

export type TransportName = "node" | "node+cookies" | "in-page" | "fixture";

export type TransportRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Shapes the default `accept` header and `detectChallenge`'s expectations. */
  accept?: "json" | "html" | "any";
  /** Navigate the live page here first (in-page transport only). */
  warmUpUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type TransportResponse = {
  status: number;
  /** Final URL (after redirects) when the transport knows it, else the requested URL. */
  url: string;
  headers: Record<string, string>;
  body: string;
  transport: TransportName;
};

export interface Transport {
  readonly name: TransportName;
  /** Rough relative cost, cheapest first. Drives `pick`'s default order. */
  readonly cost: number;
  /** Rejects only when the transport itself failed; an HTTP error is a normal response. */
  fetch(req: TransportRequest): Promise<TransportResponse>;
}

export class TransportError extends Error {
  override name = "TransportError";
  transport: TransportName;
  constructor(transport: TransportName, message: string, options?: { cause?: unknown }) {
    super(`${transport}: ${message}`, options);
    this.transport = transport;
  }
}

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

function acceptHeader(accept: TransportRequest["accept"]): string {
  if (accept === "json") return "application/json, text/plain, */*";
  if (accept === "html") return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  return "*/*";
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    // Set-Cookie is deliberately left out of the plain object: see `cookieJar`.
    if (key.toLowerCase() !== "set-cookie") out[key.toLowerCase()] = value;
  });
  return out;
}

export type NodeTransportOptions = {
  userAgent?: string;
  acceptLanguage?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Follow redirects (default) or report the 3xx, which makes login redirects visible. */
  redirect?: "follow" | "manual" | "error";
};

/** A tiny in-memory cookie jar. Values never touch disk. */
export class CookieJar {
  #jar = new Map<string, string>();

  get size(): number {
    return this.#jar.size;
  }
  get names(): string[] {
    return [...this.#jar.keys()];
  }
  clear(): void {
    this.#jar.clear();
  }
  setAll(cookies: Iterable<Pick<Cookie, "name" | "value">>): void {
    for (const c of cookies) this.#jar.set(c.name, c.value);
  }
  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) this.#jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header(): string | undefined {
    if (this.#jar.size === 0) return undefined;
    return [...this.#jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** Plain Node `fetch`. No cookies unless a jar is handed in. */
export class NodeTransport implements Transport {
  readonly name: TransportName = "node";
  readonly cost = 1;
  readonly jar: CookieJar;
  #opts: NodeTransportOptions;
  #fetch: typeof fetch;

  constructor(opts: NodeTransportOptions = {}, jar: CookieJar = new CookieJar()) {
    this.#opts = opts;
    this.#fetch = opts.fetch ?? fetch;
    this.jar = jar;
  }

  async fetch(req: TransportRequest): Promise<TransportResponse> {
    const timeoutMs = req.timeoutMs ?? this.#opts.timeoutMs ?? 20_000;
    const signals = [AbortSignal.timeout(timeoutMs), ...(req.signal ? [req.signal] : [])];
    const cookie = this.jar.header();
    let res: Response;
    try {
      res = await this.#fetch(req.url, {
        method: req.method ?? "GET",
        ...(req.body === undefined ? {} : { body: req.body }),
        redirect: this.#opts.redirect ?? "follow",
        signal: AbortSignal.any(signals),
        headers: {
          "user-agent": this.#opts.userAgent ?? DEFAULT_USER_AGENT,
          accept: acceptHeader(req.accept),
          "accept-language": this.#opts.acceptLanguage ?? "he-IL,he;q=0.9,en;q=0.8",
          ...(cookie ? { cookie } : {}),
          ...this.#opts.headers,
          ...req.headers,
        },
      });
    } catch (err) {
      throw new TransportError(this.name, (err as Error).message, { cause: err });
    }
    this.jar.absorb(res);
    return {
      status: res.status,
      url: res.url || req.url,
      headers: headersToObject(res.headers),
      body: await res.text(),
      transport: this.name,
    };
  }
}

export type ProfileCookieTransportOptions = NodeTransportOptions & {
  /** Re-read the cookies from the live profile after this long. Default 5 min. */
  refreshAfterMs?: number;
  /** Which origin's cookies to read. Default: the request's own origin. */
  cookieUrl?: string;
};

/**
 * Node `fetch` with the browser profile's cookies. The cookies are read out of the live session on
 * demand, held in memory, and never written to disk (they *are* the login).
 */
export class ProfileCookieTransport implements Transport {
  readonly name: TransportName = "node+cookies";
  readonly cost = 2;
  readonly jar: CookieJar;
  #session: BrowserSession;
  #node: NodeTransport;
  #opts: ProfileCookieTransportOptions;
  #loadedAt = 0;
  #loadedFor = "";

  constructor(session: BrowserSession, opts: ProfileCookieTransportOptions = {}) {
    this.#session = session;
    this.#opts = opts;
    this.jar = new CookieJar();
    this.#node = new NodeTransport(opts, this.jar);
  }

  /** Pull the cookies out of the live profile again (after a re-login, say). */
  async refresh(forUrl?: string): Promise<string[]> {
    const url = this.#opts.cookieUrl ?? forUrl;
    const cookies = await this.#session.cookies(url);
    this.jar.clear();
    this.jar.setAll(cookies);
    this.#loadedAt = Date.now();
    this.#loadedFor = url ?? "";
    return this.jar.names;
  }

  async fetch(req: TransportRequest): Promise<TransportResponse> {
    const url = this.#opts.cookieUrl ?? new URL(req.url).origin;
    const stale =
      this.jar.size === 0 ||
      this.#loadedFor !== url ||
      Date.now() - this.#loadedAt > (this.#opts.refreshAfterMs ?? 5 * 60_000);
    if (stale) await this.refresh(url);
    const res = await this.#node.fetch(req);
    return { ...res, transport: this.name };
  }
}

export type InPageTransportOptions = {
  /** Page to navigate to before fetching from a given host, e.g. gw.yad2.co.il → the www search page. */
  warmUp?: Record<string, string>;
  headers?: Record<string, string>;
};

/** `fetch()` inside the live page. The expensive, dependable one. */
export class InPageTransport implements Transport {
  readonly name: TransportName = "in-page";
  readonly cost = 3;
  readonly session: BrowserSession;
  #opts: InPageTransportOptions;

  constructor(session: BrowserSession, opts: InPageTransportOptions = {}) {
    this.session = session;
    this.#opts = opts;
  }

  async fetch(req: TransportRequest): Promise<TransportResponse> {
    const host = new URL(req.url).hostname;
    const warmUpUrl = req.warmUpUrl ?? this.#opts.warmUp?.[host];
    const res = await this.session.pageFetch({
      url: req.url,
      ...(req.method ? { method: req.method } : {}),
      ...(req.body === undefined ? {} : { body: req.body }),
      headers: { accept: acceptHeader(req.accept), ...this.#opts.headers, ...req.headers },
      ...(warmUpUrl ? { warmUpUrl } : {}),
      ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
    });
    return { ...res, transport: this.name };
  }
}
