import { describe, it, expect } from "vitest";
import { parseCountdown, countdownMilestones, formatCountdown, milestonePing, MILESTONE_DAYS } from "../src/lib/countdown.js";

const TODAY = { y: 2026, m: 6, d: 1 }; // June 1 2026
// now = midnight UTC of TODAY, so "days away" math lines up with the injected today.
const NOW = Date.UTC(2026, 5, 1);

describe("parseCountdown", () => {
  it("parses 'countdown to <label> <date>' + computes days away", () => {
    const c = parseCountdown("countdown to my flight Dec 20", TODAY)!;
    expect(c).toMatchObject({ label: "flight", target: { y: 2026, m: 12, d: 20 } });
    expect(c.daysAway).toBe(202); // Jun 1 -> Dec 20 2026
  });
  it("handles 'days until <label> on <ISO>' and strips my/the + on/by", () => {
    const c = parseCountdown("days until vacation on 2026-07-01", TODAY)!;
    expect(c.label).toBe("vacation");
    expect(c.target).toEqual({ y: 2026, m: 7, d: 1 });
    expect(c.daysAway).toBe(30);
  });
  it("rolls a bare month/day forward to the next occurrence (preferFuture)", () => {
    const c = parseCountdown("countdown to the party on Jan 5", TODAY)!; // Jan already past this year
    expect(c.target.y).toBe(2027);
  });
  it("labels a bare-holiday countdown with the holiday name, not 'it' (countdown-holiday-label)", () => {
    // "days until Christmas" — the holiday IS both the label and the date anchor; it must read as
    // "Christmas", not "it".
    const xmas = parseCountdown("days until Christmas", TODAY)!;
    expect(xmas.label).toBe("Christmas");
    expect(xmas.target).toEqual({ y: 2026, m: 12, d: 25 });
    expect(parseCountdown("countdown to Halloween", TODAY)!.label).toBe("Halloween");
    expect(parseCountdown("countdown to thanksgiving", TODAY)!.label).toBe("thanksgiving");
    // a bare numeric/ISO date has no name -> stays "it" (nothing to name it).
    expect(parseCountdown("days until 2026-07-01", TODAY)!.label).toBe("it");
  });
  it("accepts a 'start/set/create a [new] countdown to …' lead (countdown-start-a-lead)", () => {
    expect(parseCountdown("start a countdown to my birthday June 3", TODAY)!.label).toBe("birthday");
    expect(parseCountdown("set up a countdown to vacation on 2026-07-01", TODAY)!.label).toBe("vacation");
    expect(parseCountdown("create a new countdown to Christmas", TODAY)!.label).toBe("Christmas");
    // still needs a real countdown intent — a bare imperative isn't one
    expect(parseCountdown("start a fire", TODAY)).toBeNull();
  });
  it("null when there's no parseable date", () => {
    expect(parseCountdown("countdown to something someday", TODAY)).toBeNull();
    expect(parseCountdown("what's the weather", TODAY)).toBeNull();
  });
});

describe("countdownMilestones", () => {
  it("returns only FUTURE milestone instants at 9am local (further-out ones get all, near-term fewer)", () => {
    const target = { y: 2026, m: 12, d: 20 };
    const ms = countdownMilestones(target, NOW, 0);
    // 202 days out -> all four milestones (30/7/1/0) are future.
    expect(ms.map((m) => m.daysBefore)).toEqual(MILESTONE_DAYS);
    // 30-days-before = Nov 20, 9am UTC.
    expect(ms[0]!.whenMs).toBe(Date.UTC(2026, 10, 20, 9));
  });
  it("drops milestones already in the past for a near-term target", () => {
    const target = { y: 2026, m: 6, d: 3 }; // 2 days out
    const ms = countdownMilestones(target, NOW, 0);
    // 30d + 7d before are in the past; only 1-day-before (Jun 2) + day-of (Jun 3) remain.
    expect(ms.map((m) => m.daysBefore)).toEqual([1, 0]);
  });
  it("applies the tz offset (local 9am -> UTC)", () => {
    const target = { y: 2026, m: 12, d: 20 };
    const utc = countdownMilestones(target, NOW, 0)[0]!.whenMs;
    const est = countdownMilestones(target, NOW, -300)[0]!.whenMs; // UTC-5
    expect(est - utc).toBe(300 * 60_000); // 9am EST is 5h later in UTC
  });
});

describe("formatCountdown / milestonePing", () => {
  it("confirms the day count + target", () => {
    expect(formatCountdown(parseCountdown("countdown to vacation on 2026-07-01", TODAY)!)).toMatch(/30 days until "vacation"/);
    expect(formatCountdown({ label: "trip", target: { y: 2026, m: 6, d: 1 }, daysAway: 0 })).toMatch(/Today's the day/);
    expect(formatCountdown({ label: "trip", target: { y: 2026, m: 5, d: 30 }, daysAway: -2 })).toMatch(/has passed/);
  });
  it("milestone ping text scales by daysBefore", () => {
    expect(milestonePing("vacation", 0)).toMatch(/Today's the day/);
    expect(milestonePing("vacation", 1)).toMatch(/Tomorrow/);
    expect(milestonePing("vacation", 7)).toMatch(/7 days until/);
  });
});
