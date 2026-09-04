import { describe, it, expect } from "vitest";
import { runDateCalc, parseDate, weekdayName, formatDate, type Ymd } from "../src/lib/datecalc.js";

// Fixed "today" so every test is deterministic: Thursday, September 3, 2026.
const TODAY: Ymd = { y: 2026, m: 9, d: 3 };

describe("parseDate", () => {
  it("parses ISO, US numeric, and month-name forms", () => {
    expect(parseDate("2026-12-25", TODAY)).toEqual({ y: 2026, m: 12, d: 25 });
    expect(parseDate("7/4/2026", TODAY)).toEqual({ y: 2026, m: 7, d: 4 });
    expect(parseDate("July 4 2026", TODAY)).toEqual({ y: 2026, m: 7, d: 4 });
    expect(parseDate("4 July 2026", TODAY)).toEqual({ y: 2026, m: 7, d: 4 });
    expect(parseDate("December 25th", TODAY)).toEqual({ y: 2026, m: 12, d: 25 });
  });
  it("resolves today/tomorrow/yesterday against the supplied today", () => {
    expect(parseDate("today", TODAY)).toEqual(TODAY);
    expect(parseDate("tomorrow", TODAY)).toEqual({ y: 2026, m: 9, d: 4 });
    expect(parseDate("yesterday", TODAY)).toEqual({ y: 2026, m: 9, d: 2 });
  });
  it("knows named holidays (fixed + computed Thanksgiving)", () => {
    expect(parseDate("christmas", TODAY)).toEqual({ y: 2026, m: 12, d: 25 });
    expect(parseDate("halloween", TODAY)).toEqual({ y: 2026, m: 10, d: 31 });
    // 4th Thursday of Nov 2026 = Nov 26.
    expect(parseDate("thanksgiving", TODAY)).toEqual({ y: 2026, m: 11, d: 26 });
  });
  it("preferFuture rolls a past bare date to next year", () => {
    // July 4 already passed (today is Sept 3) -> next year's.
    expect(parseDate("July 4", TODAY, true)).toEqual({ y: 2027, m: 7, d: 4 });
    // Without preferFuture, stays this year.
    expect(parseDate("July 4", TODAY, false)).toEqual({ y: 2026, m: 7, d: 4 });
  });
  it("rejects an impossible date", () => {
    expect(parseDate("Feb 30 2026", TODAY)).toBeNull();
    expect(parseDate("13/40/2026", TODAY)).toBeNull();
    expect(parseDate("gibberish", TODAY)).toBeNull();
  });
});

describe("weekdayName / formatDate", () => {
  it("names the correct weekday", () => {
    expect(weekdayName({ y: 2026, m: 7, d: 4 })).toBe("Saturday"); // July 4 2026 is a Saturday
    expect(weekdayName(TODAY)).toBe("Thursday");
  });
  it("formats a human date", () => {
    expect(formatDate({ y: 2026, m: 7, d: 4 })).toBe("Saturday, July 4, 2026");
  });
});

