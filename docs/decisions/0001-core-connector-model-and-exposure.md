# 0001: Core connector model and how connectors are exposed to AI

- Status: **Proposed (draft)**. Needs owner review; see [Open questions](#open-questions).
- Date: 2026-09-19
- Code: `packages/core/src/` (draft implementation, 21 `node:test` tests)
- Sources checked online on 2026-09-19: the MCP spec `2026-07-28` (tools, multi round-trip requests, elicitation), the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.0.0), the Agent Skills spec (agentskills.io/specification), and the Claude Code skills docs.

## Context

The repo will hold many connectors (websites/SaaS such as Yad2, IoT such as the AC and boiler, banking). An AI orchestrates them to read data and take actions. The owner wants a core that is **stable and consumer-agnostic**, so the same connector can be exposed as an MCP server, an AI skill, an open-core skill and/or a CLI, and shared with other people. The owner has not yet picked an exposure; that choice is part of this note.

Cross-cutting needs from `notes/raw/`: credentials per _identity_ (several clients/projects), sessions (persistent browser profiles), human-in-the-loop handoff, on-demand vs. daemon polling, and snapshots, history and diffs (new, removed and price-changed listings).

## Decision 1: the model

```
Registry
 └─ Connector            id "yad2", category ["software","saas","marketplaces"], version
     ├─ credentials       [{ name: "email", required }]          -> OMNI_YAD2_EMAIL
     ├─ entities          [{ type: "listing", schema }]
     └─ operations        search_cars, get_listing, send_message, …
          ├─ kind         "read" | "action"
          ├─ input        zod schema -> JSON Schema (MCP inputSchema, CLI flags, SKILL.md)
          ├─ output       zod schema -> JSON Schema (MCP outputSchema / structuredContent)
          ├─ backends     ["api" | "browser" | "device" | "local"]   (informational; may mix)
          ├─ snapshot?    { entityType, scope(input), entities(output) }
          └─ run(input, ctx) -> OperationResult = ok | needs_human | error
```

**Connector.** A plain object (`defineConnector`) with an id, a human title and description, a **category path** and a list of operations. The category is data, not a class hierarchy: `["software","saas","marketplaces"]` for Yad2, `["iot","climate"]` for the AC, `["finance","banking"]` for a bank. Consumers can filter by prefix (`registry.inCategory(["software","saas"])`). The path answers the owner's "generic API → software → SaaS → second-hand marketplaces → Yad2" hierarchy without inheritance. If a category later needs shared behaviour (for example, every marketplace having `search` and `get_listing`), we add **category contracts**: shared zod schemas plus a conformance test. We don't need base classes for this.

**Operation.** The unit of exposure. Each operation maps 1:1 to:

| Surface  | Mapping for `yad2.search_cars`                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP tool | name `yad2_search_cars` (underscores, because some LLM APIs reject `.` in tool names), `inputSchema`, `outputSchema`, `annotations` (`readOnlyHint` = kind is read, `destructiveHint` = kind is action, `idempotentHint`, `openWorldHint`) |
| CLI      | `omni yad2 search-cars --json '{"savedSearch":"family"}'`, printing JSON on stdout                                                                                                                                                         |
| Skill    | one section in the generated `SKILL.md`, or a `references/` file with the input schema and an example CLI call                                                                                                                             |

`describeConnector()` returns a plain-JSON **manifest** (ids, categories, credential env names, JSON Schemas, annotations). Every adapter is generated from that manifest, so adding an operation automatically makes it available in every surface.

**Kind: read vs. action.** Reads have no outside side effects. Actions do (messaging a seller, turning the boiler on, transfers). By default `invoke()` refuses to run an action until it is resumed with `{ action: "accept" }`, so the confirmation gate lives in the core and not in each adapter. A CLI, where the human typed the command, may pass `confirmActions: false`.

**Result = ok | needs_human | error.** Human handoff is a _first-class result_, not an exception or a log line:

```ts
{ status: "needs_human", handoff: {
    kind: "credentials" | "login" | "otp" | "captcha" | "confirm" | "question",
    message, bestGuess?, screenshotPath?, pageUrl?, liveSessionUrl?,   // playwright-cli `show` over Tailscale
    answerSchema?,          // flat JSON Schema, same restriction as MCP form elicitation
    missingCredentials?,    // env var names, never values
    resumeToken? } }
```

