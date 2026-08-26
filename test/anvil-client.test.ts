import { describe, it, expect } from "vitest";
import { buildConnectUrls, isTransientError } from "../src/lib/anvil-client.js";

// m13: the canonical shared anvil client (vendored into mcp-forge too — see parity test).
describe("buildConnectUrls", () => {
  it("http base -> ws cdp + /v1/view live url", () => {
    const u = buildConnectUrls("http://localhost:3000", "abc");
    expect(u.connectUrl).toBe("ws://localhost:3000/cdp?session=abc");
    expect(u.liveUrl).toBe("http://localhost:3000/v1/view?session=abc");
  });
  it("https base -> wss", () => {
    expect(buildConnectUrls("https://anvil.example.com", "s1").connectUrl).toBe("wss://anvil.example.com/cdp?session=s1");
  });
  it("appends token to both urls when an api key is given", () => {
    const u = buildConnectUrls("http://h:3000", "s x", "k/y");
    expect(u.connectUrl).toContain("session=s%20x");
    expect(u.connectUrl).toContain("&token=k%2Fy");
    expect(u.liveUrl).toContain("&token=k%2Fy");
  });
  it("tolerates a trailing slash on the base", () => {
    expect(buildConnectUrls("http://h:3000/", "s").liveUrl).toBe("http://h:3000/v1/view?session=s");
  });
});

describe("isTransientError (shared taxonomy)", () => {
  it("transient: timeout/reset/5xx/408/429", () => {
    for (const m of ["timed out", "ECONNRESET", "anvil failed: 503", "429 Too Many", "408"]) expect(isTransientError(new Error(m)), m).toBe(true);
  });
  it("deterministic: SSRF + 4xx (except 408/429)", () => {
    for (const m of ["Blocked URL: private IP", "anvil failed: 400", "404 Not Found"]) expect(isTransientError(new Error(m)), m).toBe(false);
  });
});
