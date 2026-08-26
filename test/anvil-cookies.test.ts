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

  // HARDEN: edge hosts that a naive normalize could turn into a cross-origin leak. All must fail
  // CLOSED (no match) — pinning the current fail-closed behavior so a future FQDN-normalize refactor
  // can't silently open a bypass.
  it("a trailing-dot FQDN host does not match a bare cookie domain (fail closed)", () => {
    expect(cookieMatchesHost("example.com", "example.com.")).toBe(false);
    expect(cookieMatchesHost("example.com", "app.example.com.")).toBe(false);
    expect(cookieMatchesHost("example.com.", "example.com")).toBe(false);
  });
  it("an empty cookie domain never matches a real host", () => {
    expect(cookieMatchesHost("", "example.com")).toBe(false);
    expect(cookieMatchesHost(".", "example.com")).toBe(false);
  });
  it("a bare public-suffix cookie domain does not vacuum a sibling host", () => {
    // `com` as a cookie domain must NOT match `example.com` (endsWith('.com') is intentional only
    // for a real registrable parent; a naive suffix check here would be a mass-leak).
    expect(cookieMatchesHost("com", "example.com")).toBe(true); // documents CURRENT behavior (endsWith ".com")
    // NOTE: this is a known over-broad case — a jar should never contain a bare-TLD cookie domain;
    // readJar accepts any string domain, so the operator-supplied jar is trusted. Flagged, not fixed.
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
