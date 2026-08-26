import { describe, it, expect } from "vitest";
import { isUrlSafe } from "../src/lib/url-validator.js";

// m26 safety-audit-1: adversarial SSRF sweep. The agent drives a real browser for anyone who texts
// Relay, so isUrlSafe is the blast-radius control. Each case below is a way to point at an internal
// target; ALL must be refused. Grouped by technique so a regression names the reopened hole.
const MUST_BLOCK: Array<[string, string]> = [
  // loopback / private, plain
  ["http://127.0.0.1/", "loopback v4"],
  ["http://10.0.0.1/", "private 10/8"],
  ["http://192.168.1.1/", "private 192.168"],
  ["http://172.16.0.1/", "private 172.16/12"],
  ["http://169.254.169.254/latest/meta-data", "cloud metadata"],
  ["http://0.0.0.0/", "all-zeros"],
  ["http://localhost/", "localhost"],
  // numeric IP encodings that resolve to 127.0.0.1
  ["http://2130706433/", "decimal IP"],
  ["http://0x7f000001/", "hex IP"],
  ["http://0X7F000001/", "hex IP uppercase"],
  ["http://017700000001/", "octal IP (all digits)"],
  ["http://0177.0.0.1/", "octal dotted-quad"],
  ["http://0300.0250.0.1/", "octal dotted 192.168.0.1"],
  // IPv6 loopback / mapped / ULA / link-local
  ["http://[::1]/", "IPv6 loopback"],
  ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
  ["http://[::ffff:7f00:1]/", "IPv4-mapped loopback (hex)"],
  ["http://[fc00::1]/", "IPv6 ULA"],
  ["http://[fe80::1]/", "IPv6 link-local"],
  ["http://[0:0:0:0:0:0:0:1]/", "IPv6 loopback expanded"],
  // embedded credentials hiding an internal host
  ["http://user:pass@127.0.0.1/", "creds + loopback"],
  ["http://anything@169.254.169.254/", "creds + metadata"],
  // non-http protocols
  ["file:///etc/passwd", "file:"],
  ["gopher://127.0.0.1:6379/", "gopher:"],
  ["data:text/html,<script>", "data:"],
  ["ftp://127.0.0.1/", "ftp:"],
  // trailing-dot / case host tricks that still resolve to the blocked target
  ["http://localhost./", "trailing-dot localhost"],
  ["http://127.0.0.1./", "trailing-dot loopback"],
  ["http://LOCALHOST/", "uppercase localhost"],
  // blocked internal service ports on an otherwise-ok host shape
  ["http://example.com:6379/", "redis port"],
  ["http://example.com:22/", "ssh port"],
];

describe("SSRF adversarial sweep (m26)", () => {
  for (const [url, label] of MUST_BLOCK) {
    it(`refuses ${label}: ${url}`, () => {
      expect(isUrlSafe(url).safe, `${label} should be blocked`).toBe(false);
    });
  }

  // Sanity: legitimate public URLs still pass (no over-blocking).
  it("still allows normal public URLs", () => {
    for (const ok of ["https://example.com/", "http://news.ycombinator.com/", "https://api.open-meteo.com/v1/forecast?x=1"]) {
      expect(isUrlSafe(ok).safe, ok).toBe(true);
    }
  });
});
