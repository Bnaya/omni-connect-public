# `@omni/browser-session`

A long-lived logged-in browser profile that connectors **borrow**.

Yad2 grew a `browser.ts` + `client.ts` pair. Facebook Marketplace grew a `transport.ts` with three
transports, a `budget.ts`, a `cache.ts`. AliExpress, Israel Post and the bank/card connectors all
need the same thing, and the research was explicit about why
(`docs/research/openclaw-and-skill-ecosystems.md` §5.9):

> Israel Post and Yad2 sit behind the same vendor — **Radware/ShieldSquare** — and the two
> independent workarounds converge on the same answer: a real headful Chrome with a genuine profile,
> not headless Chromium, and not from a datacenter IP. […] AliExpress's silent-cookie-expiry problem
> wants a sibling of the same **"session is stale → `needs_human`"** state machine.

This package is that layer. It does **not** know anything about any site: no URLs, no parsers, no
GraphQL. A connector keeps its own URLs, schemas and normalisation, and borrows a session, a
transport ladder, a challenge classifier and a politeness budget.

```ts
import { createSessionFetcher, openBrowserSession } from "@omni/browser-session";

await using session = await openBrowserSession({
  name: "yad2-anon",
  url: "https://www.yad2.co.il/vehicles/cars",
});
using fetcher = createSessionFetcher(session, {
  warmUp: { "gw.yad2.co.il": "https://www.yad2.co.il/vehicles/cars" },
  hostPolicies: { "gw.yad2.co.il": { intervalMs: 8_000, dailyCap: 200 } },
});

const out = await fetcher.fetch({ url: gatewayUrl, accept: "json", goal: "search cars" });
if (out.status === "needs_human") return out.result; // core's NeedsHuman, ready to return
if (out.status === "error") return failed(out.code, out.message, { retryable: out.retryable });
const page = normalizeFeed(JSON.parse(out.response.body));
```

---

## 1. The session handle

`openBrowserSession(options) → BrowserSession`, with `Symbol.asyncDispose`, so `await using`
releases it.

| Option          | Default                          | Notes                                                                        |
| --------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| `name`          | —                                | session name (`-s=<name>`), and the default profile/capture directory name   |
| `url`           | —                                | page to open (or navigate to, if the session is already running)             |
| `profileDir`    | `.local/profiles/<name>`         | always passed to the CLI as an **absolute** path (gotcha 6)                  |
| `rotateProfile` | `false`                          | throwaway profile dir, removed on release — **anonymous use only**, see §6   |
| `headed`        | `true`                           | headless leaks `HeadlessChrome/…` in the UA and gets blocked more (gotcha 4) |
| `idleTimeoutMs` | `0` headed, CLI default headless | `0` = never idle out; what you want before a handoff                         |
| `reuse`         | `true`                           | attach to a running session instead of restarting it (gotcha 1)              |
| `lock`          | `true`                           | take the profile lock before launching (§6)                                  |
| `releaseAction` | `"keep"`                         | **the browser stays alive on release**; `"close"` for a one-shot scrape      |
| `cli`           | real `playwright-cli`            | injection point: tests pass `FakeCli`                                        |

Methods: `goto`, `reload`, `eval`, `runCode`, `snapshot`, `screenshot`, `cookies`, `pageFetch`,
`currentUrl`, `title`, `isAlive`, `isOnSiteOf`, `close`, `release`.

What is baked in, from `docs/playwright-cli-agent-guide.md` and CLAUDE.md:

- `-s=<name>` **and** an explicit `--profile` on every launch, so a restart can never silently drop
  the login into an in-memory profile;
- `open` only when the session is not running, `goto` otherwise;
- the CLI runs with cwd `.local/captures/<name>/`, so snapshots and console logs land there instead
  of the shared repo-root `.playwright-cli/`;
- **`close-all` and `kill-all` do not exist in this package.** Other agents share this machine.
  `session.close()` closes only its own session;
- releasing does **not** close the browser by default: a handoff needs it alive, and a logged-in
  profile is expensive to rebuild.

## 2. Transports

One interface, three rungs, cheapest first:

| `name`         | `cost` | What it is                                                                    | When it wins                                                   |
| -------------- | ------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `node`         | 1      | plain Node `fetch`                                                            | public JSON, pages that don't fingerprint                      |
| `node+cookies` | 2      | Node `fetch` + the live profile's cookies, read on demand, **in memory only** | the site checks the session but not the browser                |
| `in-page`      | 3      | `fetch()` _inside the live page_                                              | Radware & friends: real cookies, TLS/HTTP2 fingerprint, origin |

