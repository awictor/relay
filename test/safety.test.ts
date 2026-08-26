import { describe, it, expect } from "vitest";
import { checkRateLimit, isDangerousAction, redactText, redactObject } from "../src/safety.js";

describe("checkRateLimit", () => {
  it("allows up to the limit then blocks within the window", () => {
    const chat = 111;
    const t0 = 1_000_000;
    // default RELAY_RATE_LIMIT_PER_MIN=10
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(chat, t0 + i).allowed).toBe(true);
    }
    const blocked = checkRateLimit(chat, t0 + 10);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("allows again after the window slides", () => {
    const chat = 222;
    const t0 = 2_000_000;
    for (let i = 0; i < 10; i++) checkRateLimit(chat, t0 + i);
    expect(checkRateLimit(chat, t0 + 61_000).allowed).toBe(true);
  });
});

describe("isDangerousAction", () => {
  it("flags destructive/committing actions", () => {
    for (const t of ["Delete account", "Confirm payment", "Buy now", "Log out", "Transfer funds"]) {
      expect(isDangerousAction(t)).toBe(true);
    }
  });
  it("allows safe reads", () => {
    for (const t of ["Read more", "View details", "Next page", "Search"]) {
      expect(isDangerousAction(t)).toBe(false);
    }
  });
});

describe("redactText", () => {
  it("masks common token shapes", () => {
    expect(redactText("key AIzaSyD1234567890abcdefghijklmnop here")).not.toMatch(/AIzaSy/);
    expect(redactText("Authorization: Bearer abcdef123456")).toContain("[redacted]");
    const tg = redactText("token 123456789:AA" + "x".repeat(33));
    expect(tg).toContain("[redacted-token]");
  });
  it("leaves normal text intact", () => {
    expect(redactText("the weather in Paris is 20C")).toBe("the weather in Paris is 20C");
  });
});

describe("redactObject", () => {
  it("redacts secret keys anywhere in the object", () => {
    const out = redactObject({ url: "https://x.com", headers: { authorization: "Bearer z" }, api_key: "abc" });
    expect(JSON.stringify(out)).not.toContain("Bearer z");
    expect(JSON.stringify(out)).not.toContain("abc");
    expect(JSON.stringify(out)).toContain("https://x.com");
  });
});