The caller resumes by calling the same operation with the same input plus `resume: { token, action: "accept"|"decline"|"cancel", answers }`. This is **deliberately the same shape as MCP's new multi round-trip requests** (`resultType: "input_required"` + `requestState`, retried with `inputResponses`), and the three actions are the MCP elicitation actions. The mapping is therefore direct and not lossy. Deep code (a browser helper that hits a CAPTCHA) can `throw new HandoffRequired({...})`. `ctx.credentials.require("password")` throws `MissingCredentialError`. The runtime converts both into `needs_human`.

Errors carry a stable `code` (`invalid_input`, `invalid_output`, `unknown_operation`, `declined`, `internal`; connectors add `rate_limited`, `not_found`, `upstream`…) and `retryable`. Output is validated against the output schema. A mismatch is reported as `invalid_output` ("connector bug"). Sites change, and we want to catch the change there instead of handing wrong data to the AI.

**Entities, snapshots, diff.** An entity is `{ id, data }` with a stable id (the Yad2 listing token). An operation that declares `snapshot` gets recorded automatically on success, _series_ = `(connector, scope)`, where the scope comes from the input (`saved-search:family`). The runtime then attaches `meta.snapshotId` and `meta.diff` = `{ added, removed, changed: [{ id, changes: [{ path, before, after }] }], unchanged }`. The diff is generic, field-level JSON diffing, with `fields` / `ignore` filters (e.g. ignore `bumpedAt`, report only `price`). `history(connector, scope, entityId)` gives one point per snapshot, including absence, which is the raw material for price history, time on market and relisting detection.

**Store: built-in `node:sqlite`** (no warning on Node 24.21). Three tables: `snapshots`, `entity_bodies` (content-addressed by sha256 of stable JSON) and `snapshot_entities`. Hourly polling of an unchanged search costs one small row per listing. Real location: `.local/data/omni.sqlite`. Per-listing notes/CRM should _not_ live in snapshot tables. That is user-authored state and belongs in a separate table set later, joined on `(connector, entityType, entityId)`.

**Credentials and identity.** `CredentialProvider.get({ connector, name, identity })`. The env implementation looks up `OMNI_<IDENTITY>__<CONNECTOR>_<NAME>` first (double underscore separates identity), then `OMNI_<CONNECTOR>_<NAME>` (the current convention). Examples: `OMNI_YAD2_EMAIL`, `OMNI_CLIENTA__YAD2_EMAIL`. Operations only see a connector-scoped view (`ctx.credentials`), so a connector cannot read another connector's secrets. A future 1Password / Bitwarden / sops / keychain provider implements the same two methods. Secrets are **never** requested through chat or MCP form elicitation (the MCP spec forbids passwords/tokens in form mode). A missing secret yields a `credentials` handoff that names _where_ to set it.

**Sessions.** `ctx.paths.profileDir` is `.local/profiles/<connector>` or `.local/profiles/<connector>--<identity>`, alongside `screenshotsDir` and `cacheDir`. A Playwright CLI persistent profile is a session. For HTTP backends, cookies/tokens go in `cacheDir` for now. Headed vs. headless and "is the session still valid" stay connector-specific until a second browser connector exists.

**On-demand vs. daemon.** These are the same code path. A poller is a loop calling `invoke(connector, "search_cars", {savedSearch}, { store })` on a schedule, with jitter and per-connector rate limits. It can therefore be added later (`omni watch`) without changing connectors. `needs_human` from a daemon becomes a notification, not a hang.

### Why zod v4 for schemas (not hand-written JSON Schema)

- One definition gives runtime validation, static types (`z.infer`) and JSON Schema 2020-12 (`z.toJSONSchema`, the MCP default dialect). Plain JSON Schema would need `ajv` plus duplicated TS types.
- The MCP TS SDK v2 takes **Standard Schema** for `inputSchema`/`outputSchema` and its examples use zod v4, so an MCP adapter can pass our schemas straight through.
- It is a single dependency with no transitive deps. Connectors import `z` from `@omni/core` so the whole repo shares one instance.
- The escape hatch: the manifest is plain JSON Schema, so non-TS consumers (a Python agent, a shell skill) never see zod.

