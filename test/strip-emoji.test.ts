import { describe, it, expect } from "vitest";
import { stripEmoji, hasEmoji } from "../src/lib/strip-emoji.js";

describe("stripEmoji (verbosity-emoji-on-proactive)", () => {
  it("removes emoji + collapses the whitespace they leave", () => {
    expect(stripEmoji("☀️ Sunny, 72°F today")).toBe("Sunny, 72°F today");
    expect(stripEmoji("BTC is up 📈 to $67,000")).toBe("BTC is up to $67,000");
    expect(stripEmoji("Done ✅")).toBe("Done");
    expect(stripEmoji("Meeting at 3pm 🎉 don't be late")).toBe("Meeting at 3pm don't be late");
    expect(stripEmoji("❤️ love it")).toBe("love it");
  });

  it("strips flags, keycaps, and skin-tone/ZWJ sequences", () => {
    expect(stripEmoji("Flags 🇺🇸🇬🇧 today")).toBe("Flags today");
    expect(stripEmoji("1️⃣ first 2️⃣ second")).toBe("first second");
    expect(stripEmoji("family 👨‍👩‍👧 here")).toBe("family here");
    expect(stripEmoji("wave 👋🏽 hi")).toBe("wave hi");
  });

  it("preserves useful non-emoji symbols and plain text", () => {
    expect(stripEmoji("Price: €50 (up 5%)")).toBe("Price: €50 (up 5%)");
    expect(stripEmoji("Temp range 20–25°C")).toBe("Temp range 20–25°C");
    expect(stripEmoji("math: 3 × 4 ± 1")).toBe("math: 3 × 4 ± 1");
    expect(stripEmoji("A → B mapping")).toBe("A → B mapping"); // a text arrow is not emoji
    expect(stripEmoji("plain text no emoji")).toBe("plain text no emoji");
  });

  it("keeps line structure in a bulleted briefing (emoji removed per line)", () => {
    expect(stripEmoji("Top stories:\n• AI news 🤖\n• Chips 💻")).toBe("Top stories:\n• AI news\n• Chips");
  });

  it("strips the proactive header glyphs (⏰ / 📋)", () => {
    expect(stripEmoji("⏰ Reminder: take meds")).toBe("Reminder: take meds");
    expect(stripEmoji("📋 morning\n• weather: sunny")).toBe("morning\n• weather: sunny");
  });

  it("hasEmoji detects only real emoji", () => {
    expect(hasEmoji("Sunny ☀️")).toBe(true);
    expect(hasEmoji("Price €50 up 5%")).toBe(false);
    expect(hasEmoji("A → B")).toBe(false);
  });

  it("no-op on empty / plain input", () => {
    expect(stripEmoji("")).toBe("");
    expect(stripEmoji("hello world")).toBe("hello world");
  });
});
