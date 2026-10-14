/**
 * Operation results. DRAFT.
 *
 * Every operation returns one of three shapes. "Needs a human" is a normal,
 * first-class outcome, not an exception: logins, OTPs, CAPTCHAs, "is this the
 * right button?" and "are you sure you want to message this seller?" all end up
 * here. Adapters translate it: MCP -> `input_required` (elicitation form/url
 * mode) or a text result with a screenshot; CLI -> exit code 3 and a prompt;
 * skill -> JSON on stdout that the agent relays to the user.
 */

export type OperationResult<T> = Ok<T> | NeedsHuman | Failed;

export type Ok<T> = {
  status: "ok";
  data: T;
  /** Free-form info for the caller (timings, backend used, cache hit, diff…). */
  meta?: ResultMeta;
};

export type ResultMeta = {
  /** Which backend actually served the call. */
  backend?: "api" | "browser" | "cache";
  /** Snapshot id written for this call, when the operation declares `snapshot`. */
  snapshotId?: number;
  /** Diff against the previous snapshot of the same scope. */
  diff?: unknown;
  [key: string]: unknown;
};

export type Failed = {
  status: "error";
  error: {
    /** Stable machine code, e.g. "invalid_input", "rate_limited", "not_found", "upstream". */
    code: string;
    message: string;
    /** True when retrying later may succeed (rate limit, network). */
    retryable?: boolean;
    details?: unknown;
  };
};

/**
 * What kind of help is needed. Drives how an adapter presents it.
 * - credentials: a secret is missing. Never ask for the value in chat; tell the human
 *   which env var / secret-store key to set.
 * - login: a human must complete a login in the live browser (SSO, 2FA page).
 * - otp: a one-time code is needed (until the owner's OTP fetcher exists).
 * - captcha: a CAPTCHA or bot wall appeared.
 * - confirm: an action with side effects needs explicit approval.
 * - question: the agent is unsure and asks a question (with a best guess).
 */
export type HandoffKind = "credentials" | "login" | "otp" | "captcha" | "confirm" | "question";

export type NeedsHuman = {
  status: "needs_human";
  handoff: Handoff;
};

export type Handoff = {
  kind: HandoffKind;
  /** One or two sentences for the human. */
  message: string;
  /** The agent's best guess of what is going on / what to do. */
  bestGuess?: string;
  /** Local path to a screenshot (under `.local/screenshots/`). */
  screenshotPath?: string;
  /** Page the browser is on. */
  pageUrl?: string;
  /**
   * Where the human can watch/steer the live browser (e.g. a `playwright-cli show`
   * dashboard reachable over Tailscale). Never a pre-authenticated URL.
   */
  liveSessionUrl?: string;
  /**
   * Non-secret answers the human can give, as a flat JSON Schema object
   * (MCP form-mode elicitation only allows flat primitive properties).
   */
  answerSchema?: Record<string, unknown>;
  /** For kind "credentials": the env var names that are missing. */
  missingCredentials?: string[];
  /**
   * Opaque token to resume. The caller re-invokes the same operation with the same
   * input plus `resume: { token, answers }`. Maps to MCP `requestState`.
   */
  resumeToken?: string;
};

/** Human answers passed back when resuming after a handoff. */
export type ResumeInput = {
  token?: string;
  /** "accept" | "decline" | "cancel", same as MCP elicitation actions. */
  action: "accept" | "decline" | "cancel";
  answers?: Record<string, unknown>;
};

export function ok<T>(data: T, meta?: ResultMeta): Ok<T> {
  return meta ? { status: "ok", data, meta } : { status: "ok", data };
}

export function needsHuman(handoff: Handoff): NeedsHuman {
  return { status: "needs_human", handoff };
}

export function failed(
  code: string,
  message: string,
  extra?: { retryable?: boolean; details?: unknown },
): Failed {
  return { status: "error", error: { code, message, ...extra } };
}

/**
 * Throw this from deep inside connector code (e.g. a browser helper that hits a
 * CAPTCHA) when returning a result is awkward. The runtime turns it into NeedsHuman.
 */
export class HandoffRequired extends Error {
  handoff: Handoff;
  constructor(handoff: Handoff) {
    super(handoff.message);
    this.name = "HandoffRequired";
    this.handoff = handoff;
  }
}
