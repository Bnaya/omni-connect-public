import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CookieJar,
  InPageTransport,
  NodeTransport,
  ProfileCookieTransport,
  TransportError,
} from "./transports.ts";
import type { BrowserSession, Cookie, PageFetchRequest } from "./session.ts";

/** Enough of a BrowserSession for the two transports that need one. */
function fakeSession(opts: { cookies?: Cookie[] } = {}): {
  session: BrowserSession;
  fetches: PageFetchRequest[];
  cookieCalls: (string | undefined)[];
} {
  const fetches: PageFetchRequest[] = [];
  const cookieCalls: (string | undefined)[] = [];
  const session = {
    name: "test",
    async cookies(url?: string) {
      cookieCalls.push(url);
      return opts.cookies ?? [];
    },
    async pageFetch(req: PageFetchRequest) {
      fetches.push(req);
      return { status: 200, url: req.url, headers: { "x-from": "page" }, body: '{"in":"page"}' };
    },
  } as unknown as BrowserSession;
  return { session, fetches, cookieCalls };
}

describe("CookieJar", () => {
  it("builds a cookie header and absorbs Set-Cookie", () => {
    const jar = new CookieJar();
    assert.equal(jar.header(), undefined);
    jar.setAll([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
    assert.equal(jar.header(), "a=1; b=2");
    jar.absorb(
      new Response("", {
        headers: [
          ["set-cookie", "b=3; Path=/; HttpOnly"],
          ["set-cookie", "c=4; Secure"],
        ],
      }),
    );
    assert.equal(jar.header(), "a=1; b=3; c=4");
    assert.deepEqual(jar.names, ["a", "b", "c"]);
    jar.clear();
    assert.equal(jar.size, 0);
  });
});

describe("NodeTransport", () => {
  it("sends a browser-shaped request and reports the final URL", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const transport = new NodeTransport({
      fetch: async (url, init) => {
        seen = { url: String(url), init: init as RequestInit };
        return new Response('{"ok":1}', {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "sid=xyz" },
        });
      },
    });
    const res = await transport.fetch({ url: "https://gw.yad2.co.il/feed", accept: "json" });
    assert.equal(res.status, 200);
    assert.equal(res.transport, "node");
    assert.equal(res.headers["content-type"], "application/json");
    assert.equal(
      res.headers["set-cookie"],
      undefined,
      "cookies never leak into the logged headers",
    );
    assert.equal(transport.jar.header(), "sid=xyz", "but they do land in the in-memory jar");
    const headers = seen?.init.headers as Record<string, string>;
    assert.match(headers["user-agent"] ?? "", /Chrome/);
    assert.match(headers.accept ?? "", /application\/json/);
  });

  it("wraps a network failure as a TransportError", async () => {
    const transport = new NodeTransport({
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await assert.rejects(transport.fetch({ url: "https://x/" }), (err: unknown) => {
      assert.ok(err instanceof TransportError);
      assert.equal(err.transport, "node");
      return true;
    });
  });

  it("can report redirects instead of following them, so login walls stay visible", async () => {
    const transport = new NodeTransport({
      redirect: "manual",
      fetch: async (_url, init) => {
        assert.equal((init as RequestInit).redirect, "manual");
        return new Response("", { status: 302, headers: { location: "/login" } });
      },
    });
    const res = await transport.fetch({ url: "https://www.facebook.com/marketplace/" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/login");
  });
});

describe("ProfileCookieTransport", () => {
  it("reads the profile's cookies once and reuses them, never writing them anywhere", async () => {
    const { session, cookieCalls } = fakeSession({
      cookies: [{ name: "__uzma", value: "s3cret", domain: ".yad2.co.il", path: "/" }],
    });
    const calls: Record<string, string>[] = [];
    const transport = new ProfileCookieTransport(session, {
      fetch: async (_url, init) => {
        calls.push((init as RequestInit).headers as Record<string, string>);
        return new Response('{"ok":1}', { status: 200 });
      },
    });
    const res = await transport.fetch({ url: "https://gw.yad2.co.il/feed", accept: "json" });
    assert.equal(res.transport, "node+cookies");
    assert.equal(calls[0]?.cookie, "__uzma=s3cret");
    assert.deepEqual(
      cookieCalls,
      ["https://gw.yad2.co.il"],
      "cookies are read for the request's own origin",
    );

    await transport.fetch({ url: "https://gw.yad2.co.il/feed?page=2", accept: "json" });
    assert.equal(cookieCalls.length, 1, "and not re-read on every request");
    assert.deepEqual(transport.jar.names, ["__uzma"]);
  });

  it("re-reads the cookies on demand, e.g. after a human logged in again", async () => {
    const { session, cookieCalls } = fakeSession({
      cookies: [{ name: "a", value: "1", domain: "x", path: "/" }],
    });
    const transport = new ProfileCookieTransport(session, {
      fetch: async () => new Response("{}"),
    });
    await transport.fetch({ url: "https://x/y" });
    assert.deepEqual(await transport.refresh("https://x"), ["a"]);
    assert.equal(cookieCalls.length, 2);
  });
});

describe("InPageTransport", () => {
  it("fetches in the page and warms up the configured origin first", async () => {
    const { session, fetches } = fakeSession();
    const transport = new InPageTransport(session, {
      warmUp: { "gw.yad2.co.il": "https://www.yad2.co.il/vehicles/cars" },
    });
    const res = await transport.fetch({ url: "https://gw.yad2.co.il/feed", accept: "json" });
    assert.equal(res.transport, "in-page");
    assert.equal(res.body, '{"in":"page"}');
    assert.equal(fetches[0]?.warmUpUrl, "https://www.yad2.co.il/vehicles/cars");
    assert.match(fetches[0]?.headers?.accept ?? "", /application\/json/);
  });

  it("is the most expensive rung of the ladder", () => {
    const { session } = fakeSession();
    assert.ok(new InPageTransport(session).cost > new ProfileCookieTransport(session).cost);
    assert.ok(new ProfileCookieTransport(session).cost > new NodeTransport().cost);
  });
});
