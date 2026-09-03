import { describe, it, expect } from "vitest";
import { resolveZone, utcLabel, parseClockTime, parseWorldClock, runWorldClock } from "../src/lib/worldclock.js";

// Tue 14 Nov 2023 22:13 UTC — same anchor buildNowLine tests use.
const NOW = 1_700_000_000_000;

describe("utcLabel", () => {
  it("renders whole + half-hour offsets", () => {
    expect(utcLabel(0)).toBe("UTC+0");
    expect(utcLabel(-300)).toBe("UTC-5");
    expect(utcLabel(330)).toBe("UTC+5:30");
    expect(utcLabel(-540)).toBe("UTC-9");
  });
});

describe("parseClockTime", () => {
  it("parses am/pm, 24h, noon/midnight", () => {
    expect(parseClockTime("9am")).toBe(540);
    expect(parseClockTime("9:30 pm")).toBe(21 * 60 + 30);
    expect(parseClockTime("12am")).toBe(0);
    expect(parseClockTime("12pm")).toBe(12 * 60);
    expect(parseClockTime("15:00")).toBe(15 * 60);
    expect(parseClockTime("noon")).toBe(12 * 60);
    expect(parseClockTime("midnight")).toBe(0);
  });
  it("rejects junk / out of range", () => {
    expect(parseClockTime("25:00")).toBeNull();
    expect(parseClockTime("later")).toBeNull();
    expect(parseClockTime("9:75")).toBeNull();
  });
});

describe("resolveZone", () => {
  it("resolves tz abbreviations (whole + trailing token)", () => {
    expect(resolveZone("PST")!.offsetMin).toBe(-480);
    expect(resolveZone("9am PT")!.offsetMin).toBe(-480);
    expect(resolveZone("3 est")!.offsetMin).toBe(-300);
    expect(resolveZone("utc")!.offsetMin).toBe(0);
  });
  it("resolves explicit UTC±offset", () => {
    expect(resolveZone("UTC+5:30")!.offsetMin).toBe(330);
    expect(resolveZone("gmt-8")!.offsetMin).toBe(-480);
  });
  it("falls back to city/region names via profile CITY_TZ", () => {
    expect(resolveZone("Tokyo")!.offsetMin).toBe(540);
    expect(resolveZone("London")!.offsetMin).toBe(0);
    expect(resolveZone("India")!.offsetMin).toBe(330);
  });
  it("returns null for an unknown zone", () => {
    expect(resolveZone("Narnia")).toBeNull();
    expect(resolveZone("")).toBeNull();
  });
});

describe("parseWorldClock", () => {
  it("parses 'now' variants", () => {
    expect(parseWorldClock("what time is it in Tokyo")).toEqual({ kind: "now", place: "Tokyo" });
    expect(parseWorldClock("time in London")).toEqual({ kind: "now", place: "London" });
    expect(parseWorldClock("current time in Paris")).toEqual({ kind: "now", place: "Paris" });
  });
  it("parses 'convert' variants", () => {
    expect(parseWorldClock("what's 9am PT in London")).toEqual({ kind: "convert", time: "9am", from: "PT", to: "London" });
    expect(parseWorldClock("convert 3pm EST to Tokyo time")).toEqual({ kind: "convert", time: "3pm", from: "EST", to: "Tokyo" });
  });
  it("returns null for non-time chatter", () => {
    expect(parseWorldClock("what's the weather in Tokyo")).toBeNull();
    expect(parseWorldClock("remind me at 9am")).toBeNull();
  });
});

describe("runWorldClock", () => {
  it("reports the current time in another zone", () => {
    // 22:13 UTC -> Tokyo (+540 = +9h) = 07:13 next day
    const out = runWorldClock({ kind: "now", place: "Tokyo" }, NOW)!;
    expect(out).toMatch(/In Tokyo it's 7:13 AM/);
    expect(out).toMatch(/UTC\+9/);
  });
  it("reports UTC time correctly at the anchor", () => {
    const out = runWorldClock({ kind: "now", place: "London" }, NOW)!;
    expect(out).toMatch(/10:13 PM/); // 22:13 UTC
  });
  it("converts a wall-clock time between zones with a day-shift note", () => {
    // 9:00 AM PT (-480) -> UTC 17:00 -> London (0) = 5:00 PM same day
    expect(runWorldClock({ kind: "convert", time: "9am", from: "PT", to: "London" }, NOW)!)
      .toMatch(/9:00 AM UTC-8 is 5:00 PM.*London.*UTC\+0/);
    // 9:00 PM EST (-300) -> UTC 02:00 next day -> Tokyo (+540) = 11:00 AM next day
    expect(runWorldClock({ kind: "convert", time: "9pm", from: "EST", to: "Tokyo" }, NOW)!)
      .toMatch(/next day/);
  });
  it("returns null on an unresolvable zone", () => {
    expect(runWorldClock({ kind: "now", place: "Narnia" }, NOW)).toBeNull();
    expect(runWorldClock({ kind: "convert", time: "9am", from: "PT", to: "Narnia" }, NOW)).toBeNull();
  });
});
