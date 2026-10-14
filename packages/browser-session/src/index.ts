/**
 * `@omni/browser-session` — a long-lived logged-in browser profile that connectors borrow.
 *
 * See README.md for the tour and the migration notes. The short version:
 *
 *   await using session = await openBrowserSession({ name: "yad2-anon", url: "https://www.yad2.co.il/vehicles/cars" });
 *   using fetcher = createSessionFetcher(session, { warmUp: { "gw.yad2.co.il": "https://www.yad2.co.il/vehicles/cars" } });
 *   const out = await fetcher.fetch({ url: gatewayUrl, accept: "json", goal: "search cars" });
 *   if (out.status === "needs_human") return out.result;
 */
export { PlaywrightCli, CliError, NOT_OPEN_RE, parseRawValue, resolveCliBinary } from "./cli.ts";
export type { CliResult, CliRunner, CliRunOptions, PlaywrightCliOptions } from "./cli.ts";

export {
  assertSessionName,
  ensureSessionDirs,
  findRepoRoot,
  hostOf,
  isRotatingProfileDir,
  rotatingProfileDir,
  sessionPaths,
  siteOf,
} from "./paths.ts";
export type { SessionPaths } from "./paths.ts";

export {
  acquireProfileLock,
  isPidAlive,
  LOCK_FILE,
  ProfileLockedError,
  profileLockHolder,
  readLock,
} from "./lock.ts";
export type { AcquireLockOptions, LockInfo, ProfileLockHandle } from "./lock.ts";

export { BrowserSession, openBrowserSession } from "./session.ts";
export type { Cookie, OpenSessionOptions, PageFetchRequest, PageFetchResponse } from "./session.ts";

export {
  challengeToHandoff,
  challengeToResult,
  detectChallenge,
  extractReference,
  isSessionStale,
  parseRetryAfter,
} from "./challenge.ts";
export type { Challenge, ChallengeKind, DetectInput, HandoffExtras, Verdict } from "./challenge.ts";

export {
  CookieJar,
  DEFAULT_USER_AGENT,
  InPageTransport,
  NodeTransport,
  ProfileCookieTransport,
  TransportError,
} from "./transports.ts";
export type {
  InPageTransportOptions,
  NodeTransportOptions,
  ProfileCookieTransportOptions,
  Transport,
  TransportName,
  TransportRequest,
  TransportResponse,
} from "./transports.ts";

export { TransportPicker } from "./pick.ts";
export type { Attempt, HostMemory, PickerOptions, PickOutcome } from "./pick.ts";

export { BudgetExceededError, Politeness } from "./politeness.ts";
export type { BudgetState, HostPolicy, HostState, PolitenessOptions } from "./politeness.ts";

export { ResponseCache, cacheKey } from "./cache.ts";
export type { CacheEntry, CacheKeyParts } from "./cache.ts";

export { RequestLog } from "./request-log.ts";
export type { RequestLogEntry } from "./request-log.ts";

export {
  ShowViewer,
  formatHandoff,
  handoffResult,
  prepareHandoff,
  startShowViewer,
  stopSharedDashboard,
  tailscaleHint,
  listeningPortOf,
  tailscaleIp,
  throwHandoff,
} from "./handoff.ts";
export type { PrepareHandoffOptions, ShowViewerOptions } from "./handoff.ts";

export { SessionFetcher, createSessionFetcher } from "./fetcher.ts";
export type { FetchOutcome, SessionFetcherOptions, SessionFetchRequest } from "./fetcher.ts";
