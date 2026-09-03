import { describe, it, expect } from "vitest";
import { weatherDesc, parseGeocode, parseGeocodeAll, pickCandidate, parseForecast, formatWeather, getWeather, geocodeUrl, forecastUrl } from "../src/lib/weather.js";

describe("weatherDesc (geo-tool-cluster)", () => {
  it("maps WMO codes to short descriptions", () => {
    expect(weatherDesc(0)).toBe("clear");
    expect(weatherDesc(3)).toBe("overcast");
    expect(weatherDesc(63)).toBe("rain");
    expect(weatherDesc(95)).toBe("thunderstorm");
    expect(weatherDesc(999)).toBe("unknown");
  });
});

describe("parseGeocode", () => {
  it("pulls lat/lng + a composed place name from the first result", () => {
    const body = JSON.stringify({ results: [{ latitude: 30.27, longitude: -97.74, name: "Austin", admin1: "Texas", country: "United States" }] });
    expect(parseGeocode(body)).toEqual({ lat: 30.27, lng: -97.74, place: "Austin, Texas, United States" });
  });
  it("null on no results / bad json", () => {
    expect(parseGeocode(JSON.stringify({ results: [] }))).toBeNull();
    expect(parseGeocode("nope")).toBeNull();
  });
});

describe("parseForecast", () => {
  const body = JSON.stringify({
    current: { temperature_2m: 20, weather_code: 2, wind_speed_10m: 11 },
    daily: { temperature_2m_max: [25], temperature_2m_min: [15], precipitation_probability_max: [40] },
  });
  it("parses current + today, converting C->F", () => {
    const w = parseForecast(body, "Austin")!;
    expect(w.current.tempC).toBe(20);
    expect(w.current.tempF).toBe(68);        // 20C = 68F
    expect(w.current.desc).toBe("partly cloudy");
    expect(w.today.hiF).toBe(77);            // 25C
    expect(w.today.loF).toBe(59);            // 15C
    expect(w.today.precipPct).toBe(40);
  });
  it("null when current is missing", () => {
    expect(parseForecast(JSON.stringify({ daily: {} }), "x")).toBeNull();
  });
});

describe("formatWeather", () => {
  const w = parseForecast(JSON.stringify({
    current: { temperature_2m: 20, weather_code: 2, wind_speed_10m: 11 },
    daily: { temperature_2m_max: [25], temperature_2m_min: [15], precipitation_probability_max: [40] },
  }), "Austin")!;
  it("imperial by default (°F)", () => {
    expect(formatWeather(w)).toBe("Austin: 68°F, partly cloudy. High 77°, low 59°, 40% rain.");
  });
  it("metric on request (°C), omits rain at 0%", () => {
    const dry = parseForecast(JSON.stringify({ current: { temperature_2m: 20, weather_code: 0 }, daily: { temperature_2m_max: [22], temperature_2m_min: [10], precipitation_probability_max: [0] } }), "Paris")!;
    expect(formatWeather(dry, "metric")).toBe("Paris: 20°C, clear. High 22°, low 10°.");
  });
});

describe("pickCandidate (weather-ambiguous-city)", () => {
  // Two "Portland"s: OR (population top) and ME.
  const cands = [
    { lat: 45.52, lng: -122.68, place: "Portland, Oregon, US" },
    { lat: 43.66, lng: -70.26, place: "Portland, Maine, US" },
  ];
  it("no user coords -> the top (population) result", () => {
    expect(pickCandidate(cands)!.place).toMatch(/Oregon/);
  });
  it("prefers the candidate near the user's coords (within ~250km)", () => {
    // User near Boston -> Portland ME (~150km) beats Portland OR (top result).
    expect(pickCandidate(cands, { lat: 42.36, lng: -71.06 })!.place).toMatch(/Maine/);
  });
  it("falls back to top when no candidate is near", () => {
    // User in London -> neither Portland is within 250km -> top (OR).
    expect(pickCandidate(cands, { lat: 51.5, lng: -0.1 })!.place).toMatch(/Oregon/);
  });
  it("empty -> null", () => { expect(pickCandidate([])).toBeNull(); });
});

describe("parseGeocodeAll", () => {
  it("returns all candidates in order", () => {
    const body = JSON.stringify({ results: [
      { latitude: 1, longitude: 2, name: "A", country: "X" },
      { latitude: 3, longitude: 4, name: "B", country: "Y" },
    ] });
    expect(parseGeocodeAll(body).map((c) => c.place)).toEqual(["A, X", "B, Y"]);
  });
});

describe("getWeather (injected fetch)", () => {
  it("geocodes a place then fetches the forecast", async () => {
    const calls: string[] = [];
    const fetchText = async (url: string) => {
      calls.push(url);
      if (url.startsWith(geocodeUrl("Austin").slice(0, 50))) return JSON.stringify({ results: [{ latitude: 30.27, longitude: -97.74, name: "Austin", country: "USA" }] });
      return JSON.stringify({ current: { temperature_2m: 30, weather_code: 0 }, daily: { temperature_2m_max: [35], temperature_2m_min: [25], precipitation_probability_max: [0] } });
    };
    const w = await getWeather({ place: "Austin" }, fetchText);
    expect(w!.place).toBe("Austin, USA");
    expect(w!.current.tempF).toBe(86);
    expect(calls[0]).toContain("geocoding-api");
    expect(calls[1]).toContain("forecast");
  });
  it("uses explicit coords without geocoding", async () => {
    let geocoded = false;
    const fetchText = async (url: string) => {
      if (url.includes("geocoding")) { geocoded = true; return "{}"; }
      return JSON.stringify({ current: { temperature_2m: 10, weather_code: 61 }, daily: { temperature_2m_max: [12], temperature_2m_min: [8], precipitation_probability_max: [70] } });
    };
    const w = await getWeather({ lat: 51.5, lng: -0.1 }, fetchText);
    expect(geocoded).toBe(false);
    expect(w!.current.desc).toBe("light rain");
    expect(w!.place).toBe("your location");
  });
  it("null on unknown place / fetch failure", async () => {
    expect(await getWeather({ place: "Nowheresville" }, async () => JSON.stringify({ results: [] }))).toBeNull();
    expect(await getWeather({ place: "x" }, async () => { throw new Error("net"); })).toBeNull();
  });
  it("disambiguates a named city toward the user's region via `near` (weather-ambiguous-city)", async () => {
    const fetchText = async (url: string) => {
      if (url.includes("geocoding")) return JSON.stringify({ results: [
        { latitude: 45.52, longitude: -122.68, name: "Portland", admin1: "Oregon", country: "US" },
        { latitude: 43.66, longitude: -70.26, name: "Portland", admin1: "Maine", country: "US" },
      ] });
      return JSON.stringify({ current: { temperature_2m: 10, weather_code: 0 }, daily: { temperature_2m_max: [12], temperature_2m_min: [4], precipitation_probability_max: [0] } });
    };
    const w = await getWeather({ place: "Portland", near: { lat: 42.36, lng: -71.06 } }, fetchText); // near Boston
    expect(w!.place).toMatch(/Maine/); // not the top (Oregon) result
  });
});
