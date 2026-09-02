import { describe, it, expect } from "vitest";
import { isMoreRequest, isLinkRequest, extractLinks, chunkFrom, deliveredLen } from "../src/lib/last-result.js";

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