`in-page` navigates to the right site first when the page is elsewhere (`warmUp: { host: url }`), so
the fetch inherits that origin's cookies — `gw.yad2.co.il` is served from a `www.yad2.co.il` page.
A throw inside the page comes back as `status: 0`, which the classifier reads as transient.

`TransportPicker` tries them cheapest-first and **remembers what worked per host** (optionally in
`transports.json`), so the first call pays for the discovery and the rest do not. A remembered
transport that fails twice is forgotten and the ladder is climbed again. A terminal challenge (login
wall, expired session, IP block) stops the ladder: no transport dodges those.

Cookies are never written to disk by this package. `state-save` exists in the CLI for a deliberate
backup; this is not it.

## 3. Challenge and staleness detection

`detectChallenge({ status, body, url, finalUrl, headers, expect })` returns

```ts
{ kind: "ok" } | { kind: "transient"; challenge } | { kind: "needs_human"; challenge }
```

- **transient** → wait `challenge.retryAfterMs` and retry **once**. Never a loop.
- **needs_human** → stop, screenshot, keep the browser alive, hand off (guide §9).

| Signal                                                                              | Kind                               | Verdict                                                 |
| ----------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------- |
| `Radware Bot Manager` / `Are you for real` / `hcaptcha` / `cf_input`                | `radware_captcha`                  | needs_human (captcha)                                   |
| `perfdrive.com`, `__uzdbm_*`, `Verifying your browser`                              | `radware_jscheck`                  | transient — a real headed browser clears it             |
| `Just a moment...`, `/cdn-cgi/challenge-platform`                                   | `cloudflare_interstitial`          | transient                                               |
| `Error 1020`, `Sorry, you have been blocked`                                        | `cloudflare_blocked`               | needs_human (question — nobody can "solve" an IP block) |
| `Access Denied` + `Reference #`                                                     | `akamai_denied`                    | needs_human (question)                                  |
| Incapsula / PerimeterX / DataDome / Turnstile / reCAPTCHA / hCaptcha                | own kinds                          | needs_human                                             |
| a login page, a redirect to `/login`, a password form                               | `login_wall`                       | needs_human (login)                                     |
| the same, or 401, or `FAIL_SYS_SESSION_EXPIRED`, **with `expect: "authenticated"`** | `session_expired`                  | needs_human (login)                                     |
| 429 (honours `Retry-After`, seconds or HTTP-date)                                   | `rate_limited`                     | transient                                               |
| bare 403                                                                            | `forbidden`                        | needs_human — usually the egress IP                     |
| 5xx, `status: 0`                                                                    | `server_error` / `transport_error` | transient                                               |

Two rules worth knowing: **a well-formed JSON body is an answer** whatever words it contains (so a
listing whose title says "Radware" is not a block), and **the same login page means two different
things** depending on `expect`. `expect: "authenticated"` is how a connector says "I sent a
logged-in profile's cookies", which turns a login page into "the stored session went stale" — the
silent-cookie-expiry case the AliExpress research asked for. `isSessionStale(verdict)` is the
predicate.

`challengeToHandoff` / `challengeToResult` / `prepareHandoff` turn a challenge into
`@omni/core`'s `Handoff` / `NeedsHuman`, carrying the screenshot path, the page URL, the vendor
reference (Radware transaction id, Akamai reference, CF ray) and the `show` URL.
`HandoffRequired` is available via `throwHandoff` for code too deep to return a result.

## 4. Human handoff

```ts
await using viewer = await startShowViewer({ session: "yad2-anon" }); // binds to localhost
console.log(viewer.url, viewer.hint("mac-mini"));
```

Observed behaviour of `playwright-cli show --port=N` [verified on 0.1.21]: with no dashboard running
it blocks and prints `Listening on http://localhost:<port>`; with one already running it prints
`Dashboard is running pid=<n>` and exits, so `startShowViewer` looks the port up from that pid
(`listeningPortOf`) rather than starting a competing one. The dashboard is a **singleton shared with
every other agent**, so `stop()` only kills our own child; `stopSharedDashboard()` (`show --kill`)
exists for when the human explicitly asks.

