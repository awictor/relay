import { describe, it, expect } from "vitest";
import { pageText, pageKey, stableText, diffPages, formatPageDiff, pageWatchUrl } from "../src/lib/pagediff.js";

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
  it("caps the extracted text so a huge page can't bloat the store (page-diff-snapshot-cap)", () => {
    const huge = "<p>" + "word ".repeat(20000) + "</p>"; // ~100KB of text
    expect(pageText(huge).length).toBeLessThanOrEqual(16_000);
  });
  it("a content-bearing time change IS detected; a 'last updated' time churn is NOT (pagewatch-time-masked)", () => {
    // Appointment/departure page: the meaningful change is the time itself -> must register.
    expect(pageKey("<p>Next available: 3:15pm</p>")).not.toBe(pageKey("<p>Next available: 5:45pm</p>"));
    expect(pageKey("<p>Departs 9:00</p>")).not.toBe(pageKey("<p>Departs 10:30</p>"));
    // A volatile "last updated" stamp churning must NOT count as a change.
    expect(pageKey("<p>Status: OK</p><span>Last updated 3:15pm</span>")).toBe(pageKey("<p>Status: OK</p><span>Last updated 5:45pm</span>"));
    expect(pageKey("<p>Status: OK</p><span>as of 09:00</span>")).toBe(pageKey("<p>Status: OK</p><span>as of 14:30</span>"));
  });
  it("pageKey masks volatile tokens so a nonce/timestamp re-render isn't a change (page-diff-flap-guard)", () => {
    // Same content, different CSRF nonce + timestamp + 'N minutes ago' each load -> equal keys.
    const a = "<p>In stock</p><input name=csrf value=a1b2c3d4e5f60718><span>Updated 2026-09-03T10:00:00</span><span>3 minutes ago</span>";
    const b = "<p>In stock</p><input name=csrf value=ffeeddccbbaa9988><span>Updated 2026-09-03T11:30:00</span><span>8 minutes ago</span>";
    expect(pageKey(a)).toBe(pageKey(b));
    // But a REAL content change (Out of stock -> In stock) still differs.
    const c = "<p>Out of stock</p><input name=csrf value=a1b2c3d4e5f60718>";
    expect(pageKey(a)).not.toBe(pageKey(c));
    expect(stableText(a)).toContain("§"); // volatile tokens masked
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
  it("trims trailing sentence punctuation so the watch isn't a dead 404 (pagewatch-trailing-punct)", () => {
    expect(pageWatchUrl("https://site.com/policy.")).toBe("https://site.com/policy"); // the task after "watch <name>:" is just the URL
    expect(pageWatchUrl("this page: https://site.com/policy.")).toBe("https://site.com/policy");
    expect(pageWatchUrl("https://site.com/p,")).toBe("https://site.com/p");
    expect(pageWatchUrl("this page: https://site.com/x)")).toBe("https://site.com/x"); // stray close-paren
    // A URL with a legitimately balanced trailing paren keeps it.
    expect(pageWatchUrl("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
  });
});
