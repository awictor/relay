import { describe, it, expect } from "vitest";
import { isUrlSafe } from "../src/lib/url-validator.js";
import { redactBodyString } from "../src/lib/redact-secrets.js";

describe("url-validator (SSRF guard)", () => {
  it("allows public https urls", () => {
    expect(isUrlSafe("https://news.ycombinator.com").safe).toBe(true);
  });
  it("blocks localhost / private / metadata", () => {
    expect(isUrlSafe("http://localhost/x").safe).toBe(false);
    expect(isUrlSafe("http://127.0.0.1/x").safe).toBe(false);
    expect(isUrlSafe("http://169.254.169.254/latest/meta-data").safe).toBe(false);
    expect(isUrlSafe("http://10.0.0.1/x").safe).toBe(false);
  });
  it("blocks non-http protocols", () => {
    expect(isUrlSafe("file:///etc/passwd").safe).toBe(false);
  });
});

describe("redact-secrets", () => {
  it("redacts nested secrets by key name", () => {
    const out = redactBodyString('{"user":{"password":"hunter2"},"ok":1}', () => "");
    expect(JSON.parse(out!)).toEqual({ user: { password: "" }, ok: 1 });
  });
});
