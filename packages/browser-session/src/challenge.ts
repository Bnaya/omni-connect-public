/**
 * "Is this a real answer, a bot wall, or a session that quietly went stale?"
 *
 * This is the state machine `docs/research/openclaw-and-skill-ecosystems.md` §5.9 asked for:
 * Israel Post and Yad2 sit behind the same vendor (Radware/ShieldSquare), and AliExpress-style
 * scraped cookies expire *silently*, so a connector must be able to say "session stale →
 * needs_human" instead of reporting "no results".
 *
 * Two outcomes matter:
 * - **transient**: a JS interstitial, a 429, a 5xx. A real browser usually passes these by itself,
 *   so wait once and retry once. Never loop.
 * - **needs_human**: a CAPTCHA, a login wall, an expired session, an IP-level block. We stop,
 *   screenshot, keep the browser alive and hand off (guide §9). We never guess through these.
 *
 * Detection is deliberately string-matching over the response body: it has to work offline against
 * saved HTML, and the vendors' markers are stable (they are the product's own asset names).
 */
import type { Handoff, HandoffKind, NeedsHuman } from "@omni/core";
import { needsHuman as toNeedsHumanResult } from "@omni/core";

export type ChallengeKind =
  /** Radware/ShieldSquare "Bot Manager Captcha" — a human must solve it. */
  | "radware_captcha"
  /** Radware's silent JS check ("Verifying your browser"); a real headed browser passes it. */
  | "radware_jscheck"
  /** Cloudflare "Just a moment…" / managed challenge. */
  | "cloudflare_interstitial"
  /** Cloudflare 1020 / "Attention Required" — the IP or ASN is refused. */
  | "cloudflare_blocked"
  | "akamai_denied"
  | "incapsula"
  | "perimeterx"
  | "datadome"
  /** A CAPTCHA widget with no identifiable vendor wall around it. */
  | "captcha"
  /** The site served its login page instead of the thing we asked for. */
  | "login_wall"
  /** We sent a logged-in profile's cookies and got a login page / 401 back. */
  | "session_expired"
  | "rate_limited"
  /** 403 with no vendor fingerprint: usually the egress IP (datacenter/VPN) or a missing fingerprint. */
  | "forbidden"
  | "server_error"
  /** The transport itself failed (in-page fetch threw, DNS, TLS). */
  | "transport_error";

export type Challenge = {
  kind: ChallengeKind;
  /** The marker that matched. Safe to log: never a cookie, token or credential. */
  evidence: string;
  /** Vendor reference a human may need to quote (Radware Transaction ID, Akamai Reference, CF Ray). */
  reference?: string;
  status: number;
  url?: string;
  /** How long to wait before the single retry a transient challenge deserves. */
  retryAfterMs?: number;
  /** How core should present this to the human (only meaningful for needs_human). */
  handoffKind: HandoffKind;
  /** One line for the human. */
  message: string;
};

export type Verdict =
  | { kind: "ok" }
  /** Wait `challenge.retryAfterMs` and retry **once**. */
  | { kind: "transient"; challenge: Challenge }
  /** Stop. Screenshot, keep the session alive, hand off. */
  | { kind: "needs_human"; challenge: Challenge };

export type DetectInput = {
  status: number;
  body: string;
  url?: string;
  /** Final URL after redirects, when the transport followed them. */
  finalUrl?: string;
  headers?: Record<string, string> | Headers | undefined;
  /**
   * `"authenticated"` means "we sent a logged-in profile's cookies and expect data". A login page
   * or a 401 then means the stored session went stale — the silent-cookie-expiry case — and that is
   * a `needs_human` login handoff, not a transient challenge.
   */
  expect?: "any" | "json" | "html" | "authenticated";
};

function headerValue(headers: DetectInput["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function")
    return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string>;
  const hit = Object.keys(record).find((k) => k.toLowerCase() === name);
  return hit ? record[hit] : undefined;
}

