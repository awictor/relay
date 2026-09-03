import { describe, it, expect } from "vitest";
import { sunUrl, isSunRequest, sunDayIndex, sunPlace, parseSunTimes, formatSunTimes, getSunTimes } from "../src/lib/suntimes.js";

const body = JSON.stringify({
  daily: {
    time: ["2026-09-03", "2026-09-04"],
    sunrise: ["2026-09-03T06:30", "2026-09-04T06:31"],
    sunset: ["2026-09-03T19:28", "2026-09-04T19:26"],
    daylight_duration: [46685.7, 46534.09],
  },
});
const geoBody = JSON.stringify({ results: [{ latitude: 39.74, longitude: -104.99, name: "Denver", admin1: "Colorado", country: "United States" }] });

describe("isSunRequest / sunDayIndex / sunPlace", () => {
  it("detects sun/daylight asks", () => {
    expect(isSunRequest("what time is sunset today")).toBe(true);
    expect(isSunRequest("when's sunrise tomorrow")).toBe(true);
    expect(isSunRequest("is it dark by 7")).toBe(true);
    expect(isSunRequest("how much daylight today")).toBe(true);
    expect(isSunRequest("what's the weather")).toBe(false);
  });
  it("picks today vs tomorrow", () => {
    expect(sunDayIndex("sunset today")).toBe(0);
    expect(sunDayIndex("sunrise tomorrow")).toBe(1);
  });
  it("extracts a trailing 'in <place>', rejecting time/word tails", () => {
    expect(sunPlace("sunset in Denver")).toBe("Denver");
    expect(sunPlace("when's sunrise tomorrow in Paris")).toBe("Paris");
    expect(sunPlace("is it dark in 2 hours")).toBeNull();
    expect(sunPlace("how much daylight")).toBeNull();
  });
});

describe("sunUrl", () => {
  it("requests daily sunrise/sunset/daylight with tz=auto", () => {
    const u = sunUrl(39.74, -104.99);
    expect(u).toContain("daily=sunrise,sunset,daylight_duration");
    expect(u).toContain("timezone=auto");
  });
});

describe("parseSunTimes / formatSunTimes", () => {
  it("parses today's times to 12h clock + daylight h/m", () => {
    const s = parseSunTimes(body, "Denver", 0)!;
    expect(s).toMatchObject({ place: "Denver", day: "today", sunrise: "6:30 AM", sunset: "7:28 PM" });
    expect(s.daylight).toMatch(/^12h \d+m$/);
  });
  it("parses tomorrow's times", () => {
    expect(parseSunTimes(body, "Denver", 1)!.sunset).toBe("7:26 PM");
  });
  it("formats a human line", () => {
    const out = formatSunTimes(parseSunTimes(body, "Denver", 0)!);
    expect(out).toMatch(/Today in Denver: sunrise 6:30 AM, sunset 7:28 PM/);
  });
  it("returns null on malformed / missing", () => {
    expect(parseSunTimes("not json", "x", 0)).toBeNull();
    expect(parseSunTimes(JSON.stringify({ daily: {} }), "x", 0)).toBeNull();
  });
});

describe("getSunTimes", () => {
  it("geocodes a named place then fetches sun times", async () => {
    const urls: string[] = [];
    const s = await getSunTimes({ text: "sunset in Denver" }, async (u) => { urls.push(u); return u.includes("geocoding") ? geoBody : body; });
    expect(urls.some((u) => u.includes("geocoding"))).toBe(true);
    expect(s!.place).toMatch(/Denver/);
    expect(s!.sunset).toBe("7:28 PM");
  });
  it("uses saved coords when no place named (no geocode)", async () => {
    let geocoded = false;
    const s = await getSunTimes({ text: "what time is sunset", lat: 39.74, lng: -104.99 }, async (u) => { if (u.includes("geocoding")) geocoded = true; return body; });
    expect(geocoded).toBe(false);
    expect(s!.place).toBe("your location");
  });
  it("null with no place + no coords, or on a fetch throw", async () => {
    expect(await getSunTimes({ text: "sunset" }, async () => body)).toBeNull();
    expect(await getSunTimes({ text: "sunset", lat: 1, lng: 2 }, async () => { throw new Error("net"); })).toBeNull();
  });
});
