import { describe, it, expect, afterEach } from "vitest";
import { parseSetLocation, parseUtcOffset, formatUtcOffset, ProfileStore, needsLocationContext, parseCityReply, inferTzFromLocation } from "../src/lib/profile.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-prof-")); dirs.push(d); return join(d, "p.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("parseSetLocation", () => {
  it("parses the /setlocation command (+infers tz from the city, city-to-tz-inference)", () => {
    expect(parseSetLocation("/setlocation Austin, TX")).toEqual({ location: "Austin, TX", tzOffsetMin: -360 });
  });
  it("parses natural phrasings (+infers tz)", () => {
    expect(parseSetLocation("set my location to London")).toEqual({ location: "London", tzOffsetMin: 0 });
    expect(parseSetLocation("I'm in Paris")).toEqual({ location: "Paris", tzOffsetMin: 60 });
    expect(parseSetLocation("my location is Berlin")).toEqual({ location: "Berlin", tzOffsetMin: 60 });
  });
  it("captures units in parens or 'in metric' (+infers tz)", () => {
    expect(parseSetLocation("/setlocation Denver (imperial)")).toEqual({ location: "Denver", units: "imperial", tzOffsetMin: -420 });
    expect(parseSetLocation("I'm in Tokyo in metric")).toEqual({ location: "Tokyo", units: "metric", tzOffsetMin: 540 });
  });
  it("leaves tz unset for an unknown city (no wrong guess)", () => {
    expect(parseSetLocation("/setlocation Smallville")).toEqual({ location: "Smallville" });
  });
  it("captures a UTC offset clause without swallowing the place (tz-from-location)", () => {
    expect(parseSetLocation("/setlocation NYC UTC-5")).toEqual({ location: "NYC", tzOffsetMin: -300 });
    expect(parseSetLocation("I'm in Berlin UTC+1 (metric)")).toEqual({ location: "Berlin", units: "metric", tzOffsetMin: 60 });
    expect(parseSetLocation("set my location to Mumbai GMT+5:30")).toEqual({ location: "Mumbai", tzOffsetMin: 330 });
  });
  it("does NOT hijack a conversational 'I'm in ...' that carries a task (greedy-location-setter)", () => {
    expect(parseSetLocation("I'm in a meeting, remind me in 10 min")).toBeNull();
    expect(parseSetLocation("I'm in the middle of something, call me later")).toBeNull();
    expect(parseSetLocation("I am in a rush today")).toBeNull();
    expect(parseSetLocation("I'm in line at the store and need the weather")).toBeNull();
  });
  it("still accepts a bare 'I'm in <place>' and explicit forms (tz inferred where known)", () => {
    expect(parseSetLocation("I'm in Paris")).toEqual({ location: "Paris", tzOffsetMin: 60 });
    expect(parseSetLocation("I'm in New York City")).toEqual({ location: "New York City", tzOffsetMin: -300 });
    expect(parseSetLocation("I'm in Tokyo in metric")).toEqual({ location: "Tokyo", units: "metric", tzOffsetMin: 540 });
    // explicit forms stay permissive (a comma place is fine there)
    expect(parseSetLocation("set my location to Austin, TX")).toEqual({ location: "Austin, TX", tzOffsetMin: -360 });
  });
  it("returns null for a non-location message", () => {
    expect(parseSetLocation("what's the weather")).toBeNull();
    expect(parseSetLocation("/setlocation")).toBeNull(); // no place
  });
});

describe("parseUtcOffset", () => {
  it("parses signed hour/min offsets", () => {
    expect(parseUtcOffset("UTC-5")).toBe(-300);
    expect(parseUtcOffset("utc+1")).toBe(60);
    expect(parseUtcOffset("GMT+5:30")).toBe(330);
    expect(parseUtcOffset("gmt-0")).toBe(0);
  });
  it("returns null when absent or out of range", () => {
    expect(parseUtcOffset("Austin")).toBeNull();
    expect(parseUtcOffset("UTC+20")).toBeNull(); // >14h
  });
});

describe("formatUtcOffset (halfhour-tz-rounding)", () => {
  it("preserves half/quarter-hour minutes instead of rounding to whole hours", () => {
    expect(formatUtcOffset(330)).toBe("UTC+5:30");   // India (was wrongly "UTC+6")
    expect(formatUtcOffset(-210)).toBe("UTC-3:30");  // Newfoundland (was wrongly "UTC-3")
    expect(formatUtcOffset(345)).toBe("UTC+5:45");   // Nepal
  });
  it("whole-hour + zero offsets read cleanly", () => {
    expect(formatUtcOffset(-300)).toBe("UTC-5");
    expect(formatUtcOffset(60)).toBe("UTC+1");
    expect(formatUtcOffset(0)).toBe("UTC+0");
  });
  it("round-trips with parseUtcOffset", () => {
    for (const s of ["UTC-5", "UTC+5:30", "UTC-3:30", "UTC+0"]) {
      expect(formatUtcOffset(parseUtcOffset(s)!)).toBe(s);
    }
  });
});