/** `Retry-After` in ms (seconds or HTTP-date), or undefined. */
export function parseRetryAfter(
  headers: DetectInput["headers"],
  now: number = Date.now(),
): number | undefined {
  const raw = headerValue(headers, "retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

const ok = (): Verdict => ({ kind: "ok" });

function transient(c: Omit<Challenge, "handoffKind"> & { handoffKind?: HandoffKind }): Verdict {
  return { kind: "transient", challenge: { handoffKind: "question", ...c } };
}
function human(c: Challenge): Verdict {
  return { kind: "needs_human", challenge: c };
}

// ---------------------------------------------------------------------------
// Vendor fingerprints
// ---------------------------------------------------------------------------

/** Radware/ShieldSquare. `perfdrive.com` is their CDN; `__uzdbm_*` their cookies/vars. */
const RADWARE_ANY = [
  "Radware Bot Manager",
  "Bot Manager Captcha",
  "Are you for real",
  "perfdrive.com",
  "__uzdbm_",
  "ShieldSquare",
  "SSJSConnector",
  "shieldsquare.com",
];
const RADWARE_CAPTCHA = [
  "Bot Manager Captcha",
  "Are you for real",
  "cf_input",
  "hcaptcha",
  "px-captcha",
];
const JS_CHECK = [
  "Verifying your browser",
  "Checking your browser",
  "Please wait while we verify",
  "JavaScript is required to continue",
  "Enable JavaScript and cookies to continue",
];

const CF_INTERSTITIAL = [
  "Just a moment...",
  "cf-browser-verification",
  "cf_chl_opt",
  "/cdn-cgi/challenge-platform",
  "challenge-platform/h/b/orchestrate",
];
const CF_BLOCKED = [
  "Attention Required! | Cloudflare",
  "Error 1020",
  "error code: 1020",
  "Sorry, you have been blocked",
  "cf-error-details",
  "Access denied | ",
];
const TURNSTILE = ["challenges.cloudflare.com/turnstile", "cf-turnstile"];
const CAPTCHA_WIDGETS = [
  "g-recaptcha",
  "recaptcha/api.js",
  "www.google.com/recaptcha",
  "hcaptcha.com/1/api.js",
  "h-captcha",
  "geo.captcha-delivery.com",
  "funcaptcha",
  "arkoselabs.com",
];
const AKAMAI = [
  "Reference&#32;#",
  "Reference #",
  "akamai",
  "AkamaiGHost",
  "You don't have permission to access",
];
const INCAPSULA = ["_Incapsula_Resource", "Incapsula incident ID", "imperva.com"];
const PERIMETERX = ["_pxhd", "px-captcha", "perimeterx", "/px/captcha"];
const DATADOME = ["datadome", "dd_cookie_test", "captcha-delivery.com"];

const LOGIN_MARKERS = [
  "LoginCometRoot",
  "loginform",
  "login_form",
  'id="loginbutton"',
  "Log in to continue",
  "Log In or Sign Up",
  "Sign in to continue",
  "Please log in",
  "התחברות לחשבון",
  "אנא התחבר",
];
const LOGIN_URL_RE =
  /\/(?:login|log-in|signin|sign-in|sign_in|auth\/login|account\/login|checkpoint)\b/i;

/** JSON error payloads that mean "your cookies are no longer a session". */
const JSON_STALE_RE =
  /"(?:error|err|code|errorCode|msg|message|ret)"\s*:\s*"?(?:[^"]*?)(?:unauthori[sz]ed|unauthenticated|not[-_ ]?log(?:ged)?[-_ ]?in|login[-_ ]?required|need[-_ ]?login|session[-_ ]?expired|token[-_ ]?expired|invalid[-_ ]?token)/i;
/** AliExpress/Taobao MTOP is explicit about it, and worth matching by name. */
const MTOP_STALE_RE =
  /FAIL_SYS_(?:SESSION_EXPIRED|TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED|ILLEGAL_ACCESS)/;
/** Facebook's "we want a security check" GraphQL code, seen on anonymous pagination. */
const FB_CHALLENGE_RE = /"code"\s*:\s*1675004/;

function firstMatch(body: string, markers: string[]): string | undefined {
  for (const m of markers) if (body.includes(m)) return m;
  return undefined;
}

