import { describe, it, expect } from "vitest";
import { classifyFailure, friendlyError } from "../src/lib/failure.js";

// m14 degrade-1: the failure classifier shapes what the USER sees over text. Raw internals
// (hostnames, status codes, stack text) must never appear in the friendly reply.
describe("classifyFailure", () => {
  it("llm: overload / rate / quota / 429 / 503", () => {
    for (const m of ["503 UNAVAILABLE high demand", "429 rate limit", "RESOURCE_EXHAUSTED quota", "model overloaded"])
      expect(classifyFailure(m), m).toBe("llm");
  });
  it("blocked: SSRF guard phrasing", () => {
    for (const m of ["Blocked URL: private IP", "refused (blocked hostname)", "Blocked protocol: file:"])
      expect(classifyFailure(m), m).toBe("blocked");
  });
  it("browser: anvil down / connection refused / socket / timeout", () => {
    for (const m of ["anvil create session failed: connect ECONNREFUSED 127.0.0.1:3000", "fetch failed", "socket hang up", "navigation timed out"])
      expect(classifyFailure(m), m).toBe("browser");
  });
  it("browser: node socket/DNS errno + Chrome net::ERR codes (failure-network-errno-generic)", () => {
    // These used to fall to the generic apology instead of the accurate 'browser trouble' hint.
    for (const m of ["ETIMEDOUT", "ENOTFOUND api.example.com", "EHOSTUNREACH", "ENETUNREACH", "net::ERR_NAME_NOT_RESOLVED", "net::ERR_CONNECTION_TIMED_OUT"])
      expect(classifyFailure(m), m).toBe("browser");
  });
  it("generic: anything unclassified", () => {
    expect(classifyFailure("TypeError: undefined is not a function")).toBe("generic");
    expect(classifyFailure("")).toBe("generic");
  });
  it("llm wins over browser when a 503 is also a fetch failure (most-specific first)", () => {
    expect(classifyFailure("fetch failed: 503 overloaded")).toBe("llm");
  });

  // HARDEN: precedence — a Blocked-URL error that ALSO mentions a transport word (timeout/fetch
  // failed) must stay "blocked" (checked before browser), so an SSRF rejection never gets the
  // "browser's having trouble, try again" advice that invites a retry against a blocked target.
  it("blocked wins over browser when the message also has a transport word", () => {
    expect(classifyFailure("Blocked URL: private IP (fetch failed after timeout)")).toBe("blocked");
    expect(classifyFailure("Blocked protocol: only http/https allowed; connection refused")).toBe("blocked");
  });
  it("llm wins over blocked when both a rate-limit and a block phrase appear", () => {
    // llm is checked first; a 429 with an incidental 'refused (' still reads as brain-busy.
    expect(classifyFailure("429 rate limit — upstream refused (retry)")).toBe("llm");
  });
});

describe("friendlyError", () => {
  it("never leaks the raw message", () => {
    const raw = "anvil create session failed: connect ECONNREFUSED 127.0.0.1:3000";
    const out = friendlyError(raw);
    expect(out).not.toContain("ECONNREFUSED");
    expect(out).not.toContain("127.0.0.1");
    expect(out).toMatch(/browser/i);
  });
  it("each category has a distinct, non-empty line", () => {
    const lines = new Set([
      friendlyError("503 overloaded"),
      friendlyError("Blocked URL: x"),
      friendlyError("ECONNREFUSED"),
      friendlyError("weird"),
    ]);
    expect(lines.size).toBe(4);
    for (const l of lines) expect(l.length).toBeGreaterThan(10);
  });
});
