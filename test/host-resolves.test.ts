import { describe, it, expect, vi, afterEach } from "vitest";
import { hostResolvesToBlockedIp } from "../src/lib/url-validator.js";

// DEV-0053: hostResolvesToBlockedIp is the DNS-REBINDING guard — a public-looking hostname whose
// A/AAAA records point at a private/loopback/metadata IP must be caught, since isUrlSafe only sees
// the hostname string. The existing safe-fetch tests deliberately use IP-literal hosts so this
// function early-returns without a live DoH call, so its real resolve->check path was untested.
// Stub globalThis.fetch (the DoH client) to drive each branch.

// Build a Cloudflare DoH application/dns-json response. type 1 = A, type 28 = AAAA.
function dohResponse(answers: Array<{ type: number; data: string }>) {
  return {
    ok: true,
    json: async () => ({ Answer: answers }),
  } as unknown as Response;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("hostResolvesToBlockedIp — DNS-rebinding guard (DEV-0053)", () => {
  it("returns true when an A record resolves to a private/loopback IP", async () => {
    // Both A and AAAA queries are issued; answer the A with a loopback, AAAA empty.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(dohResponse([{ type: 1, data: "127.0.0.1" }]))
      .mockResolvedValueOnce(dohResponse([])) as unknown as typeof fetch;
    expect(await hostResolvesToBlockedIp("evil.example.com")).toBe(true);
  });

  it("returns true when the AAAA record resolves to IPv6 loopback", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(dohResponse([])) // A: none
      .mockResolvedValueOnce(dohResponse([{ type: 28, data: "::1" }])) as unknown as typeof fetch;
    expect(await hostResolvesToBlockedIp("rebind.example.com")).toBe(true);
  });

  it("returns true when resolving to the cloud metadata IP (169.254.169.254)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(dohResponse([{ type: 1, data: "169.254.169.254" }]))
      .mockResolvedValueOnce(dohResponse([])) as unknown as typeof fetch;
    expect(await hostResolvesToBlockedIp("metadata-attacker.com")).toBe(true);
  });

  it("returns false when every record is a public IP", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(dohResponse([{ type: 1, data: "93.184.216.34" }]))
      .mockResolvedValueOnce(dohResponse([])) as unknown as typeof fetch;
    expect(await hostResolvesToBlockedIp("example.com")).toBe(false);
  });

  it("filters out answers of the wrong record type (a CNAME in the A answer is ignored)", async () => {
    // type 5 = CNAME; must NOT be treated as an A address (it isn't an IP the blocklist parses).
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(dohResponse([{ type: 5, data: "alias.example.net" }, { type: 1, data: "8.8.8.8" }]))
      .mockResolvedValueOnce(dohResponse([])) as unknown as typeof fetch;
    expect(await hostResolvesToBlockedIp("aliased.example.com")).toBe(false);
  });

  it("short-circuits (no DoH call) for an IP-literal host", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    expect(await hostResolvesToBlockedIp("127.0.0.1")).toBe(false);
    expect(await hostResolvesToBlockedIp("[::1]")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails OPEN (returns false) when the resolver errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    expect(await hostResolvesToBlockedIp("unreachable.example.com")).toBe(false);
  });

  it("fails OPEN when the resolver returns a non-ok status", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({}) } as unknown as Response) as unknown as typeof fetch;
    expect(await hostResolvesToBlockedIp("servfail.example.com")).toBe(false);
  });
});
