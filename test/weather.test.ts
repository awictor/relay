import { describe, it, expect } from "vitest";
import { weatherDesc, parseGeocode, parseGeocodeAll, pickCandidate, parseForecast, formatWeather, getWeather, geocodeUrl, forecastUrl, resolveWhen, dayLabel, formatDay, formatWeatherWhen, resolveHourWindow, formatWeatherHourly } from "../src/lib/weather.js";

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
  it("parses the hourly block into local date+hour points (hourly-rain-weather)", () => {
    const b = JSON.stringify({
      current: { temperature_2m: 20, weather_code: 2 },
      daily: { temperature_2m_max: [25], temperature_2m_min: [15], precipitation_probability_max: [40] },
      hourly: { time: ["2026-09-03T00:00", "2026-09-03T15:00"], precipitation_probability: [5, 80], temperature_2m: [16, 24] },
    });
    const w = parseForecast(b, "Austin")!;
    expect(w.hours).toHaveLength(2);
    expect(w.hours![1]).toMatchObject({ date: "2026-09-03", hour: 15, precipPct: 80, tempC: 24, tempF: 75 });
  });
});

describe("resolveHourWindow (hourly-rain-weather)", () => {
  it("maps named dayparts to local-hour windows", () => {
    expect(resolveHourWindow("will it rain this afternoon", 9)).toMatchObject({ startHour: 12, endHour: 17, tomorrow: false });
    expect(resolveHourWindow("rain tonight?", 9)).toMatchObject({ startHour: 18, endHour: 24 });
    expect(resolveHourWindow("weather tomorrow morning", 9)).toMatchObject({ startHour: 5, endHour: 12, tomorrow: true });
  });
  it("maps a specific 'at 3pm' to a tight one-hour window", () => {
    expect(resolveHourWindow("will it rain at 3pm", 9)).toMatchObject({ startHour: 15, endHour: 16, label: "3pm" });
  });
  it("'later today' anchors to the current local hour", () => {
    expect(resolveHourWindow("any rain later today", 14)).toMatchObject({ startHour: 14, endHour: 24, tomorrow: false });
  });
  it("null when there's no time-of-day cue", () => {
    expect(resolveHourWindow("what's the weather", 9)).toBeNull();
  });
});

