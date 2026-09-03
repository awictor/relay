import { describe, it, expect } from "vitest";
import { parseWeatherCondition, evalWeatherCondition, describeWeatherCondition } from "../src/lib/weather-alert.js";
import type { WeatherResult } from "../src/lib/weather.js";

const wx = (over: Partial<WeatherResult> = {}): WeatherResult => ({
  place: "Austin",
  current: { tempC: 20, tempF: 68, code: 0, desc: "clear", windKph: 10 },
  today: { hiC: 30, loC: 18, hiF: 86, loF: 64, precipPct: 10 },
  days: [
    { date: "2026-09-03", hiC: 30, loC: 18, hiF: 86, loF: 64, precipPct: 10, code: 0, desc: "clear" },
    { date: "2026-09-04", hiC: 22, loC: 2, hiF: 72, loF: 36, precipPct: 80, code: 63, desc: "rain" },
  ],
  ...over,
});

describe("parseWeatherCondition", () => {
  it("parses rain/snow/below/above/wind + horizon + place", () => {
    expect(parseWeatherCondition("if it rains tomorrow")).toMatchObject({ op: "rain", horizon: "tomorrow" });
    expect(parseWeatherCondition("if it snows tonight")).toMatchObject({ op: "snow", horizon: "today" });
    expect(parseWeatherCondition("if it drops below 32")).toMatchObject({ op: "below", operand: 32, horizon: "today" });
    expect(parseWeatherCondition("if it gets above 90 tomorrow")).toMatchObject({ op: "above", operand: 90, horizon: "tomorrow" });
    expect(parseWeatherCondition("if it's below freezing tonight")).toMatchObject({ op: "below", operand: 32 });
    expect(parseWeatherCondition("if it's windy")).toMatchObject({ op: "wind" });
    expect(parseWeatherCondition("if it rains tomorrow in Denver")).toMatchObject({ op: "rain", place: "denver" });
  });
  it("null when it isn't a weather condition", () => {
    expect(parseWeatherCondition("price of bitcoin below 50000")).toBeNull();
    expect(parseWeatherCondition("the top HN story")).toBeNull();
  });
});

describe("evalWeatherCondition", () => {
  it("rain tomorrow holds when tomorrow's forecast is rainy", () => {
    const r = evalWeatherCondition({ op: "rain", horizon: "tomorrow" }, wx())!;
    expect(r.holds).toBe(true);
    expect(r.detail).toMatch(/Rain likely tomorrow/);
  });
  it("rain today does NOT hold on a clear day", () => {
    expect(evalWeatherCondition({ op: "rain", horizon: "today" }, wx())!.holds).toBe(false);
  });
  it("below-freezing holds when tomorrow's low is 36F... no, 36 > 32 -> false; a 30F low -> true", () => {
    expect(evalWeatherCondition({ op: "below", operand: 32, units: "imperial", horizon: "tomorrow" }, wx())!.holds).toBe(false); // low 36F
    const cold = wx({ days: [wx().days![0]!, { ...wx().days![1]!, loF: 30 }] });
    expect(evalWeatherCondition({ op: "below", operand: 32, units: "imperial", horizon: "tomorrow" }, cold)!.holds).toBe(true);
  });
  it("above-90 holds when today's high clears it", () => {
    const hot = wx({ days: [{ ...wx().days![0]!, hiF: 95 }, wx().days![1]!] });
    expect(evalWeatherCondition({ op: "above", operand: 90, units: "imperial", horizon: "today" }, hot)!.holds).toBe(true);
    expect(evalWeatherCondition({ op: "above", operand: 90, units: "imperial", horizon: "today" }, wx())!.holds).toBe(false); // high 86
  });
  it("null (hold) when the horizon's day is missing from the forecast", () => {
    expect(evalWeatherCondition({ op: "rain", horizon: "tomorrow" }, wx({ days: [wx().days![0]!] }))).toBeNull();
  });
});

describe("describeWeatherCondition", () => {
  it("summarizes for the watching confirmation", () => {
    expect(describeWeatherCondition({ op: "rain", horizon: "tomorrow" })).toBe("rain tomorrow");
    expect(describeWeatherCondition({ op: "below", operand: 32, horizon: "today", place: "NYC" })).toMatch(/in NYC dropping below 32°/);
  });
});