## Decision 2: exposure (recommendation)

### Options compared

|                                             | **CLI** (`omni …`, JSON out)                                           | **Agent Skill** (`SKILL.md` + scripts)                                                                                                    | **MCP server** (stdio / Streamable HTTP)                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who can use it                              | Any agent with a shell (Claude Code, Codex, Gemini CLI…), cron, humans | Agents that support Agent Skills (Claude Code, claude.ai, the Agent SDK and a growing list of other agents); needs a shell to run scripts | Any MCP client, including ones **without a shell**: Claude desktop/mobile/web, ChatGPT, IDEs                                                      |
| Context cost with 50+ connectors            | ~0 until the agent runs `--help`                                       | ~100 tokens per skill (name + description), body loaded on use (progressive disclosure)                                                   | Every tool's schema is listed up front unless the client does tool search; grows with every operation                                             |
| Human in the loop                           | Exit code + JSON handoff; the human is right there in tmux             | Same as CLI, plus instructions on how to relay handoffs                                                                                   | Native: `input_required` + elicitation (form for questions/confirm, **URL mode** for login/CAPTCHA → live browser view). Support varies by client |
| Typed contract                              | Only by convention (JSON Schema in `--help`)                           | Prose + references                                                                                                                        | Strong: inputSchema, outputSchema, structuredContent, annotations                                                                                 |
| Running on remote machines (Tailscale/tmux) | Excellent: it _is_ the environment                                     | Excellent (skills call the CLI)                                                                                                           | stdio: fine locally; remote needs Streamable HTTP + auth                                                                                          |
| Sharing with other people                   | `npx`/package install; they need Node + secrets                        | Copy a folder or install a plugin; best "open-core" vehicle (instructions are open, the engine is a package)                              | Well understood (registries, `claude mcp add`); heavier to host remotely                                                                          |
| Long-running / daemon                       | Natural (`omni watch`)                                                 | N/A (uses CLI)                                                                                                                            | Poor fit; MCP is request/response                                                                                                                 |
| Build cost                                  | Small (`node:util.parseArgs` over the manifest)                        | Small (generate SKILL.md from the manifest)                                                                                               | Medium (SDK v2 is new; elicitation/MRTR plumbing)                                                                                                 |

### Recommendation: all three, as thin generated adapters over one core, built in this order

1. **CLI first (`adapters/cli`, bin `omni`)**. This is the reference adapter and the one the owner will actually use this month. It matches the owner's way of working (SSH/mosh → tmux → Claude Code on Tailscale machines), it has zero context cost, it can host the daemon, and it is what skills call anyway. Contract: `omni <connector> <operation> --json '<input>' [--identity x] [--resume '<json>']` prints one `OperationResult` JSON on stdout. Exit `0` = ok, `2` = error, `3` = needs_human. `omni <connector> --help --json` prints the manifest.
2. **Skills second (`adapters/skill`, generated)**. There is one skill per connector (or per category once there are many), in the open Agent Skills format: `name` (lowercase-hyphen, ≤64 chars, matches the dir), `description` (≤1024 chars, "what + when"), the body (how to call `omni`, how to relay `needs_human`, domain tips such as "Yad2 prices may be null: ask the seller") and `references/<operation>.md` holding the schemas. Claude Code extras like `disable-model-invocation: true` go on skills that wrap _actions_. This is the **open-core skill**: the skill folder and the connector package can be public, while identities, profiles and data stay in `.local/`.
3. **MCP third (`adapters/mcp`)**, once there is a need to reach connectors from a shell-less client (phone, claude.ai) or to give them to someone else's AI. Build it on SDK v2 (`@modelcontextprotocol/server`), register one tool per operation from the manifest, return `structuredContent` plus a short text summary (and the screenshot as image content on handoff). Map `needs_human` to `input_required`: form mode for `question`/`confirm`, URL mode for `login`/`captcha` pointing at the live-session viewer, and a text result (never a form) for `credentials`/`otp`. For clients without elicitation, fall back to an optional `resume` argument in each tool's input schema. To keep tool lists small, expose per-category servers or three meta-tools (`list_connectors`, `describe`, `invoke`).

