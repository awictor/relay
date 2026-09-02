import { describe, it, expect } from "vitest";
import { isMoreRequest, isLinkRequest, extractLinks, nextChunk } from "../src/lib/last-result.js";

describe("isMoreRequest / isLinkRequest (last-result-drilldown)", () => {
  it("matches whole-message 'more' asks, not a real task", () => {
    expect(isMoreRequest("more")).toBe(true);
    expect(isMoreRequest("the rest")).toBe(true);
    expect(isMoreRequest("go on")).toBe(true);
    expect(isMoreRequest("tell me more about bitcoin")).toBe(false); // a real task
  });
  it("matches whole-message link asks, not a real task", () => {
    expect(isLinkRequest("link")).toBe(true);
    expect(isLinkRequest("send me the link")).toBe(true);
    expect(isLinkRequest("sources?")).toBe(true);
    expect(isLinkRequest("what's the link between X and Y")).toBe(false);
  });
});

describe("extractLinks", () => {
  it("pulls de-duped http(s) urls, trims trailing punctuation", () => {
    expect(extractLinks("see https://a.com/x. and https://b.com, and https://a.com/x again"))
      .toEqual(["https://a.com/x", "https://b.com"]);
  });
  it("empty when no urls", () => {
    expect(extractLinks("no links here")).toEqual([]);
  });
});

describe("nextChunk", () => {
  it("returns the tail after what was shown", () => {
    const full = "line1\nline2\nline3";
    expect(nextChunk(full, "line1\nline2\n…")).toBe("line3");
  });
  it("null when nothing more", () => {
    expect(nextChunk("all shown", "all shown")).toBeNull();
  });
  it("caps a huge tail", () => {
    const full = "x".repeat(3000);
    const out = nextChunk(full, "", 1200)!;
    expect(out.length).toBeLessThanOrEqual(1200);
    expect(out.endsWith("…")).toBe(true);
  });
});
