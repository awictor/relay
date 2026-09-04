import { describe, it, expect } from "vitest";
import { isMoreRequest, isLinkRequest, extractLinks, chunkFrom, deliveredLen, parsePickIndex } from "../src/lib/last-result.js";

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

describe("parsePickIndex (open-nth-result)", () => {
  it("parses verb + digit / ordinal / number-word forms to a 1-based index", () => {
    expect(parsePickIndex("open the 2nd")).toBe(2);
    expect(parsePickIndex("open 2")).toBe(2);
    expect(parsePickIndex("show me the third one")).toBe(3);
    expect(parsePickIndex("pick 1")).toBe(1);
    expect(parsePickIndex("resend the first")).toBe(1);
    expect(parsePickIndex("#3")).toBe(3);
    expect(parsePickIndex("number 4")).toBe(4);
    expect(parsePickIndex("option 2")).toBe(2);
    expect(parsePickIndex("the 5th one")).toBe(5);
    expect(parsePickIndex("open the fifth result")).toBe(5);
  });
  it("maps 'the last one' to -1 (caller resolves to the final item)", () => {
    expect(parsePickIndex("the last one")).toBe(-1);
    expect(parsePickIndex("open the last")).toBe(-1);
  });
  it("returns null for a real task / non-pick message (no false intercept)", () => {
    expect(parsePickIndex("3 day forecast")).toBeNull();
    expect(parsePickIndex("open example.com")).toBeNull();
    expect(parsePickIndex("weather in Paris")).toBeNull();
    expect(parsePickIndex("more")).toBeNull();
    expect(parsePickIndex("second breakfast ideas")).toBeNull(); // 'second' not whole-message
    expect(parsePickIndex("")).toBeNull();
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

describe("deliveredLen + chunkFrom (offset paging, no boundary garble)", () => {
  it("deliveredLen = common-prefix length ignoring a trailing ellipsis", () => {
    const full = "line1\nline2\nline3";
    expect(deliveredLen(full, "line1\nline2\n…")).toBe("line1\nline2".length); // trailing ws+… stripped
    expect(deliveredLen(full, full)).toBe(full.length);
  });
  it("chunkFrom returns the tail after the offset + null when done", () => {
    const full = "line1\nline2\nline3";
    const off = deliveredLen(full, "line1\nline2\n…");
    const c = chunkFrom(full, off)!;
    expect(c.text).toBe("line3");
    expect(c.nextOffset).toBe(full.length);
    expect(chunkFrom(full, full.length)).toBeNull();
  });
  it("pages a huge answer across multiple 'more' calls without dropping/dupe at boundaries", () => {
    const full = Array.from({ length: 500 }, (_, i) => `L${i}`).join("\n"); // long
    let sent = deliveredLen(full, full.slice(0, 1199) + "…"); // simulate a trimmed first send
    const collected: string[] = [];
    for (let i = 0; i < 20; i++) {
      const c = chunkFrom(full, sent, 1200);
      if (!c) break;
      collected.push(c.text.replace(/…$/, ""));
      sent = c.nextOffset;
    }
    // Reassembled tail (first page + all chunks) covers the whole thing with no gaps.
    const rebuilt = (full.slice(0, 1199) + collected.join("")).replace(/\s/g, "");
    expect(rebuilt).toContain("L499"); // last line survived
    expect(rebuilt.length).toBeGreaterThanOrEqual(full.replace(/\s/g, "").length - 5);
  });
});
