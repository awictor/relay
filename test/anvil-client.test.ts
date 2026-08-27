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
  it("DEV-0148: classifies on the status, not a 4xx-shaped number in the body", () => {
    // a real 5xx whose response body text carries a 4xx-shaped number must stay TRANSIENT (the bug
    // was the whole-string /\b4\d\d\b/ scan matching the body and forcing non-transient).
    expect(isTransientError(new Error(`anvil /v1/actions/eval failed: 503 {"error":"expected 400 fields"}`))).toBe(true);
    expect(isTransientError(new Error(`anvil failed: 500 got 404 from upstream target`))).toBe(true);
    // explicit status= token wins over any digits in the body
    expect(isTransientError(new Error(`status=502 body mentions 400 and 404`))).toBe(true);
    expect(isTransientError(new Error(`status=400 body mentions 500`))).toBe(false);
    // a genuine 4xx with a trailing body is still deterministic (first code is the status)
    expect(isTransientError(new Error(`anvil failed: 404 not found, retry-after 500ms`))).toBe(false);
  });
});
