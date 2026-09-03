import { describe, it, expect } from "vitest";
import { pageText, pageKey, diffPages, formatPageDiff, pageWatchUrl } from "../src/lib/pagediff.js";

describe("pageText / pageKey", () => {
  it("strips tags/scripts/styles + collapses whitespace to comparable lines", () => {
    const html = "<html><head><style>x{}</style><script>var a=1</script></head><body><h1>Title</h1><p>Hello   world</p></body></html>";
    const t = pageText(html);
    expect(t).toContain("Title");
    expect(t).toContain("Hello world");
    expect(t).not.toMatch(/var a=1|x\{\}/); // script/style dropped
  });
  it("pageKey ignores whitespace + case drift", () => {
    expect(pageKey("<p>In Stock</p>")).toBe(pageKey("<p>in   stock</p>\n"));
  });
});

describe("diffPages", () => {
  it("reports added + removed content lines, ignoring reorder", () => {
    const a = "<p>Line A</p><p>Line B</p><p>Line C</p>";
    const b = "<p>Line C</p><p>Line B</p><p>Line D</p>"; // A removed, D added, order changed
    const d = diffPages(a, b);
    expect(d.changed).toBe(true);
    expect(d.added.map((l) => l.toLowerCase())).toContain("line d");
    expect(d.removed.map((l) => l.toLowerCase())).toContain("line a");
    expect(d.added.map((l) => l.toLowerCase())).not.toContain("line b"); // unchanged, not reported
  });
  it("no change when only whitespace/case differ", () => {
    expect(diffPages("<p>Same Text</p>", "<p>same   text</p>").changed).toBe(false);
  });
  it("detects a restock (Out of stock -> In stock)", () => {
    const d = diffPages("<p>Out of stock</p>", "<p>In stock</p><p>Add to cart</p>");
    expect(d.changed).toBe(true);
    expect(d.added.map((l) => l.toLowerCase())).toContain("in stock");
  });
});

describe("formatPageDiff", () => {
  it("shows a what-changed summary with added/removed", () => {
    const out = formatPageDiff("terms", { changed: true, added: ["New refund policy"], removed: ["Old clause"] });
    expect(out).toMatch(/terms changed/i);
    expect(out).toMatch(/Added:/);
    expect(out).toMatch(/New refund policy/);
    expect(out).toMatch(/Removed:/);
  });
});

describe("pageWatchUrl", () => {
  it("recognizes a bare-URL watch task", () => {
    expect(pageWatchUrl("https://x.com/terms")).toBe("https://x.com/terms");
    expect(pageWatchUrl("this page: https://x.com/p")).toBe("https://x.com/p");
    expect(pageWatchUrl("watch https://x.com/p")).toBe("https://x.com/p");
  });
  it("null for a non-URL task (a normal value/prose watch)", () => {
    expect(pageWatchUrl("price of bitcoin")).toBeNull();
    expect(pageWatchUrl("the top HN story")).toBeNull();
  });
});
