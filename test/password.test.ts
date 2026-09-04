import { describe, it, expect } from "vitest";
import { parsePasswordRequest, generateSecret, formatSecret, PASSPHRASE_WORDS } from "../src/lib/password.js";

describe("parsePasswordRequest", () => {
  it("parses a plain generate ask with sensible defaults (20 chars, symbols on)", () => {
    for (const t of ["generate a password", "make me a strong password", "I need a new password", "give me a secure password"]) {
      expect(parsePasswordRequest(t), t).toEqual({ kind: "password", length: 20, symbols: true, digits: true });
    }
  });
  it("reads an explicit length in several phrasings", () => {
    expect(parsePasswordRequest("generate a 32 character password")!.length).toBe(32);
    expect(parsePasswordRequest("password with 16 chars")!.length).toBe(16);
    expect(parsePasswordRequest("make a password of length 24")!.length).toBe(24);
    expect(parsePasswordRequest("new 12-character password")!.length).toBe(12);
  });
  it("clamps an out-of-range length to the safe bounds", () => {
    expect(parsePasswordRequest("generate a 4 character password")!.length).toBe(8);   // min 8
    expect(parsePasswordRequest("generate a 500 character password")!.length).toBe(128); // max 128
  });
  it("honors 'no symbols' / alphanumeric-only", () => {
    expect(parsePasswordRequest("password no symbols")!.symbols).toBe(false);
    expect(parsePasswordRequest("generate a password with letters and numbers only")!.symbols).toBe(false);
    expect(parsePasswordRequest("strong password")!.symbols).toBe(true); // default on
  });
  it("parses a PIN / digits-only ask", () => {
    const pin = parsePasswordRequest("generate a 6 digit pin")!;
    expect(pin).toEqual({ kind: "password", length: 6, symbols: false, digits: true });
    expect(parsePasswordRequest("random pin")!.length).toBe(6); // default PIN length
  });
  it("parses a passphrase ask + word count", () => {
    expect(parsePasswordRequest("generate a passphrase")).toEqual({ kind: "passphrase", length: 5, symbols: false, digits: true });
    expect(parsePasswordRequest("a 6 word passphrase")!.length).toBe(6);
    expect(parsePasswordRequest("give me a memorable password")!.kind).toBe("passphrase");
  });
  it("does NOT hijack a recall / reset / task (only a generate ask)", () => {
    expect(parsePasswordRequest("what's my wifi password")).toBeNull();
    expect(parsePasswordRequest("reset my password")).toBeNull();
    expect(parsePasswordRequest("I forgot my password")).toBeNull();
    expect(parsePasswordRequest("what's the weather")).toBeNull();      // no password noun
  });
});

describe("generateSecret", () => {
  // A deterministic fake for randInt(n): a counter mod n, so output is fully predictable + testable.
  function seq(start = 0) { let i = start; return (n: number) => { const v = i % n; i++; return v; }; }

  it("produces a password of the requested length", () => {
    const s = generateSecret({ kind: "password", length: 20, symbols: true, digits: true }, seq());
    expect(s).toHaveLength(20);
  });
  const rnd = (n: number) => Math.floor(Math.random() * n); // a valid randInt(n) in [0,n)
  it("guarantees at least one char from each enabled class", () => {
    // With symbols+digits on, a generated password must contain a lower, upper, digit, and symbol.
    const s = generateSecret({ kind: "password", length: 24, symbols: true, digits: true }, rnd);
    expect(/[a-z]/.test(s)).toBe(true);
    expect(/[A-Z]/.test(s)).toBe(true);
    expect(/[0-9]/.test(s)).toBe(true);
    expect(/[!@#$%^&*\-_+=?]/.test(s)).toBe(true);
  });
  it("omits symbols when disabled (alphanumeric only)", () => {
    for (let i = 0; i < 20; i++) {
      const s = generateSecret({ kind: "password", length: 16, symbols: false, digits: true }, rnd);
      expect(/^[A-Za-z0-9]+$/.test(s), s).toBe(true);
    }
  });
  it("is deterministic given the same randInt source (no hidden Math.random)", () => {
    const a = generateSecret({ kind: "password", length: 16, symbols: true, digits: true }, seq(3));
    const b = generateSecret({ kind: "password", length: 16, symbols: true, digits: true }, seq(3));
    expect(a).toBe(b);
  });
  it("builds a hyphenated passphrase with capitalized words + a numeric tail", () => {
    const s = generateSecret({ kind: "passphrase", length: 4, symbols: false, digits: true }, seq());
    const parts = s.split("-");
    expect(parts).toHaveLength(5); // 4 words + a 2-digit tail
    expect(parts.slice(0, 4).every((w) => /^[A-Z][a-z]+$/.test(w))).toBe(true);
    expect(/^\d{2}$/.test(parts[4]!)).toBe(true);
  });
  it("has a non-trivial word list (entropy sanity)", () => {
    expect(PASSPHRASE_WORDS).toBeGreaterThan(100);
  });
});

describe("formatSecret", () => {
  it("wraps the secret in a copy span + a don't-store note", () => {
    const out = formatSecret({ kind: "password", length: 20, symbols: true, digits: true }, "Ab3$xyz");
    expect(out).toContain("`Ab3$xyz`");
    expect(out).toMatch(/don't store it/i);
    expect(out).toMatch(/password/i);
  });
  it("says 'passphrase' for a passphrase", () => {
    expect(formatSecret({ kind: "passphrase", length: 5, symbols: false, digits: true }, "Oak-Rain-12")).toMatch(/passphrase/i);
  });
});
