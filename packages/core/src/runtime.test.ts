import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry, defineConnector, defineOperation } from "./connector.ts";
import { EnvCredentialProvider } from "./credentials.ts";
import { HandoffRequired, needsHuman, ok } from "./result.ts";
import { describeConnector, invoke } from "./runtime.ts";
import { z } from "./schema.ts";
import { SnapshotStore } from "./snapshot-store.ts";

// A Yad2-shaped fake: search returns car listings; each saved search is a snapshot series.
const Listing = z.object({
  id: z.string(),
  title: z.string(),
  price: z.number().nullable().describe("ILS; null when the seller hides it"),
  year: z.number().int(),
  seller: z.enum(["private", "dealer", "unknown"]),
});

let market: z.infer<typeof Listing>[] = [];

const searchCars = defineOperation({
  name: "search_cars",
  title: "Search car listings",
  description: "Run a saved car search and return all current listings.",
  kind: "read",
  backends: ["api"],
  input: z.object({
    savedSearch: z.string().describe("Name of the saved search"),
    maxPrice: z.number().optional(),
  }),
  output: z.object({ listings: z.array(Listing) }),
  snapshot: {
    entityType: "listing",
    scope: (input) => `saved-search:${input.savedSearch}`,
    entities: (output) => output.listings.map((l) => ({ id: l.id, data: l })),
  },
  async run(input) {
    const listings = market.filter(
      (l) => input.maxPrice === undefined || (l.price ?? 0) <= input.maxPrice,
    );
    return ok({ listings });
  },
});

const fakeCars = defineConnector({
  id: "fake-cars",
  title: "Fake Cars",
  description: "Test double shaped like the Yad2 connector.",
  category: ["software", "saas", "marketplaces"],
  version: "0.0.0",
  credentials: [{ name: "email", description: "Login email", required: true }],
  entities: [{ type: "listing", description: "A car listing", schema: Listing }],
  operations: [
    searchCars,
    defineOperation({
      name: "my_favorites",
      description: "Logged-in only: the account's saved listings.",
      kind: "read",
      input: z.object({}),
      output: z.object({ ids: z.array(z.string()) }),
      async run(_input, ctx) {
        await ctx.credentials.require("email");
        return ok({ ids: [] });
      },
    }),
    defineOperation({
      name: "send_message",
      description: "Message a seller. Side effect.",
      kind: "action",
      input: z.object({ listingId: z.string(), text: z.string().min(1) }),
      output: z.object({ sent: z.boolean() }),
      async run() {
        return ok({ sent: true });
      },
    }),
    defineOperation({
      name: "hits_captcha",
      description: "Always hits a CAPTCHA.",
      kind: "read",
      input: z.object({}),
      output: z.object({}),
      async run() {
        throw new HandoffRequired({
          kind: "captcha",
          message: "Bot wall on search page",
          screenshotPath: ".local/screenshots/fake-cars/1.png",
          bestGuess: "Cloudflare challenge; solve it in the live session",
        });
      },
    }),
    defineOperation({
      name: "asks_question",
      description: "Returns a question.",
      kind: "read",
      input: z.object({}),
      output: z.object({ answer: z.string() }),
      async run(_input, ctx) {
        if (ctx.resume?.action === "accept")
          return ok({ answer: String(ctx.resume.answers?.["choice"]) });
        return needsHuman({
          kind: "question",
          message: "Two 'search' buttons. Which one?",
          answerSchema: {
            type: "object",
            properties: { choice: { type: "string", enum: ["top", "side"] } },
          },
          resumeToken: "t1",
        });
      },
    }),
    defineOperation({
      name: "buggy",
      description: "Returns data not matching its output schema.",
      kind: "read",
      input: z.object({}),
      output: z.object({ n: z.number() }),
      // @ts-expect-error deliberately wrong output
      async run() {
        return ok({ n: "nope" });
      },
    }),
  ],
});

const noCreds = new EnvCredentialProvider({});

test("invalid input is a Failed result with a readable message", async () => {
  const r = await invoke(fakeCars, "search_cars", { savedSearch: 3 }, { credentials: noCreds });
  assert.equal(r.status, "error");
  assert.equal(r.status === "error" && r.error.code, "invalid_input");
});

test("unknown operation", async () => {
  const r = await invoke(fakeCars, "nope", {}, { credentials: noCreds });
  assert.equal(r.status === "error" && r.error.code, "unknown_operation");
});

