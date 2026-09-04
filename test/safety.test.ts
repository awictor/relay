import { describe, it, expect } from "vitest";
import { checkRateLimit, isDangerousAction, redactText, redactObject, resolveRateLimit } from "../src/safety.js";

describe("resolveRateLimit (DEV-0162 — fail safe, never NaN)", () => {
  it("garbage / undefined / negative FAIL SAFE to the default (limiter stays ON)", () => {
    for (const bad of ["abc", "1O", undefined, "-5", "NaN", ""]) {
      expect(resolveRateLimit(bad), String(bad)).toBe(10);
    }
  });
  it("0 is an explicit disable; a valid positive integer is honored", () => {
    expect(resolveRateLimit("0")).toBe(0);
    expect(resolveRateLimit("25")).toBe(25);
    expect(resolveRateLimit("12.9")).toBe(12); // floored
  });
});

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
  it("flags a money send/transfer with a currency AMOUNT, not just the word 'money' (dangerous-send-amount)", () => {
    for (const t of ["Send $50 to John", "transfer £200", "pay 100 usd", "wire $1,000", "Venmo $20 to Sam", "send 50 dollars"]) {
      expect(isDangerousAction(t), `${t} should be dangerous`).toBe(true);
    }
    // a bulk destructive clear is caught too
    expect(isDangerousAction("empty trash")).toBe(true);
    expect(isDangerousAction("clear my cart")).toBe(true);
  });
  it("does NOT overblock benign send/clear phrasings", () => {
    for (const t of ["send search", "send me the results", "send email", "Send the link", "clear filters", "empty state"]) {
      expect(isDangerousAction(t), `${t} should be allowed`).toBe(false);
    }
  });
  it("catches commit actions the earlier lists missed (safety-hole-sweep)", () => {
    // sign-up, cart synonyms, reservation, one-click/order-now, rental — all real commits the agent must refuse.
    for (const t of ["sign up now", "sign up for premium", "Add to bag", "Add to basket", "Book flight", "book a room", "book table",
                     "order now", "one-click order", "1-click buy", "rent this", "rent now"]) {
      expect(isDangerousAction(t), `${t} should be dangerous`).toBe(true);
    }
  });
  it("still allows the benign look-alikes of those (no new overblock)", () => {
    for (const t of ["booking reference", "order status", "order history", "view bag", "reset filters", "sign in to read", "sign up to read"]) {
      expect(isDangerousAction(t), `${t} should be allowed`).toBe(false);
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
  // DEV-0010: pin the shapes not already covered so a regex change can't silently start leaking them.
  it("masks an sk- API key", () => {
    const out = redactText("my key is sk-" + "A1b2C3d4E5f6G7h8" + " ok");
    expect(out).not.toContain("sk-A1b2C3d4E5f6G7h8");
    expect(out).toContain("[redacted-key]");
  });
  it("masks a long hex secret (32+ chars)", () => {
    const hex = "a".repeat(40);
    const out = redactText(`session ${hex} end`);
    expect(out).not.toContain(hex);
    expect(out).toContain("[redacted-hex]");
  });
  it("masks multiple secrets in one string", () => {
    const out = redactText("Bearer abcdefgh12345678 and sk-" + "Z".repeat(20));
    expect(out).not.toMatch(/abcdefgh12345678/);
    expect(out).not.toMatch(/sk-Z{20}/);
  });
});

describe("redactObject", () => {
  it("redacts secret keys anywhere in the object", () => {
    const out = redactObject({ url: "https://x.com", headers: { authorization: "Bearer z" }, api_key: "abc" });
    expect(JSON.stringify(out)).not.toContain("Bearer z");
    expect(JSON.stringify(out)).not.toContain("abc");
    expect(JSON.stringify(out)).toContain("https://x.com");
  });
  // DEV-0010: recursion depth + arrays + non-secret preservation.
  it("recurses into nested objects and arrays", () => {
    const out = redactObject({
      level1: { level2: { token: "deep-secret-xyz", note: "keep-me" } },
      items: [{ apiKey: "arr-secret" }, { label: "keep-too" }],
    });
    const s = JSON.stringify(out);
    expect(s).not.toContain("deep-secret-xyz");
    expect(s).not.toContain("arr-secret");
    expect(s).toContain("keep-me");
    expect(s).toContain("keep-too");
  });
  it("leaves a fully non-secret object untouched", () => {
    const input = { city: "Paris", temp: 20, nested: { ok: true } };
    expect(redactObject(input)).toEqual(input);
  });
});
