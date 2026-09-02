import { describe, it, expect, afterEach } from "vitest";
import { parseSetLocation, ProfileStore } from "../src/lib/profile.js";
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
  it("returns null for a non-location message", () => {
    expect(parseSetLocation("what's the weather")).toBeNull();
    expect(parseSetLocation("/setlocation")).toBeNull(); // no place
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
  it("contextLine is empty for an unknown chat", () => {
    expect(new ProfileStore({ file: tmp() }).contextLine(99)).toBe("");
  });
});