Reaching it from the owner's laptop is **documented, not implemented** — the dashboard has no
authentication and whoever reaches the port controls every browser session on the machine, including
logged-in ones. `tailscaleHint(port)` prints the preferred route (SSH local forward over the
tailnet); `tailscaleIp()` is there for the bind-to-tailnet option, with its caveats. The full menu,
including why `tailscale serve` returns 403, is in the `handoff.ts` module comment and guide §10.

`formatHandoff(handoff)` renders guide §9's HANDOFF block for a terminal.

## 5. Politeness

`Politeness` (built on `@omni/concurrency`'s `createRateLimiter`) keeps three separate promises to a
site, **per host**:

- **spacing** — `perInterval` / `intervalMs` sliding window (default 1 per 5 s);
- **a daily cap** — default 200 per UTC day, persisted in `budget.json`, so restarting the process
  does not reset it and two agents on one site share one budget;
- **back-off** — `strike(url, kind)` after a rate-limit/auth/block answer; `strikesToBackoff`
  (default 2) consecutive strikes stop us for `backoffMs` (default 1 h). `success()` clears them,
  `resume()` lets a human end it early.

`BudgetExceededError` is thrown _before_ the request leaves the house.

`ResponseCache` is a JSON-file-per-entry cache keyed on method+URL+body, with a TTL.
**Challenge pages are never cached as answers**: `saveChallenge` keeps them under `blocked/` for
diagnosis, where `get` never looks.

`RequestLog` appends JSONL (`requests.jsonl`): time, host, method, URL, transport, status, verdict,
duration, attempts. Deliberately **no bodies, no headers, no cookies** — it is safe to read in a
terminal and paste into notes, and it is the artefact you want when a site starts blocking you a
week later.

`createSessionFetcher` wires all of it together: cache → budget → spacing → cheapest working
transport → classification → one transient retry → typed `needs_human`.

## 6. Profile hygiene

- **One browser per profile.** `acquireProfileLock` writes `.omni-session.lock` _inside_ the profile
  dir before anything launches, and a second agent gets a `ProfileLockedError` naming the holder
  (agent, pid, host, since) instead of Chrome's late and cryptic `ProcessSingleton` failure. A lock
  whose process is gone, or older than 6 h, is stolen with a log line. Releasing never evicts a
  holder that stole it.
- **Stable profile for logged-in sites.** The login lives in the profile; a fresh profile has no
  cookies. Anything authenticated must use `.local/profiles/<name>` and keep it.
- **`rotateProfile: true` for anonymous scraping.** The trick `WolfikOz/israel-post-tracking` uses
  against Radware: a brand-new profile dir per run (`<name>-rot-<ts>-<rand>`), closed and deleted on
  release. The trade-off is the whole point — rotation makes you look like a new visitor, which is
  what you want anonymously and exactly what you must not do when a session is the asset. Only
  directories matching the rotating pattern are ever deleted.
- Cookies flush to disk lazily (~30 s, gotcha 2). After a login, keep the session alive or wait
  before closing.

## 7. Tests

`node --test` (`pnpm -F @omni/browser-session test`), 78 offline tests, no browser and no network:

- `challenge.test.ts` — the classifier against saved HTML in `fixtures/`, including the **real**
  Radware captcha page Yad2 served us (redacted, trimmed), plus Cloudflare, Akamai, a Facebook login
  wall and an AliExpress MTOP session-expiry payload;
- `pick.test.ts` — ladder order, per-host memory and its persistence, forgetting, terminal
  challenges, a throwing transport;
- `politeness.test.ts` — spacing, per-host isolation, daily cap, UTC rollover, strikes/back-off,
  cross-process state;
- `cache.test.ts` — TTL, keying, null-dir mode, challenge pages kept out of the cache, request log;
- `lock.test.ts` — contention, `using`, stale stealing (dead pid and old age), not evicting a thief;
- `session.test.ts` — the CLI argv it builds (profile/headed/idle-timeout), attach-vs-open, cwd,
  `close-all` never appearing, screenshot paths, in-page fetch warm-up, rotating profiles;
- `transports.test.ts` — cookie jar, header shaping, redirect handling, cookie reuse/refresh;
- `fetcher.test.ts` — cache hit, exactly-one transient retry, `needs_human` plumbing, budget stop.

`src/testing.ts` exports `FakeCli` and `FakeTransport` for connectors to reuse.

**Verified live** (2026-10-07, from the owner's Mac):

- a harmless site (`example.com`): open → in-page fetch → cookies → screenshot → node fetch →
  fetcher with cache hit → 404 _not_ mistaken for a wall → viewer start/reach/stop;
- **Yad2**, two polite gateway requests on the `yad2-anon` profile (8 s apart, inside a 20/day cap):
  the first took **3 attempts** — `node`, then `node+cookies`, then **`in-page`, which answered
  200 with real JSON** — and the picker remembered `in-page`, so the second request took **1
  attempt**. That is the 2026 Yad2 story (`connectors/marketplaces/yad2/NOTES.md`) reproduced by the
  generic layer without any Yad2-specific code.

---

## 8. How to migrate an existing connector

**Not done here on purpose** — another agent may be editing `yad2` and `facebook-marketplace`. This
is the recipe, and it is tracked in `docs/action-items.md`.

### Yad2 (`connectors/marketplaces/yad2`)

| Delete                                                                        | Replace with                                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/browser.ts` (`cli()`, `warmUp`, `browserFetch`, `browserTransport`)      | `openBrowserSession({ name: "yad2-anon", url: CARS })` + `InPageTransport` with `warmUp: { "gw.yad2.co.il": CARS }`       |
| `Yad2Client`'s `cacheDir`/`cachePath`/`minIntervalMs`/`lastRequestAt`/`sleep` | `createSessionFetcher(session, { hostPolicies: { "gw.yad2.co.il": { intervalMs: 5_000 } } })`                             |
| `detectBlock` + `CHALLENGE_MARKERS` + `txIdOf`                                | `detectChallenge` (same markers, plus Cloudflare/Akamai/PerimeterX, and the transient-vs-human split Yad2 never made)     |
| `Yad2BlockedError`                                                            | the `needs_human` outcome. Keep the class only if the CLI prints it; `challengeToResult` is what operations should return |
| the `blocked/` dump in `get()`                                                | `ResponseCache.saveChallenge`, called by the fetcher                                                                      |

`client.ts` keeps `searchParams`, the URL builders, `formatRange`/`parseRange` and the
`normalize*` calls — that is the part that is actually about Yad2. `enrich()`'s "stop on the first
block rather than pushing on" becomes "stop on the first `needs_human` outcome and return it".

One behaviour to preserve: Yad2's `detectBlock` treats any JSON body as a real answer. The shared
classifier does the same, so nothing changes.

### Facebook Marketplace (`connectors/marketplaces/facebook-marketplace`)

| Delete                                                                 | Replace with                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserTransport` (`#cli`, `#runCode`, `ensureOpen`, `exportCookies`) | `BrowserSession` + `InPageTransport`; `exportCookies` → `session.cookies(origin)`, already what `ProfileCookieTransport` does                                                 |
| `NodeTransport`'s cookie jar                                           | `CookieJar`                                                                                                                                                                   |
| `budget.ts` (`Budget`, `BudgetExceededError`)                          | `Politeness` — same design, but keyed per host, so facebook.com and fbcdn.net have their own counters                                                                         |
| `cache.ts` (`FileCache`)                                               | `ResponseCache`                                                                                                                                                               |
| `FacebookError("auth")` for login walls, the `loginWall` → throw path  | `detectChallenge(..., { expect: "authenticated" })`, which separates "logged-out wall" from "our session went stale"                                                          |
| the client's `#call` (retry + limiter + budget) and `#strike`          | `SessionFetcher.fetch`                                                                                                                                                        |
| `mode: "auto" \| "browser" \| "node"`                                  | the picker's cheapest-first ladder plus its per-host memory. Keep `mode` as a CLI flag if it is useful for debugging, implemented by handing the fetcher a one-transport list |

`page.ts` (Comet/Relay parsing, `expectedPreloaders`, `lsd`), `graphql.ts`, `normalize.ts`,
`schemas.ts` and `url.ts` are Facebook's business and stay. `FixtureTransport` stays too — it is a
`Transport` already; point it at this package's interface and it keeps working.

### Checklist for both

1. Keep the connector's `fixtures/` and offline tests green first; they should not need to change.
2. Give the session a name that matches the profile already on disk (`yad2-anon`, `fb-anon`) so no
   login is lost.
3. Pass `expect: "authenticated"` on every call that relies on being logged in. Without it a stale
   session is reported as a login wall, which is almost right but tells the human the wrong thing.
4. Return `out.result` for `needs_human` instead of throwing, and let `@omni/core`'s runtime do the
   rest.
