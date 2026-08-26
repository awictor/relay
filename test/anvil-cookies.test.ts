import { describe, it, expect } from "vitest";
import { cookieMatchesHost } from "../src/anvil.js";

// m29 cookies-1: the security-critical decision is cookieMatchesHost — it's what stops one site's
// session cookie being injected on another host. It's pure, so it's tested directly + exhaustively.
// setCookies just filters by it (`cookies.filter(c => cookieMatchesHost(c.domain, host))`) then POSTs;
// anvil.ts freezes ANVIL_BASE_URL at import so a live-mock re-point isn't reliable in-process — the
// live POST path is exercised by the e2e/faults harnesses against real anvil, not here.

describe("cookieMatchesHost (host scoping — the SSRF-equivalent for cookies)", () => {
  it("exact host matches", () => {
    expect(cookieMatchesHost("example.com", "example.com")).toBe(true);
  });
  it("parent-domain cookie (.x.com) matches a subdomain", () => {
    expect(cookieMatchesHost(".example.com", "app.example.com")).toBe(true);
    expect(cookieMatchesHost("example.com", "app.example.com")).toBe(true);
  });
  it("does NOT match a different site", () => {
    expect(cookieMatchesHost("evil.com", "example.com")).toBe(false);
    expect(cookieMatchesHost("example.com", "evil.com")).toBe(false);
  });
  it("does NOT match a suffix-collision (notexample.com vs example.com)", () => {
    expect(cookieMatchesHost("example.com", "notexample.com")).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(cookieMatchesHost("Example.COM", "example.com")).toBe(true);
  });

  // The exact filter setCookies applies, asserted on a representative jar.
  it("filtering a mixed jar keeps only host-scoped cookies", () => {
    const jar = [
      { domain: "example.com", name: "sid" },
      { domain: "evil.com", name: "evil" },
      { domain: ".example.com", name: "sub" },
    ];
    const kept = jar.filter((c) => cookieMatchesHost(c.domain, "example.com")).map((c) => c.name).sort();
    expect(kept).toEqual(["sid", "sub"]); // evil.com dropped
  });
});