/** Radware prints a Transaction ID for support; Akamai a Reference #; Cloudflare a Ray ID. */
export function extractReference(
  body: string,
  headers?: DetectInput["headers"],
): string | undefined {
  const tx = /Transaction\s*ID:?\s*(?:<\/[a-z0-9]+>)?\s*([a-f0-9-]{12,})/i.exec(body)?.[1];
  if (tx) return `radware-tx:${tx}`;
  const digest = /Captcha\s*Digest:?\s*(?:<[^>]+>)?\s*([0-9a-z-]{8,})/i.exec(body)?.[1];
  if (digest) return `radware-digest:${digest}`;
  const uz = /__uzdbm_1\s*=\s*"([0-9a-z-]{8,})"/i.exec(body)?.[1];
  if (uz) return `radware-uzdbm:${uz}`;
  const ref = /Reference\s*(?:&#32;)?#\s*([0-9a-f.]{6,})/i.exec(body)?.[1];
  if (ref) return `akamai-ref:${ref}`;
  const inc = /Incapsula incident ID:?\s*([0-9A-Za-z-]+)/i.exec(body)?.[1];
  if (inc) return `incapsula:${inc}`;
  const ray = headerValue(headers, "cf-ray");
  if (ray) return `cf-ray:${ray}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Classify one response. Order matters: a well-formed JSON body is an answer whatever words it
 * contains, vendor walls are checked before plain status codes (Radware answers **HTTP 200**), and
 * the authenticated-vs-anonymous distinction is what turns a login page into "session stale".
 */
export function detectChallenge(input: DetectInput): Verdict {
  const { status, body } = input;
  const url = input.finalUrl ?? input.url;
  const authed = input.expect === "authenticated";
  const reference = extractReference(body, input.headers);
  const retryAfterMs = parseRetryAfter(input.headers);
  const base = { status, ...(url ? { url } : {}), ...(reference ? { reference } : {}) };

  // 0. The transport never got an answer.
  if (status === 0) {
    return transient({
      ...base,
      kind: "transport_error",
      evidence: body.slice(0, 200) || "no response",
      retryAfterMs: retryAfterMs ?? 2_000,
      message:
        "The request did not complete (in-page fetch threw, DNS/TLS, or the page was navigating).",
    });
  }

  // 1. JSON is a real answer — unless it is an auth error.
  const head = body.trimStart()[0];
  const looksJson = head === "{" || head === "[";
  if (looksJson) {
    if (MTOP_STALE_RE.test(body) || (authed && JSON_STALE_RE.test(body)) || status === 401) {
      return human({
        ...base,
        kind: "session_expired",
        handoffKind: "login",
        evidence:
          MTOP_STALE_RE.exec(body)?.[0] ?? JSON_STALE_RE.exec(body)?.[0] ?? `HTTP ${status}`,
        message:
          "The site answered with an auth error, so the saved browser session is no longer valid. A human needs to log in again in the live profile.",
      });
    }
    if (FB_CHALLENGE_RE.test(body)) {
      return human({
        ...base,
        kind: "captcha",
        handoffKind: "captcha",
        evidence: "graphql code 1675004",
        message: "Facebook answered with a security-check error (1675004) instead of data.",
      });
    }
    if (status >= 500) {
      return transient({
        ...base,
        kind: "server_error",
        evidence: `HTTP ${status} with a JSON body`,
        retryAfterMs: retryAfterMs ?? 3_000,
        message: `The site returned HTTP ${status}.`,
      });
    }
    if (status === 429) return rateLimited(base, retryAfterMs);
    return ok();
  }

  // 2. Vendor walls (these often come back with HTTP 200).
  const radware = firstMatch(body, RADWARE_ANY);
  if (radware) {
    const captchaMarker = firstMatch(body, RADWARE_CAPTCHA);
    if (captchaMarker) {
      return human({
        ...base,
        kind: "radware_captcha",
        handoffKind: "captcha",
        evidence: captchaMarker,
        message:
          "Radware/ShieldSquare Bot Manager served a CAPTCHA. Only a human can solve it, in the live browser.",
      });
    }
    return transient({
      ...base,
      kind: "radware_jscheck",
      evidence: radware,
      retryAfterMs: retryAfterMs ?? 5_000,
      message:
        "Radware/ShieldSquare is running its JavaScript check. A real headed browser usually passes it on its own; wait and retry once.",
    });
  }

  const cfBlocked = firstMatch(body, CF_BLOCKED);
  if (cfBlocked) {
    return human({
      ...base,
      kind: "cloudflare_blocked",
      handoffKind: "question",
      evidence: cfBlocked,
      message:
        "Cloudflare refused the request outright (not a solvable challenge). Usually the egress IP or ASN: a residential/home IP is needed.",
    });
  }
  const turnstile = firstMatch(body, TURNSTILE);
  const cfInterstitial = firstMatch(body, CF_INTERSTITIAL);
  if (turnstile && !cfInterstitial) {
    return human({
      ...base,
      kind: "captcha",
      handoffKind: "captcha",
      evidence: turnstile,
      message: "A Cloudflare Turnstile widget is in the way; a human has to clear it.",
    });
  }
  if (cfInterstitial) {
    return transient({
      ...base,
      kind: "cloudflare_interstitial",
      evidence: cfInterstitial,
      retryAfterMs: retryAfterMs ?? 5_000,
      message: "Cloudflare is showing its browser-check interstitial; wait and retry once.",
    });
  }

  const incapsula = firstMatch(body, INCAPSULA);
  if (incapsula) {
    return human({
      ...base,
      kind: "incapsula",
      handoffKind: "question",
      evidence: incapsula,
      message: "Imperva/Incapsula blocked the request.",
    });
  }
  const px = firstMatch(body, PERIMETERX);
  if (px) {
    return human({
      ...base,
      kind: "perimeterx",
      handoffKind: "captcha",
      evidence: px,
      message: "PerimeterX/HUMAN put a challenge in the way.",
    });
  }
  const dd = firstMatch(body, DATADOME);
  if (dd) {
    return human({
      ...base,
      kind: "datadome",
      handoffKind: "captcha",
      evidence: dd,
      message: "DataDome put a challenge in the way.",
    });
  }
  // Akamai only counts when it looks like its denial page, not any page served over Akamai.
  if (/access denied/i.test(body) || status === 403) {
    const akamai = firstMatch(body, AKAMAI);
    if (akamai && /access denied|permission to access/i.test(body)) {
      return human({
        ...base,
        kind: "akamai_denied",
        handoffKind: "question",
        evidence: akamai,
        message:
          "Akamai returned its Access Denied page. Quote the reference to the site owner, or try from a different (residential) IP.",
      });
    }
  }
  const widget = firstMatch(body, CAPTCHA_WIDGETS);
  if (widget && !looksJson && /captcha|verify|are you a human|robot/i.test(body)) {
    return human({
      ...base,
      kind: "captcha",
      handoffKind: "captcha",
      evidence: widget,
      message: "A CAPTCHA widget is in the way; a human has to solve it.",
    });
  }
  const jsCheck = firstMatch(body, JS_CHECK);
  if (jsCheck) {
    return transient({
      ...base,
      kind: "radware_jscheck",
      evidence: jsCheck,
      retryAfterMs: retryAfterMs ?? 5_000,
      message: "An anti-bot JavaScript check is in the way; wait and retry once in a real browser.",
    });
  }

  // 3. Login walls, and the same page seen with a logged-in profile = stale session.
  const loginUrl = url !== undefined && LOGIN_URL_RE.test(url);
  const locationHeader = headerValue(input.headers, "location");
  const redirectToLogin =
    status >= 300 &&
    status < 400 &&
    locationHeader !== undefined &&
    LOGIN_URL_RE.test(locationHeader);
  const loginMarker = firstMatch(body, LOGIN_MARKERS);
  const passwordForm = /<input[^>]+type=["']?password/i.test(body);
  if (status === 401 || loginUrl || redirectToLogin || loginMarker || (passwordForm && !authed)) {
    const evidence =
      status === 401
        ? "HTTP 401"
        : redirectToLogin
          ? `redirect to ${locationHeader}`
          : loginUrl
            ? `landed on ${url}`
            : (loginMarker ?? "a password field");
    return human({
      ...base,
      kind: authed || status === 401 ? "session_expired" : "login_wall",
      handoffKind: "login",
      evidence,
      message:
        authed || status === 401
          ? "The site served a login page although we used the logged-in profile: the stored session went stale. A human must log in again in the live browser."
          : "The site wants a login before it shows this. A human must log in once in the live browser; after that the profile keeps the session.",
    });
  }

  // 4. Plain status codes.
  if (status === 429) return rateLimited(base, retryAfterMs);
  if (status === 403) {
    return human({
      ...base,
      kind: "forbidden",
      handoffKind: "question",
      evidence: "HTTP 403 with no vendor fingerprint",
      message:
        "The site answered 403. Most often the egress IP (datacenter/VPN/CI) is not trusted, or the request lacked a real browser's fingerprint.",
    });
  }
  if (status >= 500) {
    return transient({
      ...base,
      kind: "server_error",
      evidence: `HTTP ${status}`,
      retryAfterMs: retryAfterMs ?? 3_000,
      message: `The site returned HTTP ${status}.`,
    });
  }
  if (input.expect === "json" && body.trim() !== "" && !looksJson) {
    return transient({
      ...base,
      kind: "transport_error",
      evidence: `expected JSON, got ${JSON.stringify(body.trimStart().slice(0, 60))}`,
      retryAfterMs: retryAfterMs ?? 2_000,
      message:
        "We asked for JSON and got something else; the site may be serving an interstitial we do not recognise.",
    });
  }
  return ok();
}

function rateLimited(
  base: { status: number; url?: string; reference?: string },
  retryAfterMs: number | undefined,
): Verdict {
  return transient({
    ...base,
    kind: "rate_limited",
    evidence: retryAfterMs === undefined ? "HTTP 429" : `HTTP 429, Retry-After ${retryAfterMs} ms`,
    retryAfterMs: retryAfterMs ?? 60_000,
    message: "The site is rate-limiting us. Back off; do not retry in a loop.",
  });
}

/** True when the verdict says the stored login is no longer usable. */
export function isSessionStale(verdict: Verdict): boolean {
  return (
    verdict.kind === "needs_human" &&
    (verdict.challenge.kind === "session_expired" || verdict.challenge.kind === "login_wall")
  );
}

export type HandoffExtras = {
  /** What the connector was trying to do, in the human's words. */
  goal?: string;
  screenshotPath?: string;
  /** `playwright-cli show` URL (see handoff.ts). Never a pre-authenticated URL. */
  liveSessionUrl?: string;
  pageUrl?: string;
  session?: string;
};

/** Turn a challenge into core's `Handoff`, filled in the shape guide §9 asks for. */
export function challengeToHandoff(challenge: Challenge, extras: HandoffExtras = {}): Handoff {
  const where = extras.pageUrl ?? challenge.url;
  const bestGuess = [
    challenge.message,
    `Detected: ${challenge.kind} (${challenge.evidence}, HTTP ${challenge.status})`,
    challenge.reference ? `Vendor reference: ${challenge.reference}` : undefined,
    extras.session ? `Live session: playwright-cli -s=${extras.session} show` : undefined,
  ]
    .filter((s) => s !== undefined)
    .join(" ");
  const handoff: Handoff = {
    kind: challenge.handoffKind,
    message: extras.goal
      ? `${challenge.message} (while trying to ${extras.goal})`
      : challenge.message,
    bestGuess,
  };
  if (extras.screenshotPath) handoff.screenshotPath = extras.screenshotPath;
  if (where) handoff.pageUrl = where;
  if (extras.liveSessionUrl) handoff.liveSessionUrl = extras.liveSessionUrl;
  return handoff;
}

/** `needs_human` operation result, ready to return from a connector operation. */
export function challengeToResult(challenge: Challenge, extras: HandoffExtras = {}): NeedsHuman {
  return toNeedsHumanResult(challengeToHandoff(challenge, extras));
}
