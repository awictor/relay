import { describe, it, expect } from "vitest";
import { isBackgroundErrand, stripDispatchPhrasing, BACKGROUND_MAX_STEPS } from "../src/lib/background.js";

describe("isBackgroundErrand (async-background-errands)", () => {
  it("true when the user explicitly asks to be pinged later", () => {
    expect(isBackgroundErrand("find a good flight and get back to me")).toBe(true);
    expect(isBackgroundErrand("research this and text me when you're done")).toBe(true);
    expect(isBackgroundErrand("look into it, no rush")).toBe(true);
  });
  it("true for a clearly large-scale, long request", () => {
    expect(isBackgroundErrand("find the 5 cheapest flights to Lisbon next month")).toBe(true);
    expect(isBackgroundErrand("compare the 10 best noise-cancelling headphones under $300")).toBe(true);
    expect(isBackgroundErrand("do a deep dive on the best CRM for a small agency")).toBe(true);
  });
  it("false for a quick synchronous lookup (no dispatch phrasing, short)", () => {
    expect(isBackgroundErrand("weather")).toBe(false);
    expect(isBackgroundErrand("top HN story")).toBe(false);
    expect(isBackgroundErrand("best pizza near me")).toBe(false); // scale word but terse
    expect(isBackgroundErrand("price of bitcoin")).toBe(false);
  });
  it("BACKGROUND_MAX_STEPS is raised above the default but bounded", () => {
    expect(BACKGROUND_MAX_STEPS).toBeGreaterThan(8);
    expect(BACKGROUND_MAX_STEPS).toBeLessThanOrEqual(30);
  });
});

describe("stripDispatchPhrasing", () => {
  it("removes the 'get back to me'/'text me when done' phrasing", () => {
    expect(stripDispatchPhrasing("find the cheapest flight and get back to me")).toBe("find the cheapest flight and");
    expect(stripDispatchPhrasing("research this and get back to me")).toBe("research this and");
  });
  it("leaves a task with no dispatch phrasing unchanged", () => {
    expect(stripDispatchPhrasing("compare the 5 best laptops")).toBe("compare the 5 best laptops");
  });
});
