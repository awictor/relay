import { describe, it, expect } from "vitest";
import { buildIcs, gcalLink, formatCalendar, normalizeIsoDate } from "../src/lib/calendar.js";

const NOW = Date.UTC(2024, 5, 1, 12, 0, 0); // 2024-06-01T12:00:00Z
const START = Date.UTC(2024, 5, 2, 13, 0, 0); // 2024-06-02T13:00:00Z

describe("buildIcs (ics-calendar-export)", () => {
  it("builds a timed VEVENT with DTSTART/DTEND (default 60m)", () => {
    const ics = buildIcs({ title: "Dentist", startMs: START, location: "123 Main" }, NOW);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("DTSTART:20240602T130000Z");
    expect(ics).toContain("DTEND:20240602T140000Z"); // +60m
    expect(ics).toContain("SUMMARY:Dentist");
    expect(ics).toContain("LOCATION:123 Main");
    expect(ics).toContain("DTSTAMP:20240601T120000Z");
  });
  it("builds an all-day VEVENT with VALUE=DATE", () => {
    const ics = buildIcs({ title: "Trip", startDate: "2024-07-04" }, NOW);
    expect(ics).toContain("DTSTART;VALUE=DATE:20240704");
    expect(ics).not.toContain("DTEND"); // all-day single day
  });
  it("escapes commas/semicolons/newlines in text", () => {
    const ics = buildIcs({ title: "A, B; C", startDate: "2024-07-04", description: "line1\nline2" }, NOW);
    expect(ics).toContain("SUMMARY:A\\, B\\; C");
    expect(ics).toContain("DESCRIPTION:line1\\nline2");
  });
});

describe("gcalLink", () => {
  it("builds a timed Google Calendar template link", () => {
    const link = gcalLink({ title: "Dentist", startMs: START });
    expect(link).toContain("action=TEMPLATE");
    expect(link).toContain("text=Dentist");
    expect(link).toContain("dates=20240602T130000Z%2F20240602T140000Z");
  });
  it("all-day uses an exclusive next-day end", () => {
    const link = gcalLink({ title: "Trip", startDate: "2024-07-04" });
    expect(link).toContain("dates=20240704%2F20240705");
  });
});

describe("formatCalendar", () => {
  it("renders a when line + both links (gcal + .ics data URL)", () => {
    const out = formatCalendar({ title: "Dentist", startMs: START, location: "Clinic" }, NOW);
    expect(out).toMatch(/📅 Dentist —/);
    expect(out).toMatch(/Where: Clinic/);
    expect(out).toMatch(/Add to Google Calendar: https:\/\/calendar\.google\.com/);
    expect(out).toMatch(/Or import \(\.ics\): data:text\/calendar/);
  });
});

describe("normalizeIsoDate (calendar bad-date guard)", () => {
  it("accepts a strict YYYY-MM-DD", () => {
    expect(normalizeIsoDate("2026-07-04")).toBe("2026-07-04");
  });
  it("rejects unpadded / non-ISO / impossible dates", () => {
    expect(normalizeIsoDate("2026-6-3")).toBeNull();
    expect(normalizeIsoDate("July 4")).toBeNull();
    expect(normalizeIsoDate("2026-02-31")).toBeNull();
    expect(normalizeIsoDate(undefined)).toBeNull();
  });
});

describe("calendar handles a bad startDate without crashing (reliability)", () => {
  it("buildIcs + gcalLink don't throw on a non-ISO startDate; drop the date instead", () => {
    const ev = { title: "X", startDate: "June 3" };
    expect(() => buildIcs(ev, NOW)).not.toThrow();
    expect(() => gcalLink(ev)).not.toThrow();
    // The malformed date is dropped (no DTSTART / no dates= param), not emitted broken.
    expect(buildIcs(ev, NOW)).not.toContain("DTSTART");
    expect(gcalLink(ev)).not.toContain("dates=");
  });
});
