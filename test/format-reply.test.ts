import { describe, it, expect } from "vitest";
import { formatReply } from "../src/lib/format-reply.js";

describe("formatReply", () => {
  it("passes plain prose through untouched", () => {
    expect(formatReply("Top story: Foo (123 pts)")).toBe("Top story: Foo (123 pts)");
  });

  it("renders a whole-reply JSON array as bullet lines with url/title leading", () => {
    const json = JSON.stringify([
      { url: "https://a.com", price: "$10" },
      { url: "https://b.com", price: "$20" },
    ]);
    const out = formatReply(json);
    expect(out).toContain("• url: https://a.com | price: $10");
    expect(out).toContain("• url: https://b.com | price: $20");
    expect(out).not.toMatch(/^\[/); // not raw JSON anymore
  });

  it("renders a single JSON object as one line", () => {
    const out = formatReply('{"price":"$9.99","title":"Widget"}');
    // title leads
    expect(out).toBe("title: Widget | price: $9.99");
  });

  it("extracts a fenced ```json block embedded in prose", () => {
    const reply = "Here's what I found:\n```json\n[{\"title\":\"X\",\"price\":\"5\"}]\n```";
    const out = formatReply(reply);
    expect(out).toContain("Here's what I found:");
    expect(out).toContain("• title: X | price: 5");
    expect(out).not.toContain("```");
  });

  it("shows a placeholder for null fields", () => {
    const out = formatReply('[{"title":"X","price":null}]');
    expect(out).toContain("price: —");
  });

  it("trims an over-long reply and marks it", () => {
    const long = "x".repeat(5000);
    const out = formatReply(long);
    expect(out.length).toBeLessThanOrEqual(1201);
    expect(out.endsWith("…")).toBe(true);
  });

  it("caps the number of lines for a huge array", () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({ n: i }));
    const out = formatReply(JSON.stringify(arr));
    const bulletLines = out.split("\n").filter((l) => l.startsWith("•"));
    expect(bulletLines.length).toBeLessThanOrEqual(12);
  });

  it("falls back to trimmed text for invalid JSON that looks like JSON", () => {
    const out = formatReply("{not valid json");
    expect(out).toBe("{not valid json");
  });

  it("returns 'Done.' for an empty reply", () => {
    expect(formatReply("   ")).toBe("Done.");
  });
});
