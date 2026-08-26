import { describe, it, expect } from "vitest";
import { redactText, checkRateLimit } from "../src/safety.js";

// m26 safety-audit-3: the bot handles these key/token shapes (Gemini, Anthropic, Telegram). If any
// reaches a log line or a reply (a scraped page, a user paste), it must be masked. Each raw shape
// below must NOT survive redactText.
const SECRETS: Array<[string, string]> = [
  ["Bearer sk-ant-api03-abcDEF123456ghi789", "anthropic bearer"],
  ["my key is sk-ant-abcDEF123456ghi789xyz012", "anthropic sk-ant bare"],
  ["AIzaSyD-abcDEF123456ghi789jkl012mno", "gemini AIza"],
  ["here: AQ.Ab8ABCdef123456ghi789jkl012mno", "gemini AQ."],
  ["123456789:AAH-abcDEF123456ghi789jkl012mno34", "telegram bot token"],
  ["sk-abcDEF123456ghi789jklmno", "openai-style sk-"],
  ["deadbeefdeadbeefdeadbeefdeadbeef0123", "long hex secret"],
];

describe("redaction adversarial sweep (m26)", () => {
  for (const [raw, label] of SECRETS) {
    it(`masks ${label}`, () => {
      const out = redactText(raw);
      // the sensitive token body must be gone; a [redacted...] marker present.
      expect(out).toMatch(/\[redacted/);
      // no long alnum run from the secret survives (the key body is masked)
      const secretBody = raw.replace(/^.*?(sk-ant-|sk-|AIza|AQ\.|:AA|[0-9a-f]{16})/, "$1");
      expect(out).not.toContain(secretBody);
    });
  }

  it("leaves ordinary text untouched", () => {
    const t = "the weather in London is 24C and the top HN story is about Rust";
    expect(redactText(t)).toBe(t);
  });
});

describe("rate limit can't be trivially reset (m26)", () => {
  it("a chat over its window stays blocked across repeated calls (no per-call reset)", () => {
    const chat = 4242;
    const t0 = 1_000_000;
    // Exhaust the window (default 10/min). Use a fixed `now` so the sliding window is deterministic.
    let lastAllowed = true;
    for (let i = 0; i < 15; i++) lastAllowed = checkRateLimit(chat, t0 + i).allowed;
    // After exceeding, further calls in the same window are still blocked — hammering doesn't reset it.
    expect(checkRateLimit(chat, t0 + 20).allowed).toBe(false);
    expect(checkRateLimit(chat, t0 + 21).allowed).toBe(false);
  });

  it("recovers only after the window elapses", () => {
    const chat = 4343;
    const t0 = 2_000_000;
    for (let i = 0; i < 15; i++) checkRateLimit(chat, t0 + i);
    expect(checkRateLimit(chat, t0 + 100).allowed).toBe(false);   // still in window
    expect(checkRateLimit(chat, t0 + 61_000).allowed).toBe(true); // window passed -> allowed again
  });
});
