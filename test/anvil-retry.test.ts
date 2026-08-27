import { describe, it, expect } from "vitest";
import { isTransientError } from "../src/anvil.js";

describe("isTransientError", () => {
  it("treats timeouts / connection / 5xx / 408 / 429 as transient", () => {
    for (const m of [
      "The operation timed out",
      "fetch failed",
      "ECONNRESET",
      "ECONNREFUSED",
      "socket hang up",
      "anvil /v1/actions/navigate failed: 503 upstream",
      "anvil create session failed: 500",
      "anvil failed: 408 Request Timeout",
      "anvil failed: 429 Too Many Requests",
    ]) expect(isTransientError(new Error(m)), m).toBe(true);
  });

  it("does NOT retry deterministic failures (SSRF / 4xx except 408/429)", () => {
    for (const m of [
      "Blocked URL: private IP",
      "Blocked protocol: file:",
      "Blocked hostname: localhost",
      "anvil /v1/actions/navigate failed: 400 bad selector",
      "anvil failed: 404 Not Found",
      "anvil failed: 403 Forbidden",
    ]) expect(isTransientError(new Error(m)), m).toBe(false);
  });

  it("accepts a non-Error value", () => {
    expect(isTransientError("timeout")).toBe(true);
    expect(isTransientError("Blocked URL: x")).toBe(false);
  });

  // DEV-0034 (HARDEN): branches the original suite missed — DNS EAI_AGAIN, the generic
  // "network" keyword. (The old whole-string 4xx-precedence case was corrected by DEV-0148 below.)
  it("treats DNS EAI_AGAIN and a generic 'network error' as transient", () => {
    expect(isTransientError(new Error("getaddrinfo EAI_AGAIN anvil.host"))).toBe(true);
    expect(isTransientError(new Error("network error"))).toBe(true);
  });

  it("a Blocked reason wins even if the message also mentions a 5xx (deterministic)", () => {
    expect(isTransientError(new Error("Blocked URL: private IP (would be 500)"))).toBe(false);
  });

  it("DEV-0148: classifies on the FIRST status code (the status), not a body digit", () => {
    // Throwers format "<label> failed: <status> <body>", so the FIRST 3-digit code is the real
    // status. A 5xx whose body text carries a 4xx-shaped number is still transient (this REPLACES
    // the DEV-0034 buggy precedence that let a body 4xx force non-transient on a real 5xx).
    expect(isTransientError(new Error("anvil failed: 500 upstream, original 404"))).toBe(true);
    // a pure 5xx is still transient
    expect(isTransientError(new Error("anvil failed: 502 Bad Gateway"))).toBe(true);
    // a genuine 4xx with a trailing body digit stays deterministic (first code is the status)
    expect(isTransientError(new Error("anvil failed: 404 not found, retry-after 500ms"))).toBe(false);
  });

  it("408/429 stay retryable even though they are 4xx", () => {
    expect(isTransientError(new Error("HTTP 408"))).toBe(true);
    expect(isTransientError(new Error("HTTP 429"))).toBe(true);
  });
});