This is not a compromise: because operations and handoffs are defined once, each adapter is roughly 100-300 lines of mapping code with no connector logic. The recommendation's real content is **"CLI is the source of truth for behaviour; skills and MCP are views over it."**

## Consequences

- Connectors depend only on `@omni/core` (and zod through it). They never import an MCP SDK or a CLI parser.
- Yad2 fits as follows: `search_cars` (read, backends `["api"]` or `["api","browser"]`), `input { savedSearch, …filters }`, `output { listings: Listing[] }`, `snapshot { entityType: "listing", scope: i => "saved-search:" + i.savedSearch, entities: o => o.listings.map(l => ({ id: l.token, data: l })) }`. The first run reports everything as added. Later runs report new, removed and price-changed listings (`diff.changed[].changes[path="price"]`); use `ignore: ["bumpedAt", …]` for noise. `send_message` is an action, so it goes through the confirmation gate. The test `runtime.test.ts` contains a Yad2-shaped fake that exercises exactly this path.
- Saved searches themselves (name → filters) are not modelled yet. The simplest option is a small `saved_searches` table in the same sqlite file, owned by the connector or core (see open questions).

## What is implemented (draft)

`packages/core/src/`:

- `connector.ts`: `ConnectorDefinition`, `OperationDefinition`, `OperationContext`, `defineConnector` (validates ids/names), `defineOperation`, `toolName`, `cliCommand`, `Registry` (with `inCategory`).
- `result.ts`: `OperationResult`, `Handoff`, `ResumeInput`, `ok`/`needsHuman`/`failed`, `HandoffRequired`.
- `credentials.ts`: `CredentialProvider`, `EnvCredentialProvider` (identity-aware), `scopedCredentials`, `MissingCredentialError`.
- `schema.ts`: re-exported `z` and `toJsonSchema`.
- `diff.ts`: `stableStringify`, `diffValues`, `diffEntities`.
- `snapshot-store.ts`: `SnapshotStore` on `node:sqlite` (save/get/list/latest/entities/diff/diffLatest/history).
- `runtime.ts`: `invoke` (validation → confirmation gate → run → handoff/credential mapping → output validation → snapshot + diff) and `describeConnector` (the manifest).
- Tests: `diff.test.ts`, `credentials.test.ts`, `snapshot-store.test.ts`, `runtime.test.ts`. Run them with `cd packages/core && node --test`. The repo passes `tsc --noEmit`.

Not implemented: any adapter (CLI/skill/MCP), the daemon/scheduler, rate limiting and caching helpers, browser-session helpers, the saved-search table, notes/CRM, a secret-store provider, and HMAC on resume tokens.

## Open questions

1. **Exposure order.** Is "CLI → generated skills → MCP later" right, or do you want to use connectors from a phone/claude.ai soon (which would pull MCP forward)?
2. **Identity naming.** Is `OMNI_<IDENTITY>__<CONNECTOR>_<NAME>` compatible with your existing homemade identity setup? What does that setup look like (a directory of env files? direnv?). A provider that reads it directly might be better than renaming vars.
3. **Secret store.** Is there a preferred target (1Password CLI `op`, Bitwarden, sops+age, macOS keychain, Infisical)? The interface is ready. Should it also be the place where the OTP fetcher plugs in (an `otp` credential that is _computed_, not stored)?
4. **Handoff channel when nobody is watching** (daemon mode): a Telegram/WhatsApp/ntfy push with the screenshot and a link to the live `show` view over Tailscale?
5. **Confirmation policy.** Should _all_ actions require confirmation, or only some (e.g. messaging a seller: yes; turning the AC on: no)? A per-operation `confirm: "always" | "never" | "first-time"` is easy to add.
6. **Open-core boundary.** What is public: connector code + skills? The snapshot data model? Is anything paid or private (e.g. the cross-source matching / aggregate "help people buy cars" service)?
7. **Category taxonomy.** Is a free-form path fine, or do you want a fixed top level (`software`, `iot`, `finance`, `government`…) with category contracts (e.g. every marketplace implements `search` + `get_listing`)?
8. **Where user state lives.** Should per-listing notes, contact log and saved searches go in core (generic "annotations on any entity") or in each connector? The proposal is generic in core, keyed by `(connector, entityType, entityId)`.
9. **Retention.** Keep every snapshot forever (cheap with content addressing) or compact old ones?
