import { describe, it, expect } from "vitest";
import { resolveCountryCode, parseHolidays, parseHolidayIntent, runHolidays, nextHolidaysUrl, yearHolidaysUrl } from "../src/lib/holidays.js";

describe("resolveCountryCode", () => {
  it("maps names/adjectives/codes to ISO alpha-2", () => {
    expect(resolveCountryCode("UK")).toBe("GB");
    expect(resolveCountryCode("united kingdom")).toBe("GB");
    expect(resolveCountryCode("Canada")).toBe("CA");
    expect(resolveCountryCode("german")).toBe("DE");
    expect(resolveCountryCode("de")).toBe("DE");
    expect(resolveCountryCode("fr")).toBe("FR");   // bare 2-letter passes through
    expect(resolveCountryCode("")).toBeNull();
    expect(resolveCountryCode("Narnia")).toBeNull();
  });
});

describe("parseHolidays", () => {
  it("parses the nager.date shape, tolerates junk", () => {
    const body = JSON.stringify([{ date: "2026-01-01", localName: "New Year's Day", name: "New Year's Day" }, { nope: 1 }]);
    const out = parseHolidays(body);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ date: "2026-01-01", localName: "New Year's Day", name: "New Year's Day" });
    expect(parseHolidays("not json")).toEqual([]);
    expect(parseHolidays("{}")).toEqual([]);
  });
});

describe("parseHolidayIntent", () => {
  it("classifies is-today / list / next", () => {
    expect(parseHolidayIntent("is today a holiday")).toBe("is-today");
    expect(parseHolidayIntent("is it a holiday today?")).toBe("is-today");
    expect(parseHolidayIntent("what are the holidays this year")).toBe("list");
    expect(parseHolidayIntent("list all public holidays in 2026")).toBe("list");
    expect(parseHolidayIntent("when's the next public holiday")).toBe("next");
    expect(parseHolidayIntent("next holiday")).toBe("next");
  });
});

describe("runHolidays", () => {
  const next = JSON.stringify([{ date: "2026-09-07", localName: "Labor Day", name: "Labour Day" }]);
  const year = JSON.stringify([
    { date: "2026-01-01", localName: "New Year's Day", name: "New Year's Day" },
    { date: "2026-09-07", localName: "Labor Day", name: "Labour Day" },
  ]);
  const fetcher = (byUrl: Record<string, string>) => async (url: string) => {
    if (/NextPublicHolidays/.test(url)) return byUrl.next ?? "[]";
    if (/PublicHolidays/.test(url)) return byUrl.year ?? "[]";
    return "[]";
  };

  it("answers 'next public holiday' with the upcoming one + days-until", async () => {
    const out = await runHolidays("next public holiday", undefined, "2026-09-01", fetcher({ next }));
    expect(out).toMatch(/next public holiday in US is Labor Day/i);
    expect(out).toMatch(/September 7, 2026/);
    expect(out).toMatch(/in 6 days/);
  });

  it("answers 'is today a holiday' — yes when today matches", async () => {
    const out = await runHolidays("is today a holiday", "US", "2026-01-01", fetcher({ next, year }));
    expect(out).toMatch(/^Yes/);
    expect(out).toMatch(/New Year's Day/);
  });

  it("answers 'is today a holiday' — no, with the next one appended", async () => {
    const out = await runHolidays("is today a holiday", "US", "2026-06-15", fetcher({ next, year }));
    expect(out).toMatch(/^No/);
    expect(out).toMatch(/next one is Labor Day/i);
  });

  it("lists a year's holidays for a named country", async () => {
    const out = await runHolidays("holidays this year in the UK", "UK", "2026-03-01", fetcher({ year }));
    expect(out).toMatch(/Public holidays in GB for 2026 \(2\)/);
    expect(out).toMatch(/New Year's Day/);
  });

  it("defaults to US when no country + returns null on an empty source", async () => {
    expect(await runHolidays("next holiday", undefined, "2026-01-01", async () => "[]")).toBeNull();
  });

  it("builds the right URLs", () => {
    expect(nextHolidaysUrl("GB")).toMatch(/NextPublicHolidays\/GB$/);
    expect(yearHolidaysUrl(2026, "US")).toMatch(/PublicHolidays\/2026\/US$/);
  });
});
