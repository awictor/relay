import { describe, it, expect } from "vitest";
import { truncateForModel } from "../src/agent.js";

// product-loop: silent truncation made the agent answer confidently from the top slice of a long
// page and miss data lower down. truncateForModel appends a visible marker so it knows it saw only
// part — the fix for confident-but-wrong answers across scrape/read/fetch_json.
describe("truncateForModel", () => {
  it("returns short text unchanged (no marker)", () => {
    expect(truncateForModel("hello", 6000)).toBe("hello");
  });
  it("returns text exactly at the cap unchanged", () => {
    const s = "x".repeat(100);
    expect(truncateForModel(s, 100)).toBe(s);
  });
  it("appends a truncation marker when it cuts, and keeps the first `max` chars", () => {
    const s = "a".repeat(10_000);
    const out = truncateForModel(s, 6000);
    expect(out.startsWith("a".repeat(6000))).toBe(true);
    expect(out).toMatch(/truncated 4000 more characters/);
    expect(out).toMatch(/only the first 6000/);
  });
  it("marker tells the model to hedge or fetch a narrower target", () => {
    const out = truncateForModel("z".repeat(7000), 6000);
    expect(out).toMatch(/saw only the top|more specific URL|fetch/i);
  });
  it("handles null/undefined without throwing", () => {
    expect(truncateForModel(undefined as unknown as string)).toBe("");
  });
});
