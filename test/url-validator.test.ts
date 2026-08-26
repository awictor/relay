import { describe, it, expect } from "vitest";
import { isUrlSafe, isBlockedIp } from "../src/lib/url-validator.js";

// DEV-0019: isUrlSafe is the SSRF guard EVERY agent tool (scrape/browse/fetch_json/extract/
// compare/search) routes through before touching the network. It had no direct test in relay
// (copied identical from mcp-forge). Pin the full block set so a refactor can't quietly widen it.
// safeFetch's redirect/DoH re-validation is network-bound -> manual-qa, not here.

describe("isUrlSafe — SSRF guard (DEV-0019)", () => {
  it("allows normal public http(s)", () => {
    for (const u of [
      "https://example.com",
      "http://example.com/path?q=1",
      "https://api.github.com/repos/x/y",
      "https://news.ycombinator.com",
      "https://sub.domain.example.co.uk:8443/x", // non-privileged, non-blocked port
    ]) expect(isUrlSafe(u).safe, u).toBe(true);
  });

  it("blocks loopback + localhost", () => {
    for (const u of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://127.1.2.3/x",
      "http://0.0.0.0/x",
      "http://[::1]/x",
    ]) expect(isUrlSafe(u).safe, u).toBe(false);
  });

  it("blocks RFC1918 private ranges", () => {
    for (const u of [
      "http://10.0.0.1/x",
      "http://10.255.255.255/x",
      "http://172.16.0.1/x",
      "http://172.31.255.255/x",
      "http://192.168.1.1/x",
    ]) expect(isUrlSafe(u).safe, u).toBe(false);
  });

  it("does NOT block a public 172.x outside the 16-31 private block", () => {
    expect(isUrlSafe("http://172.15.0.1/x").safe).toBe(true);
    expect(isUrlSafe("http://172.32.0.1/x").safe).toBe(true);
  });

  it("blocks link-local (169.254) — the cloud metadata range", () => {
    expect(isUrlSafe("http://169.254.169.254/latest/meta-data").safe).toBe(false);
    expect(isUrlSafe("http://metadata.google.internal/x").safe).toBe(false);
  });

  it("blocks IPv6 private/loopback + ipv4-mapped forms", () => {
    for (const u of [
      "http://[::1]/x",
      "http://[fc00::1]/x",
      "http://[fe80::1]/x",
      "http://[fd12:3456::1]/x",
    ]) expect(isUrlSafe(u).safe, u).toBe(false);
  });

  it("blocks non-http(s) schemes", () => {
    for (const u of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "gopher://example.com/x",
      "data:text/plain,hi",
    ]) expect(isUrlSafe(u).safe, u).toBe(false);
  });

  it("blocks obfuscated numeric IP encodings (decimal/hex/octal)", () => {
    for (const u of [
      "http://2130706433/x",   // decimal 127.0.0.1
      "http://0x7f000001/x",   // hex
      "http://017700000001/x", // octal-ish (leading 0 + digits)
    ]) expect(isUrlSafe(u).safe, u).toBe(false);
  });

  it("blocks internal-service + privileged ports even on a public host", () => {
    for (const u of [
      "http://example.com:22/x",    // ssh (privileged)
      "http://example.com:6379/x",  // redis
      "http://example.com:5432/x",  // postgres
      "http://example.com:27017/x", // mongo
    ]) expect(isUrlSafe(u).safe, u).toBe(false);
  });

  it("rejects an unparseable URL", () => {
    expect(isUrlSafe("not a url").safe).toBe(false);
    expect(isUrlSafe("").safe).toBe(false);
  });

  it("credentials in the URL to a PUBLIC host still validate by hostname (not an SSRF vector)", () => {
    // hostname is validated normally; creds don't change the target. Documents intended behavior.
    expect(isUrlSafe("https://user:pass@example.com/x").safe).toBe(true);
    // but creds pointing at a blocked host are still blocked (hostname is what matters)
    expect(isUrlSafe("http://user:pass@127.0.0.1/x").safe).toBe(false);
  });

  it("isBlockedIp handles bare + bracketed forms", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("[::1]")).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("192.168.0.5")).toBe(true);
  });
});