describe("runDateCalc", () => {
  it("days until a holiday (rolls to the next occurrence)", () => {
    // Sept 3 -> Dec 25 2026 = 113 days (a Friday).
    expect(runDateCalc("how many days until Christmas", TODAY)).toMatch(/113 days until Friday, December 25, 2026/i);
  });
  it("days until a bare date already past this year uses next year", () => {
    const out = runDateCalc("days until July 4", TODAY)!;
    expect(out).toMatch(/2027/); // rolled forward, not a negative
  });
  it("what day of the week is a date", () => {
    expect(runDateCalc("what day of the week is July 4 2026", TODAY)).toMatch(/Saturday/);
    expect(runDateCalc("what day was 2020-01-01", TODAY)).toMatch(/Wednesday/); // Jan 1 2020 = Wed
  });
  it("age from a birthdate", () => {
    expect(runDateCalc("how old is someone born 1990-05-06", TODAY)).toMatch(/36 years and 3 months old/);
    expect(runDateCalc("how old if born in 1990", TODAY)).toMatch(/36 years and 8 months old/); // born Jan 1 1990
  });
  it("days between two dates", () => {
    expect(runDateCalc("how many days between March 1 2026 and April 1 2026", TODAY)).toMatch(/31 days/);
  });
  it("date N days/weeks from today", () => {
    expect(runDateCalc("what's the date in 10 days", TODAY)).toMatch(/Sunday, September 13, 2026/);
    expect(runDateCalc("2 weeks from now", TODAY)).toMatch(/September 17, 2026/);
  });
  it("returns null for a non-date question (so the agent can route elsewhere)", () => {
    expect(runDateCalc("what's the weather", TODAY)).toBeNull();
    expect(runDateCalc("", TODAY)).toBeNull();
  });
  it("a target that is today says so", () => {
    expect(runDateCalc("how many days until today", TODAY)).toMatch(/is today/);
  });
  it("days until a LABELED date ('my birthday on X', 'the deadline is X') peels the label (datecalc-labeled-until)", () => {
    // The label ('my birthday on', 'the deadline is') used to make parseDate fail -> null -> slow agent guess.
    expect(runDateCalc("how many days until my birthday on 2026-12-25", TODAY)).toMatch(/December 25, 2026/);
    expect(runDateCalc("how many days until the deadline is July 4 2027", TODAY)).toMatch(/July 4, 2027/);
    expect(runDateCalc("days until my trip on 2026-12-01", TODAY)).toMatch(/December 1, 2026/);
    // still null when there's genuinely no date to peel
    expect(runDateCalc("how many days until something vague", TODAY)).toBeNull();
  });

  it("resolves 'days until <weekday>' to the next matching day (date-until-weekday)", () => {
    // TODAY = 2026-09-03 is a THURSDAY.
    expect(runDateCalc("days until friday", TODAY)).toMatch(/^1 day until Friday, September 4, 2026\./); // tomorrow
    expect(runDateCalc("how many days until next friday", TODAY)).toMatch(/^1 day until Friday, September 4/);
    expect(runDateCalc("days until monday", TODAY)).toMatch(/^4 days until Monday, September 7/);
    expect(runDateCalc("how long until sunday", TODAY)).toMatch(/^3 days until Sunday, September 6/);
    expect(runDateCalc("days until thursday", TODAY)).toMatch(/^7 days until Thursday, September 10/); // today is Thu -> next week
    expect(runDateCalc("days until sat", TODAY)).toMatch(/^2 days until Saturday, September 5/);        // abbrev
    expect(runDateCalc("what day is next monday", TODAY)).toMatch(/Monday, September 7, 2026/);
  });

  it("a bare weekday word only matches real weekdays (not month words / junk)", () => {
    expect(parseDate("friday", TODAY, true)).toEqual({ y: 2026, m: 9, d: 4 });
    expect(parseDate("may", TODAY, true)).toBeNull();      // month word, no day -> not a weekday match
    expect(parseDate("launch", TODAY, true)).toBeNull();
    expect(parseDate("something", TODAY, true)).toBeNull();
  });

  it("'days since <past date>' gives elapsed days; a future date redirects to 'until' (date-since)", () => {
    // TODAY = 2026-09-03.
    expect(runDateCalc("days since 2020-01-01", TODAY)).toMatch(/^2437 days since Wednesday, January 1, 2020\./);
    expect(runDateCalc("how many days since 2026-01-01", TODAY)).toMatch(/^245 days since/);
    expect(runDateCalc("how long since July 4", TODAY)).toMatch(/^61 days since Saturday, July 4, 2026/);
    expect(runDateCalc("weeks since 2026-08-01", TODAY)).toMatch(/33 days \(4\.7 weeks\) since/);
    expect(runDateCalc("days since my anniversary on 1990-05-06", TODAY)).toMatch(/since Sunday, May 6, 1990/);
    // a future date isn't "since" — nudge to "until" rather than a negative count
    expect(runDateCalc("days since 2027-01-01", TODAY)).toMatch(/still \d+ days away — ask "days until"/);
    expect(runDateCalc("days since", TODAY)).toBeNull();   // no date -> not this tool
  });

  it("business-day date math skips weekends (date-business-days)", () => {
    // TODAY = 2026-09-03 is a THURSDAY.
    expect(runDateCalc("3 business days from now", TODAY)).toMatch(/is Tuesday, September 8, 2026/); // Thu+3bd: Fri,Mon,Tue
    expect(runDateCalc("1 business day from now", TODAY)).toMatch(/is Friday, September 4, 2026/);
    expect(runDateCalc("2 working days from now", TODAY)).toMatch(/is Monday, September 7, 2026/);   // Fri then Mon
    expect(runDateCalc("5 business days after 2026-09-04", TODAY)).toMatch(/is Friday, September 11, 2026/); // Fri+5bd
    expect(runDateCalc("3 business days from now", TODAY)).toMatch(/weekends skipped/);
    // plain "days" is unaffected (not intercepted by the business branch)
    expect(runDateCalc("3 days from now", TODAY)).toMatch(/3 days from today is Sunday, September 6, 2026/);
  });
});
