# AGENTS.md — instructions for any agent working in this repo

The contract for **every** model and harness that works here: Claude Code, Codex, Cursor,
Aider, an SDK script, a GitHub Action, a human with an editor. Harness-specific files
(`CLAUDE.md`, `.cursorrules`, …) are thin pointers to this one, not copies that drift.

This repository is the generic machinery behind a library of connectors — code that gets an
agent into a real-world service and back out with data. The connectors that use it, and
anything tied to a particular person's accounts, live elsewhere.

---

## 1. The two rules that matter

**1. Never cost the user an account.** Every service a connector touches is one somebody depends on. A
locked bank account or a banned marketplace profile is worse than any feature is good.
Concretely:

- **One login attempt per run, ever. Never retry a failed login**, never try a second
  password, never "just try again to see". Repeated failures are what locks accounts;
  bot walls only give you a challenge.
- If you cannot classify what happened, **stop and latch**. Ambiguity is not permission.
- Never defeat a CAPTCHA, never spoof a fingerprint, never rotate IPs to evade a block.
  If a service says no, the answer is a human, not a workaround.
- Prefer a route that needs no credential at all: an official export, a public API, an
  already-authenticated profile the user established by hand.

**2. Never leak the user's data.** Financial rows, personal messages, tokens, cookies.

- Raw payloads, profiles, databases and screenshots live in `.local/`, which is never
  committed and never leaves the machine.
- Report **shapes**: field names, counts, date ranges, HTTP statuses. Not amounts, not
  merchant names, not account or card numbers.
- Secrets come from the environment at the moment of use and are never written to a file,
  a log, a fixture, a commit message or a chat transcript.
- Fixtures are **synthetic**. Invent every number. There is a test that fails the build if
  anything resembling a real card number appears in one.

---

## 2. Stack

- **pnpm** workspaces, **Node 26** (`nvm use`), **TypeScript 7**, run **directly** — type
  stripping, no build step, no `dist/`.
- Therefore TypeScript must be **erasable-only**: no `enum`, no `namespace`, no constructor
  parameter properties. `import type` for types. Relative imports carry the `.ts` extension.
- **ESM only.** No CommonJS.
- Modern platform features are the house style: `AbortSignal` everywhere for cancellation
  (`AbortSignal.any`, `AbortSignal.timeout`), `using` / `await using` with `Symbol.dispose` /
  `Symbol.asyncDispose`, iterator helpers, `Array.fromAsync`, `Promise.withResolvers`.
- **Standard decorators do not run on Node 26** (V8's `--js-decorators` cannot parse them,
  verified 2026-09-19) and would force a build step. Don't use them.
- Tests: `node --test` with `node:test` + `node:assert/strict`, files named `*.test.ts`.
- Format with **oxfmt**, lint with **oxlint**, 2 spaces, final newline.
- **Few dependencies.** Prefer built-ins: `fetch`, `node:sqlite`, `node:test`,
  `node:util.parseArgs`. A new runtime dependency needs a reason in the PR body.
- **Nothing is published to npm yet.** Every package is `"private": true`. Leave it that way.
- Layout is flat: `packages/<name>/` plus `docs/`. There are no connectors in this repo.

---

## 3. The connector model

A connector is a plain object: an id, a category path, the credentials it needs, and a list
of **operations**. Each operation has a typed input and output, so the same definition can be
exposed as a CLI command, an MCP tool or a skill without being rewritten.

Every operation returns one of three things:

- **`ok`** with data;
- **`error`** for something that went wrong;
- **`needs_human`** — *a normal outcome, not an exception*. It carries what is needed
  (a credential, an OTP, a CAPTCHA, a confirmation, a question), the agent's best guess, a
  screenshot path and a link to the live browser.

Operations are `read` or `action`. **Actions need approval by default.** Reads do not.

Because any control plane may call these, an operation must be callable with nobody
watching and must degrade to `needs_human` rather than blocking on stdin.

---

## 4. Getting into a service

The ladder, cheapest and safest first:

1. **An official export or public API.** No login, no lockout, no fragility.
2. **A direct HTTP call** reusing a session the user established.
3. **Calls issued from inside a live logged-in page**, when the token never leaves the
   browser or the request needs the page's own origin.
4. **Driving the UI** and reading the rendered screen. Slow and lossy; a fallback.
5. **A human.** Always available, never a failure.

Expect to need several of these for one service, and expect the working rung to change
without warning. `packages/browser-session` encapsulates this: persistent profiles, the
transport ladder, detection of 15 kinds of bot wall and login wall, and the handoff.

**Browser rules** (full guide: `docs/playwright-cli-agent-guide.md`):

- Use the **Playwright CLI** — the agent-oriented, command-at-a-time tool, *not* Playwright
  Test. Never drive the human's own everyday browser.
- Always a named session with an **explicit persistent profile**. The profile is the asset:
  it is what makes a service treat you as a known device instead of a new one.
- **Never `close-all` or `kill-all`.** Other agents share the machine. Close only your own.
- Run the CLI from `.local/captures/<service>/` so its output doesn't land in the repo root.
- Explore anonymously first; capture the network; prefer the API you find to the HTML.
- Be polite: space requests, cache responses, respect a daily budget, back off on 429.
- A file under `capture/` is executed by the CLI as a **bare function expression** — a
  trailing semicolon breaks it, which is why `.prettierignore` excludes those paths.

---

## 5. Working with other agents

Several agents often work here at once, with different models and harnesses.

- **Stay in your assigned directory.** If you need a change elsewhere, write it down and say
  so in your report rather than editing another agent's files mid-flight.
- **One browser profile has one owner at a time.** Take the lock; don't borrow a session
  someone else is driving.
- **Leave the repo green:** `pnpm typecheck` clean and `node --test` passing in the packages
  you touched. Say so explicitly, and say it honestly if it isn't.
- **Report what you verified versus what you inferred.** An unverified claim stated plainly
  costs the next agent hours.
- If you are blocked on something only the user can do — a credential, an OTP, a decision,
  a CAPTCHA — record it in `docs/action-items.md` as `[?]` and carry on with what you can.

---

## 6. Commit and comment hygiene

**No agent boilerplate. Anywhere. Ever.**

- Commit messages describe **the change**: what moved, why, what it breaks. Nothing else.
- **No attribution trailers** — no `Co-Authored-By`, no "Generated with", no tool name, no
  session link, no emoji, no "🤖". If your harness adds them by default, strip them.
- No "as requested", no "per the user", no apologising, no restating the task.
- Code comments explain **why**, or a trap that cost someone an hour. They do not narrate
  what the next line obviously does, and they never address a reader as if in a chat.
- Do not leave `TODO(agent)`, "I changed this because", or commentary about your own
  process in the tree. Findings go in `NOTES.md`, open work goes in `docs/action-items.md`.

The repo should read as if one careful engineer wrote it, not as a transcript.
