# omni-connect (public)

The shared machinery behind a library of **connectors** — code that gets an AI agent into a
real-world service and back out with data: banks, marketplaces, registries, devices.

This repository holds the generic, reusable half. The connectors themselves live elsewhere
while they settle down.

**Status: work in progress.** Nothing is published to npm, the APIs move, and some of it has
only ever run against one machine's idea of the world.

## Packages

| | |
|---|---|
| **`@omni/core`** | The connector model. A connector is a plain object with typed operations, so one definition can be exposed as a CLI command, an MCP tool or an agent skill without rewriting it. Every operation returns `ok`, `error` or **`needs_human`** — a credential, a one-time code, a CAPTCHA or a question is a normal outcome, not a crash. Includes a SQLite snapshot store and a generic field-level diff, so "what changed since last time" is free. |
| **`@omni/concurrency`** | A modern take on `p-map`. Bounded concurrency with results in input order, async-iterable input, `pMapIterable` with backpressure, a sliding-window rate limiter usable with `using`, and `retry` with jittered backoff. `AbortSignal` throughout: cancelling a map cancels the in-flight work and closes the source. No dependencies. |
| **`@omni/browser-session`** | The part that keeps a logged-in browser alive and usable. Persistent profiles with a lock, a transport ladder (plain fetch → fetch with the profile's cookies → fetch from inside the live page) that remembers what worked per host, detection of fifteen kinds of bot wall and login wall, per-host politeness budgets, and a handoff that hands a human a screenshot and a live view when a machine should stop guessing. Built on the Playwright CLI. |

## Design notes worth knowing before reading the code

- **Getting in is a ladder, not a technique.** An official export beats an API, which beats a
  direct call on a borrowed session, which beats calls issued from inside a live page, which
  beats driving the UI, which beats asking a human — and a real service will make you use
  several of these, with the working rung changing without warning.
- **A human is not a failure case.** `needs_human` carries what is needed, the best guess, a
  screenshot and a link to the live browser, so a caller can surface it in a terminal, a chat
  message or a push notification.
- **The browser profile is the asset.** Services challenge *new devices*; a profile that
  persists is what stops every run looking like one.
- **Never cost someone an account.** One login attempt per run, no retries, no CAPTCHA
  defeating, no fingerprint spoofing. A locked account is worse than a missing feature.

## Running it

Node 26, because the TypeScript is run directly through type stripping — there is no build
step and no `dist/`.

```sh
nvm use          # Node 26
pnpm install
pnpm typecheck
pnpm test        # node:test
```

The code is erasable-only TypeScript (no `enum`, no `namespace`, no parameter properties),
ESM, with `.ts` extensions on relative imports.

`docs/playwright-cli-agent-guide.md` is a standalone guide to driving a browser as an agent
with the Playwright CLI — persistent profiles, handing a live session to a human, capturing
network traffic to find the API behind a page. It is useful on its own, independent of this
code.

## Licence

MIT.
