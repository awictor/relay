import { describe, it, expect } from "vitest";
import { truncateForModel, truncateWindow } from "../src/agent.js";

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

// long-page-truncation-answered-as-fact: a page's key fact (total/conclusion/score/stock status) often
// sits at the END, which head-only truncation dropped silently. truncateWindow keeps head + tail.
describe("truncateWindow (page content: head + tail)", () => {
  it("returns short text unchanged (no marker)", () => {
    expect(truncateWindow("hello", 6000)).toBe("hello");
    const s = "x".repeat(100);
    expect(truncateWindow(s, 100)).toBe(s);
  });
  it("keeps BOTH the head and the tail, drops the middle", () => {
    const s = "H".repeat(3000) + "M".repeat(4000) + "T".repeat(3000); // head / middle / tail
    const out = truncateWindow(s, 6000);
    expect(out.startsWith("H")).toBe(true);          // head preserved
    expect(out.endsWith("T")).toBe(true);            // tail preserved — the end-of-page fact survives
    expect(out).toMatch(/from the MIDDLE of this page were cut/);
    // The middle 'M' run must be largely gone (only the marker sits between head and tail).
    expect((out.match(/M/g) || []).length).toBeLessThan(4000);
  });
  it("the tail actually carries the last characters of the source", () => {
    const s = "a".repeat(6000) + "PRICE: $42 FINAL"; // the answer is at the very end
    const out = truncateWindow(s, 6000);
    expect(out).toMatch(/PRICE: \$42 FINAL$/);       // end-of-page fact is shown
  });
  it("loud marker forbids passing the partial read off as complete", () => {
    const out = truncateWindow("z".repeat(9000), 6000);
    expect(out).toMatch(/Do NOT state this as the complete page/);
    expect(out).toMatch(/TOP and the BOTTOM only/);
  });
  it("handles null/undefined without throwing", () => {
    expect(truncateWindow(undefined as unknown as string)).toBe("");
  });
});