describe("formatWeatherHourly (hourly-rain-weather)", () => {
  const w = parseForecast(JSON.stringify({
    current: { temperature_2m: 20, weather_code: 2 },
    daily: { temperature_2m_max: [25], temperature_2m_min: [15], precipitation_probability_max: [80] },
    hourly: {
      time: ["2026-09-03T12:00", "2026-09-03T13:00", "2026-09-03T14:00", "2026-09-03T15:00", "2026-09-03T16:00"],
      precipitation_probability: [10, 20, 60, 80, 30],
      temperature_2m: [22, 23, 24, 24, 23],
    },
  }), "Austin")!;
  it("summarizes rain likelihood + the peak hour for an afternoon question", () => {
    const out = formatWeatherHourly(w, "will it rain this afternoon", 9, "imperial")!;
    expect(out).toMatch(/Austin afternoon:/);
    expect(out).toMatch(/likely rain \(up to 80%, around 3pm\)/);
  });
  it("says little-to-no rain when the window is dry", () => {
    const dry = parseForecast(JSON.stringify({
      current: { temperature_2m: 20, weather_code: 0 },
      daily: { temperature_2m_max: [25], temperature_2m_min: [15], precipitation_probability_max: [5] },
      hourly: { time: ["2026-09-03T18:00", "2026-09-03T19:00"], precipitation_probability: [0, 5], temperature_2m: [19, 18] },
    }), "Paris")!;
    expect(formatWeatherHourly(dry, "rain tonight?", 9, "metric")).toMatch(/little to no rain/);
  });
  it("null when no hourly data or no time cue (caller falls back to daily)", () => {
    const noHours = parseForecast(JSON.stringify({ current: { temperature_2m: 20, weather_code: 0 }, daily: { temperature_2m_max: [25], temperature_2m_min: [15], precipitation_probability_max: [0] } }), "x")!;
    expect(formatWeatherHourly(noHours, "this afternoon", 9)).toBeNull();
    expect(formatWeatherHourly(w, "what's the weather", 9)).toBeNull(); // no time-of-day cue
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

describe("multi-day forecast (weather-multi-day)", () => {
  // 2024-06-01 is a Saturday (UTC). days[0]=Sat, [1]=Sun, [2]=Mon...
  const body = JSON.stringify({
    current: { temperature_2m: 20, weather_code: 2, wind_speed_10m: 11 },
    daily: {
      time: ["2024-06-01", "2024-06-02", "2024-06-03", "2024-06-04", "2024-06-05", "2024-06-06", "2024-06-07"],
      weather_code: [2, 61, 0, 3, 80, 0, 0],
      temperature_2m_max: [25, 18, 27, 24, 19, 26, 28],
      temperature_2m_min: [15, 12, 16, 14, 11, 15, 17],
      precipitation_probability_max: [40, 80, 0, 20, 90, 0, 0],
    },
  });

  it("parseForecast builds a per-day array with each day's own code", () => {
    const w = parseForecast(body, "Austin")!;
    expect(w.days).toHaveLength(7);
    expect(w.days![1]).toMatchObject({ date: "2024-06-02", hiF: 64, desc: "light rain", precipPct: 80 }); // 18C=64F
    expect(w.today.hiF).toBe(77); // today unchanged (back-compat)
  });

  it("resolveWhen maps phrases to day indices (todayDow=6 Sat)", () => {
    expect(resolveWhen("will it rain tomorrow", 6, 7)).toEqual([1]);
    expect(resolveWhen("weather this weekend", 6, 7)).toEqual([0, 1]); // Sat(0), Sun(1)
    expect(resolveWhen("forecast for monday", 6, 7)).toEqual([2]);      // next Mon = index 2
    expect(resolveWhen("this week's forecast", 6, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(resolveWhen("how hot is it right now", 6, 7)).toBeNull();    // no future day
  });

  it("resolveWhen handles 'next <weekday>' as the following week, always +7 past the soonest (weather-next-weekday)", () => {
    // todayDow=1 (Monday). "next Monday" must be +7, NOT [0]/today.
    expect(resolveWhen("weather next monday", 1, 14)).toEqual([7]);
    // a bare "monday" on Monday is today-or-soonest = today (0); "next monday" is the one after.
    expect(resolveWhen("weather monday", 1, 14)).toEqual([0]);
    // "next friday" on Monday: soonest Fri is +4, so "next" = +4+7 = +11 (the FOLLOWING week's Friday),
    // not this week's — the bug was returning +4. Index returned regardless of window; formatWeatherWhen
    // turns an out-of-window day into a "beyond my N-day forecast" note.
    expect(resolveWhen("weather next friday", 1, 14)).toEqual([11]);
    expect(resolveWhen("weather friday", 1, 14)).toEqual([4]); // bare = this coming Friday
  });

  it("resolveWhen: 'day after tomorrow' is +2, not tomorrow (weather-day-after-tomorrow)", () => {
    expect(resolveWhen("weather the day after tomorrow", 3, 7)).toEqual([2]);
    expect(resolveWhen("rain day after tomorrow", 3, 7)).toEqual([2]);
    // 'tomorrow' alone is still +1 (the day-after check doesn't shadow it)
    expect(resolveWhen("weather tomorrow", 3, 7)).toEqual([1]);
    // out of window (only 2 days) -> null, not a wrong day
    expect(resolveWhen("day after tomorrow", 3, 2)).toBeNull();
  });

  it("dayLabel names Today/Tomorrow/weekday", () => {
    expect(dayLabel(0, 6)).toBe("Today");
    expect(dayLabel(1, 6)).toBe("Tomorrow");
    expect(dayLabel(2, 6)).toBe("Monday"); // Sat + 2
  });

  it("formatDay renders a human line honoring units", () => {
    const w = parseForecast(body, "Austin")!;
    expect(formatDay(w.days![1]!, "Tomorrow")).toBe("Tomorrow: light rain, high 64°F, low 54°, 80% rain.");
    expect(formatDay(w.days![2]!, "Monday", "metric")).toBe("Monday: clear, high 27°C, low 16°.");
  });

  it("formatWeatherWhen answers the RIGHT future day, not today", () => {
    const w = parseForecast(body, "Austin")!;
    const tm = formatWeatherWhen(w, "will it rain tomorrow", "imperial")!;
    expect(tm).toMatch(/Austin:/);
    expect(tm).toMatch(/Tomorrow: light rain.*80% rain/);
    expect(tm).not.toMatch(/High 77/); // did NOT fall back to today
  });

  it("formatWeatherWhen returns null for a today/current question (caller uses current line)", () => {
    const w = parseForecast(body, "Austin")!;
    expect(formatWeatherWhen(w, "weather right now", "imperial")).toBeNull();
    expect(formatWeatherWhen(w, "weather today", "imperial")).toBeNull();
  });

  it("formatWeatherWhen says a beyond-window day is out of range, NOT today's weather (weather-future-day-falls-back-to-today)", () => {
    // body has 3 days (indices 0-2). "next monday" from that day resolves past the window.
    const w = parseForecast(body, "Austin")!;
    const todayDow = new Date(`${w.days![0]!.date}T00:00:00Z`).getUTCDay();
    // Build a question that lands beyond w.days.length: pick the weekday == today so "next <it>" = +7.
    const dow = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][todayDow];
    const out = formatWeatherWhen(w, `weather next ${dow}`, "imperial");
    expect(out).toMatch(/beyond my \d+-day forecast/);
    expect(out).not.toMatch(/high 77|High 77/); // did NOT silently show today
  });

  it("formatWeatherWhen returns null when there's no days array", () => {
    const oneDay = parseForecast(JSON.stringify({ current: { temperature_2m: 20, weather_code: 0 }, daily: {} }), "x")!;
    expect(oneDay.days).toBeUndefined();
    expect(formatWeatherWhen(oneDay, "tomorrow", "imperial")).toBeNull();
  });

  it("forecastUrl requests 7 days + daily weather_code", () => {
    expect(forecastUrl(30, -97)).toMatch(/forecast_days=7/);
    expect(forecastUrl(30, -97)).toMatch(/daily=weather_code/);
  });
});
