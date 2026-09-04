import { describe, it, expect } from "vitest";
import { parseOnThisDay, parseMonthDay, formatOnThisDay, runOnThisDay, onThisDayUrl } from "../src/lib/onthisday.js";

const FEED = JSON.stringify({
  selected: [
    { year: 1969, text: "Older event.", pages: [{ content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/A" } } }] },
    { year: 2011, text: "Newer event.", pages: [{ content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/B" } } }] },
    { text: "No year — dropped." },
  ],
});

describe("parseOnThisDay", () => {
  it("parses events newest-first with url, drops bad rows", () => {
    const out = parseOnThisDay(FEED);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ year: 2011, text: "Newer event.", url: "https://en.wikipedia.org/wiki/B" });
    expect(out[1]!.year).toBe(1969); // sorted desc
  });
  it("returns [] on junk", () => {
    expect(parseOnThisDay("nope")).toEqual([]);
    expect(parseOnThisDay("{}")).toEqual([]);
  });
});

describe("parseMonthDay", () => {
  it("pulls an explicit date, else null", () => {
    expect(parseMonthDay("on this day July 4")).toEqual({ month: 7, day: 4 });
    expect(parseMonthDay("what happened on 4 July")).toEqual({ month: 7, day: 4 });
    expect(parseMonthDay("anything on 12/25")).toEqual({ month: 12, day: 25 });
    expect(parseMonthDay("what happened on this day")).toBeNull(); // no explicit date -> caller uses today
  });
});

describe("formatOnThisDay", () => {
  it("renders a capped, dated list", () => {
    const s = formatOnThisDay(9, 2, parseOnThisDay(FEED), 5);
    expect(s).toMatch(/On September 2 in history/);
    expect(s).toMatch(/2011: Newer event/);
    expect(s).toMatch(/1969: Older event/);
  });
});

describe("runOnThisDay", () => {
  it("uses an explicit date from the text", async () => {
    let url = "";
    const out = await runOnThisDay("on this day July 4", { month: 1, day: 1 }, async (u) => { url = u; return FEED; });
    expect(url).toBe(onThisDayUrl(7, 4));
    expect(out).toMatch(/On July 4 in history/);
  });
  it("falls back to today's month/day when none is named", async () => {
    let url = "";
    await runOnThisDay("what happened on this day", { month: 9, day: 2 }, async (u) => { url = u; return FEED; });
    expect(url).toBe(onThisDayUrl(9, 2));
  });
  it("returns null on an empty feed", async () => {
    expect(await runOnThisDay("on this day", { month: 9, day: 2 }, async () => "[]")).toBeNull();
  });
});
