import { describe, it, expect, afterEach } from "vitest";
import { parseSetLocation, parseUtcOffset, ProfileStore } from "../src/lib/profile.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-prof-")); dirs.push(d); return join(d, "p.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("parseSetLocation", () => {
  it("parses the /setlocation command", () => {
    expect(parseSetLocation("/setlocation Austin, TX")).toEqual({ location: "Austin, TX" });
  });
  it("parses natural phrasings", () => {
    expect(parseSetLocation("set my location to London")).toEqual({ location: "London" });
    expect(parseSetLocation("I'm in Paris")).toEqual({ location: "Paris" });
    expect(parseSetLocation("my location is Berlin")).toEqual({ location: "Berlin" });
  });
  it("captures units in parens or 'in metric'", () => {
    expect(parseSetLocation("/setlocation Denver (imperial)")).toEqual({ location: "Denver", units: "imperial" });
    expect(parseSetLocation("I'm in Tokyo in metric")).toEqual({ location: "Tokyo", units: "metric" });
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
  it("still accepts a bare 'I'm in <place>' and explicit forms", () => {
    expect(parseSetLocation("I'm in Paris")).toEqual({ location: "Paris" });
    expect(parseSetLocation("I'm in New York City")).toEqual({ location: "New York City" });
    expect(parseSetLocation("I'm in Tokyo in metric")).toEqual({ location: "Tokyo", units: "metric" });
    // explicit forms stay permissive (a comma place is fine there)
    expect(parseSetLocation("set my location to Austin, TX")).toEqual({ location: "Austin, TX" });
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
  });
  it("contextLine is empty for an unknown chat", () => {
    expect(new ProfileStore({ file: tmp() }).contextLine(99)).toBe("");
  });
});
