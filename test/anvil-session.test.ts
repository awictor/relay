import { describe, it, expect, vi, afterEach } from "vitest";
import { anvilLive, createSession, releaseSession } from "../src/anvil.js";

// HARDEN: anvilLive (the reachability probe the /status pinger relies on), createSession (id parse +
// error/retry paths), and releaseSession (best-effort, must never throw) had no direct coverage —
// anvil-scrape/anvil-retry cover the browse path, not session lifecycle. Stub global fetch; no network.

afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init),
  ));
}
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

describe("anvilLive", () => {
  it("true when /v1/live responds ok", async () => {
    stub((url) => { expect(url).toMatch(/\/v1\/live$/); return new Response("ok", { status: 200 }); });
    expect(await anvilLive()).toBe(true);
  });
  it("false on a non-ok status", async () => {
    stub(() => new Response("nope", { status: 503 }));
    expect(await anvilLive()).toBe(false);
  });
  it("false when the fetch throws (unreachable / timeout) — never propagates", async () => {
    stub(() => { throw new Error("ECONNREFUSED"); });
    expect(await anvilLive()).toBe(false);
  });
});

describe("createSession", () => {
  it("returns the id + a built CDP ws endpoint (not anvil's raw url)", async () => {
    stub((url) => {
      expect(url).toMatch(/\/v1\/sessions$/);
      return json({ id: "sess-abc" });
    });
    const s = await createSession();
    expect(s.id).toBe("sess-abc");
    // buildConnectUrls: ws(s)://<host>/cdp?session=<id> — NOT whatever anvil returned.
    expect(s.browserWSEndpoint).toMatch(/\/cdp\?session=sess-abc/);
  });

  it("throws when the response has no id", async () => {
    stub(() => json({}));
    await expect(createSession()).rejects.toThrow(/no id/);
  });

  it("retries a transient 5xx then succeeds (withRetry gate)", async () => {
    let n = 0;
    stub(() => { n++; return n === 1 ? json({ error: "upstream" }, 503) : json({ id: "sess-retry" }); });
    const s = await createSession();
    expect(s.id).toBe("sess-retry");
    expect(n).toBe(2); // one retry
  });
});

describe("releaseSession", () => {
  it("POSTs to the release endpoint (not DELETE)", async () => {
    let method = "";
    stub((url, init) => { if (url.includes("/release")) method = init?.method ?? ""; return json({}); });
    await releaseSession("sess-x");
    expect(method).toBe("POST");
  });
  it("swallows errors — best-effort, never throws", async () => {
    stub(() => { throw new Error("network down"); });
    await expect(releaseSession("sess-x")).resolves.toBeUndefined();
  });
});
