import { describe, it, expect } from "vitest";
import { airQualityUrl, isAirRequest, isUvRequest, isPollenRequest, airPlace, aqiCategory, uvRisk, pollenRisk, parseAirQuality, formatAirQuality, getAirQuality } from "../src/lib/airquality.js";

describe("aqiCategory / uvRisk", () => {
  it("maps AQI to EPA bands", () => {
    expect(aqiCategory(30)).toBe("Good");
    expect(aqiCategory(75)).toBe("Moderate");
    expect(aqiCategory(120)).toBe("Unhealthy for sensitive groups");
    expect(aqiCategory(175)).toBe("Unhealthy");
    expect(aqiCategory(250)).toBe("Very unhealthy");
    expect(aqiCategory(400)).toBe("Hazardous");
  });
  it("maps UV to risk words", () => {
    expect(uvRisk(1)).toBe("low");
    expect(uvRisk(4)).toBe("moderate");
    expect(uvRisk(7)).toBe("high");
    expect(uvRisk(9)).toBe("very high");
    expect(uvRisk(12)).toBe("extreme");
  });
});

describe("isAirRequest / isUvRequest / airPlace", () => {
  it("recognizes air + UV asks", () => {
    for (const t of ["how's the air", "is it smoky today", "what's the AQI", "safe to run outside?", "do I need sunscreen", "what's the UV"]) expect(isAirRequest(t), t).toBe(true);
    expect(isAirRequest("what's the weather")).toBe(false);
  });
  it("flags UV-specific asks so the reply leads with UV", () => {
    expect(isUvRequest("do I need sunscreen")).toBe(true);
    expect(isUvRequest("what's the uv index")).toBe(true);
    expect(isUvRequest("how's the air")).toBe(false);
  });
  it("extracts a trailing 'in <place>', rejecting time/adjective tails", () => {
    expect(airPlace("is the air bad in Los Angeles")).toBe("Los Angeles");
    expect(airPlace("air quality in 2 hours")).toBeNull();
    expect(airPlace("how's the air")).toBeNull();
  });
});

describe("parseAirQuality / formatAirQuality", () => {
  const body = JSON.stringify({ current: { us_aqi: 48, pm2_5: 3, pm10: 3.7, ozone: 39, uv_index: 7 } });
  it("parses the current block", () => {
    const a = parseAirQuality(body, "Austin")!;
    expect(a).toMatchObject({ place: "Austin", aqi: 48, category: "Good", pm25: 3, uv: 7 });
  });
  it("null when the current block or us_aqi is missing", () => {
    expect(parseAirQuality(JSON.stringify({ current: {} }), "x")).toBeNull();
    expect(parseAirQuality("nope", "x")).toBeNull();
  });
  it("no daily uv -> falls back to the instant UV labeled 'right now'", () => {
    const out = formatAirQuality(parseAirQuality(body, "Austin")!, "aqi");
    expect(out).toMatch(/UV index 7 right now \(high — wear sunscreen\)\./);
  });
  it("with a daily peak, sunscreen guidance leads off the PEAK, not the instant (uv-instant-not-daily-peak)", () => {
    // 8am: instant UV 2 (low) but today peaks at 9 (very high) — must NOT read as 'you're fine'.
    const morning = parseAirQuality(JSON.stringify({ current: { us_aqi: 40, uv_index: 2 }, daily: { uv_index_max: [9] } }), "Austin")!;
    expect(morning.uvMax).toBe(9);
    const out = formatAirQuality(morning, "uv");
    expect(out).toMatch(/^Austin: UV peaks at 9 today \(very high — wear sunscreen midday\), 2 right now\./);
    expect(out).not.toMatch(/^Austin: UV index 2/); // did NOT lead with the low instant value
  });
  it("no midday-sunscreen nudge when the day's peak is low", () => {
    const low = parseAirQuality(JSON.stringify({ current: { us_aqi: 40, uv_index: 1 }, daily: { uv_index_max: [2] } }), "Reykjavik")!;
    const out = formatAirQuality(low);
    expect(out).toMatch(/UV peaks at 2 today \(low\)/);
    expect(out).not.toMatch(/wear sunscreen/);
  });
});

describe("pollen (pollen-matched-not-fetched)", () => {
  it("isAirRequest + isPollenRequest recognize allergy asks; airQualityUrl requests pollen fields", () => {
    for (const t of ["what's the pollen today", "how are my allergies", "hayfever forecast"]) expect(isAirRequest(t), t).toBe(true);
    expect(isPollenRequest("pollen count today")).toBe(true);
    expect(isPollenRequest("how's the air")).toBe(false);
    expect(airQualityUrl(52.5, 13.4)).toMatch(/grass_pollen.*ragweed_pollen/);
  });
  it("pollenRisk bands", () => {
    expect(pollenRisk(0)).toBe("none");
    expect(pollenRisk(5)).toBe("low");
    expect(pollenRisk(20)).toBe("moderate");
    expect(pollenRisk(50)).toBe("high");
    expect(pollenRisk(100)).toBe("very high");
  });
  it("parses Europe pollen numbers + leads with pollen for an allergy ask", () => {
    const eu = parseAirQuality(JSON.stringify({ current: { us_aqi: 51, grass_pollen: 0.2, birch_pollen: 0, ragweed_pollen: 12 } }), "Berlin")!;
    expect(eu.pollenCovered).toBe(true);
    const out = formatAirQuality(eu, "pollen");
    expect(out).toMatch(/^Berlin: Pollen: moderate \(ragweed highest\)/); // peak 12 -> moderate, ragweed worst
  });
  it("outside Europe (pollen null) says it's unavailable instead of implying none", () => {
    const us = parseAirQuality(JSON.stringify({ current: { us_aqi: 44, grass_pollen: null, ragweed_pollen: null } }), "Austin")!;
    expect(us.pollenCovered).toBeUndefined();
    const out = formatAirQuality(us, "pollen");
    expect(out).toMatch(/don't have pollen data for Austin.*Europe only/i);
  });
});

describe("getAirQuality (injected fetch)", () => {
  it("geocodes a named place then fetches air quality", async () => {
    const urls: string[] = [];
    const a = await getAirQuality({ text: "is the air bad in Denver", place: "Denver" }, async (url) => {
      urls.push(url);
      if (url.includes("geocoding")) return JSON.stringify({ results: [{ latitude: 39.7, longitude: -105, name: "Denver", country: "USA" }] });
      return JSON.stringify({ current: { us_aqi: 90, pm2_5: 20, uv_index: 5 } });
    });
    expect(a!.place).toBe("Denver, USA");
    expect(a!.aqi).toBe(90);
    expect(urls[1]).toContain("air-quality");
  });
  it("uses saved coords directly (no geocode) when no place is named", async () => {
    let geocoded = false;
    const a = await getAirQuality({ text: "how's the air", lat: 30, lng: -97 }, async (url) => {
      if (url.includes("geocoding")) { geocoded = true; return "{}"; }
      return JSON.stringify({ current: { us_aqi: 42, uv_index: 3 } });
    });
    expect(geocoded).toBe(false);
    expect(a!.place).toBe("your location");
    expect(a!.category).toBe("Good");
  });
  it("null on an unknown place / fetch failure (caller falls back)", async () => {
    expect(await getAirQuality({ place: "Nowheresville" }, async () => JSON.stringify({ results: [] }))).toBeNull();
    expect(await getAirQuality({ lat: 1, lng: 2 }, async () => { throw new Error("net"); })).toBeNull();
  });
});