describe("ProfileStore", () => {
  it("set/get/merge + contextLine, persisted", () => {
    const f = tmp();
    const s = new ProfileStore({ file: f });
    s.set(1, { location: "Austin, TX" });
    expect(s.get(1)!.location).toBe("Austin, TX");
    expect(s.contextLine(1)).toMatch(/home location is Austin, TX/);
    s.set(1, { units: "imperial" }); // merge, not overwrite
    expect(s.get(1)!.location).toBe("Austin, TX");
    expect(s.contextLine(1)).toMatch(/imperial units/);
    // reload from disk -> persisted
    const s2 = new ProfileStore({ file: f });
    expect(s2.get(1)!.location).toBe("Austin, TX");
    expect(s2.get(1)!.units).toBe("imperial");
  });
  it("stores + exposes tzOffsetMin, surfaces it in contextLine (tz-from-location)", () => {
    const s = new ProfileStore({ file: tmp() });
    expect(s.offsetMin(1)).toBeUndefined(); // unset -> caller falls back to global
    s.set(1, { location: "NYC", tzOffsetMin: -300 });
    expect(s.offsetMin(1)).toBe(-300);
    expect(s.contextLine(1)).toMatch(/timezone is UTC-5/);
    s.set(2, { location: "Mumbai", tzOffsetMin: 330 });
    expect(s.contextLine(2)).toMatch(/timezone is UTC\+5:30/); // half-hour zone shown correctly
  });
  it("contextLine is empty for an unknown chat", () => {
    expect(new ProfileStore({ file: tmp() }).contextLine(99)).toBe("");
  });
  it("stores + surfaces coords from a location pin (telegram-location-pin)", () => {
    const s = new ProfileStore({ file: tmp() });
    s.set(1, { lat: 30.2711, lng: -97.7437 });
    expect(s.get(1)!.lat).toBe(30.2711);
    expect(s.contextLine(1)).toMatch(/current coordinates are 30\.27110,-97\.74370/);
  });
  it("clear() forgets a chat's profile + reports whether there was one (profile-view-reset)", () => {
    const f = tmp();
    const s = new ProfileStore({ file: f });
    s.set(1, { location: "Paris", tzOffsetMin: 60 });
    expect(s.clear(1)).toBe(true);
    expect(s.get(1)).toBeUndefined();
    expect(s.clear(1)).toBe(false); // nothing left
    expect(new ProfileStore({ file: f }).get(1)).toBeUndefined(); // persisted
  });
});

describe("inferTzFromLocation (city-to-tz-inference)", () => {
  it("maps common cities to their standard offset", () => {
    expect(inferTzFromLocation("Austin")).toBe(-360);
    expect(inferTzFromLocation("New York")).toBe(-300);
    expect(inferTzFromLocation("London")).toBe(0);
    expect(inferTzFromLocation("Tokyo")).toBe(540);
    expect(inferTzFromLocation("Mumbai")).toBe(330);
    expect(inferTzFromLocation("Sydney")).toBe(600);
  });
  it("matches a 'City, ST'/'City, Country' form and state abbreviations", () => {
    expect(inferTzFromLocation("Austin, TX")).toBe(-360);
    expect(inferTzFromLocation("Portland, OR")).toBe(-480); // city wins (OR would also be -480)
    expect(inferTzFromLocation("somewhere in CA")).toBe(-480);
  });
  it("null for an unknown place (never a wrong guess)", () => {
    expect(inferTzFromLocation("Smallville")).toBeNull();
    expect(inferTzFromLocation("")).toBeNull();
  });
});

describe("needsLocationContext (first-location-capture)", () => {
  it("true for location-dependent errands", () => {
    for (const t of ["weather", "what's the weather", "weather tomorrow", "sushi near me", "coffee nearby", "how far to the airport", "directions to downtown", "will it rain today"]) {
      expect(needsLocationContext(t), t).toBe(true);
    }
  });
  it("false for errands that don't depend on where you are", () => {
    for (const t of ["top HN story", "price of bitcoin", "who won the game", "summarize this link", "remind me to stretch"]) {
      expect(needsLocationContext(t), t).toBe(false);
    }
  });
});

describe("parseCityReply (first-location-capture)", () => {
  it("accepts a bare city, stripping a polite lead-in + a tz clause, inferring tz from the city", () => {
    expect(parseCityReply("Austin, TX")).toEqual({ location: "Austin, TX", tzOffsetMin: -360 });
    expect(parseCityReply("I'm in London")).toEqual({ location: "London", tzOffsetMin: 0 });
    expect(parseCityReply("it's Paris")).toEqual({ location: "Paris", tzOffsetMin: 60 });
    expect(parseCityReply("Denver UTC-7")).toEqual({ location: "Denver", tzOffsetMin: -420 }); // explicit wins
    expect(parseCityReply("Smallville")).toEqual({ location: "Smallville" }); // unknown -> no tz guess
  });
  it("rejects a reply that clearly isn't a place (bail-out / fresh task / question)", () => {
    expect(parseCityReply("/help")).toBeNull();
    expect(parseCityReply("actually never mind show me the top HN story")).toBeNull();
    expect(parseCityReply("what can you do?")).toBeNull();
    expect(parseCityReply("remind me to call mom")).toBeNull();
    expect(parseCityReply("")).toBeNull();
  });
});