test("search snapshots per saved search and reports new / removed / price-changed", async () => {
  const store = new SnapshotStore(":memory:");
  const opts = { credentials: noCreds, store };
  market = [
    { id: "a", title: "Mazda 3", price: 60_000, year: 2018, seller: "private" },
    { id: "b", title: "Kia Ceed", price: 55_000, year: 2019, seller: "dealer" },
  ];
  const first = await invoke(fakeCars, "search_cars", { savedSearch: "family" }, opts);
  assert.equal(first.status, "ok");

  market = [
    { id: "a", title: "Mazda 3", price: 57_500, year: 2018, seller: "private" },
    { id: "c", title: "Skoda Octavia", price: null, year: 2017, seller: "unknown" },
  ];
  const second = await invoke(fakeCars, "search_cars", { savedSearch: "family" }, opts);
  assert.equal(second.status, "ok");
  const diff =
    second.status === "ok" ? (second.meta?.diff as import("./diff.ts").EntityDiff) : undefined;
  assert.deepEqual(
    diff?.added.map((e) => e.id),
    ["c"],
  );
  assert.deepEqual(
    diff?.removed.map((e) => e.id),
    ["b"],
  );
  assert.deepEqual(diff?.changed[0]?.changes, [{ path: "price", before: 60_000, after: 57_500 }]);

  // A different saved search is a separate series.
  await invoke(fakeCars, "search_cars", { savedSearch: "cheap", maxPrice: 50_000 }, opts);
  assert.equal(store.list("fake-cars", "saved-search:family").length, 2);
  assert.equal(store.list("fake-cars", "saved-search:cheap").length, 1);
  store.close();
});

test("missing credentials become a 'credentials' handoff naming env vars, never values", async () => {
  const r = await invoke(fakeCars, "my_favorites", {}, { credentials: noCreds, identity: "home" });
  assert.equal(r.status, "needs_human");
  assert.equal(r.status === "needs_human" && r.handoff.kind, "credentials");
  assert.deepEqual(r.status === "needs_human" && r.handoff.missingCredentials, [
    "OMNI_HOME__FAKE_CARS_EMAIL",
    "OMNI_FAKE_CARS_EMAIL",
  ]);
  const withCreds = new EnvCredentialProvider({ OMNI_FAKE_CARS_EMAIL: "x@y" });
  assert.equal(
    (await invoke(fakeCars, "my_favorites", {}, { credentials: withCreds })).status,
    "ok",
  );
});

test("actions need confirmation unless resumed with accept (or confirmActions=false)", async () => {
  const input = { listingId: "a", text: "Is it still available?" };
  const first = await invoke(fakeCars, "send_message", input, { credentials: noCreds });
  assert.equal(first.status === "needs_human" && first.handoff.kind, "confirm");
  const declined = await invoke(fakeCars, "send_message", input, {
    credentials: noCreds,
    resume: { action: "decline" },
  });
  assert.equal(declined.status === "error" && declined.error.code, "declined");
  const accepted = await invoke(fakeCars, "send_message", input, {
    credentials: noCreds,
    resume: { action: "accept" },
  });
  assert.deepEqual(accepted.status === "ok" && accepted.data, { sent: true });
  const cli = await invoke(fakeCars, "send_message", input, {
    credentials: noCreds,
    confirmActions: false,
  });
  assert.equal(cli.status, "ok");
});

test("HandoffRequired thrown deep inside becomes NeedsHuman", async () => {
  const r = await invoke(fakeCars, "hits_captcha", {}, { credentials: noCreds });
  assert.equal(r.status === "needs_human" && r.handoff.kind, "captcha");
});

test("question handoff and resume with answers", async () => {
  const q = await invoke(fakeCars, "asks_question", {}, { credentials: noCreds });
  assert.equal(q.status === "needs_human" && q.handoff.resumeToken, "t1");
  const a = await invoke(
    fakeCars,
    "asks_question",
    {},
    {
      credentials: noCreds,
      resume: { token: "t1", action: "accept", answers: { choice: "side" } },
    },
  );
  assert.deepEqual(a.status === "ok" && a.data, { answer: "side" });
});

test("output that violates the schema is reported as a connector bug", async () => {
  const r = await invoke(fakeCars, "buggy", {}, { credentials: noCreds });
  assert.equal(r.status === "error" && r.error.code, "invalid_output");
});

test("describeConnector produces MCP/CLI-ready JSON", () => {
  const m = describeConnector(fakeCars);
  assert.deepEqual(m.category, ["software", "saas", "marketplaces"]);
  assert.deepEqual(m.credentials[0], {
    name: "email",
    description: "Login email",
    required: true,
    env: "OMNI_FAKE_CARS_EMAIL",
  });
  const search = m.operations.find((o) => o.name === "search_cars")!;
  assert.equal(search.toolName, "fake_cars_search_cars");
  assert.deepEqual(search.cli, ["fake-cars", "search-cars"]);
  assert.deepEqual(search.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(search.inputSchema["type"], "object");
  assert.deepEqual(search.inputSchema["required"], ["savedSearch"]);
  assert.deepEqual(search.snapshots, { entityType: "listing" });
  const send = m.operations.find((o) => o.name === "send_message")!;
  assert.equal(send.annotations.destructiveHint, true);
  assert.ok(JSON.stringify(m).length > 0, "manifest is plain JSON");
});

test("registry groups connectors by category", () => {
  const r = new Registry().add(fakeCars);
  assert.equal(r.inCategory(["software", "saas"]).length, 1);
  assert.equal(r.inCategory(["iot"]).length, 0);
  assert.throws(() => r.add(fakeCars), /already registered/);
  assert.throws(() => defineConnector({ ...fakeCars, id: "Bad Id" }), /Invalid connector id/);
});
