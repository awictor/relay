import { describe, it, expect, vi, afterEach } from "vitest";
import { navigate, scrape } from "../src/anvil.js";

// DEV-0007: relay scrape had a real user-facing bug — networkidle2 hung (up to anvil's 60s cap) on
// polling sites like Hacker News, causing timeouts (fixed to domcontentloaded in commit 48c0800).
// These tests lock the wait-strategy so a refactor can't reintroduce the hang. We stub global fetch
// and inspect the request bodies anvil receives — no live anvil, no network.

interface Captured { url: string; body: unknown; }

function stubAnvil(): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    // Minimal anvil responses per endpoint the scrape/navigate path hits.
    const json = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/v1/sessions")) return json({ id: "sess-test" });
    if (url.includes("/v1/actions/navigate")) return json({ url: (body as { url?: string })?.url, title: "T" });
    if (url.includes("/v1/actions/evaluate")) return json({ result: "page text" });
    if (url.includes("/release")) return json({});
    return json({});
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("anvil scrape/navigate wait-strategy (DEV-0007 regression lock)", () => {
  it("navigate defaults to domcontentloaded, never networkidle", async () => {
    const calls = stubAnvil();
    await navigate("sess-test", "https://news.ycombinator.com");
    const nav = calls.find((c) => c.url.includes("/v1/actions/navigate"));
    expect(nav).toBeDefined();
    expect((nav!.body as { waitUntil: string }).waitUntil).toBe("domcontentloaded");
    // The bug being prevented: any networkidle variant reintroduces the 60s hang.
    expect(JSON.stringify(nav!.body)).not.toMatch(/networkidle/);
  });

  it("scrape drives navigate with domcontentloaded (the HN-hang fix)", async () => {
    const calls = stubAnvil();
    await scrape("https://news.ycombinator.com");
    const nav = calls.find((c) => c.url.includes("/v1/actions/navigate"));
    expect(nav, "scrape must navigate").toBeDefined();
    expect((nav!.body as { waitUntil: string }).waitUntil).toBe("domcontentloaded");
  });

  it("scrape always releases the session (create -> navigate -> release)", async () => {
    const calls = stubAnvil();
    await scrape("https://example.com");
    expect(calls.some((c) => c.url.endsWith("/v1/sessions"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/release"))).toBe(true);
  });

  it("scrape refuses an SSRF-unsafe URL before opening a session", async () => {
    const calls = stubAnvil();
    await expect(scrape("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/Blocked URL/);
    // Must reject BEFORE any anvil call (no session created).
    expect(calls.length).toBe(0);
  });
});
