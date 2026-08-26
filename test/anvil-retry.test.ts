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
});
