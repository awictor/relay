// Weather-conditional alerts (weather-conditional-alert): the flagship PROACTIVE errand — "text me if it
// rains tomorrow", "ping me if it drops below freezing tonight", "let me know if it gets above 90 today".
// There was no path (only a flaky agent-driven prose watch). This is a PURE parser + evaluator over the
// keyless Open-Meteo forecast (already fetched by weather.ts): parse the condition + horizon, evaluate it
// against a WeatherResult's daily/hourly blocks -> {holds, detail}. The alert runner fires edge-triggered
// (only when it FIRST becomes true) so it pings once on the drop, not every check. Offline-testable.

import type { WeatherResult } from "./weather.js";

export type WxOp = "rain" | "snow" | "below" | "above" | "wind";
export interface WeatherCondition {
  op: WxOp;
  operand?: number;      // °(user units) for below/above; kph-ish threshold for wind
  units?: "metric" | "imperial"; // interpretation of operand for below/above (default imperial °F)
  horizon: "today" | "tomorrow"; // which day the forecast predicate looks at
  place?: string;        // optional named place ("in Denver"); else the user's saved coords
}

/** Parse a free-text weather-conditional watch, or null if it isn't one. Handles:
 *   "if it rains tomorrow", "if it's going to rain", "if it snows tonight",
 *   "if it drops below 32", "if it gets above 90", "if the low is under 40", "if it's windy" / "wind over 30".
 * A trailing "in <place>" sets the location. Default horizon = today. Exported for tests. */
export function parseWeatherCondition(text: string): WeatherCondition | null {
  const t = text.toLowerCase().trim();
  // Must read like a weather CONDITION ("if it ... rain/snow/below/above/wind/hot/cold/freez"), not a plain
  // value/feed watch. The "if" gate keeps "watch btc below 50000" out of here.
  if (!/\b(if|when|whenever)\b/.test(t) && !/\b(rain|snow|freez|windy|below freezing)\b/.test(t)) return null;

  const horizon: "today" | "tomorrow" = /\btomorrow\b/.test(t) ? "tomorrow" : "today";
  // Optional trailing "in <place>".
  const placeM = t.match(/\bin\s+([a-z][a-z .,'-]*?)\s*[?.!]*$/i);
  const place = placeM && !/^\d|\b(the\s+)?(morning|afternoon|evening|next|hour|min)/i.test(placeM[1]!) ? placeM[1]!.trim() : undefined;

  // below / above a temperature (freezing = 32°F / 0°C handled by the caller's units; we store 32 F-ish).
  const below = t.match(/\b(?:drops?\s+)?(?:below|under|colder than|less than)\s+(-?\d+(?:\.\d+)?)\s*°?\s*([cf])?\b/);
  const above = t.match(/\b(?:gets?\s+|rises?\s+|goes?\s+)?(?:above|over|hotter than|more than|higher than)\s+(\d+(?:\.\d+)?)\s*°?\s*([cf])?\b/);
  const freezing = /\bbelow freezing|freezing|frost\b/.test(t);
  const windy = t.match(/\b(?:wind|windy|gust\w*)\b(?:[^.\d]*?(?:over|above|>)\s*(\d+(?:\.\d+)?))?/);
  const rain = /\brain|rainy|showers?|drizzle|wet|umbrella\b/.test(t);
  const snow = /\bsnow|snowy|blizzard|flurr\w*\b/.test(t);

  const unitsOf = (u?: string): "metric" | "imperial" | undefined => (u === "c" ? "metric" : u === "f" ? "imperial" : undefined);

  if (below) return { op: "below", operand: parseFloat(below[1]!), units: unitsOf(below[2]), horizon, ...(place ? { place } : {}) };
  if (freezing) return { op: "below", operand: 32, units: "imperial", horizon, ...(place ? { place } : {}) };
  if (above) return { op: "above", operand: parseFloat(above[1]!), units: unitsOf(above[2]), horizon, ...(place ? { place } : {}) };
  if (windy) return { op: "wind", ...(windy[1] ? { operand: parseFloat(windy[1]) } : {}), horizon, ...(place ? { place } : {}) };
  if (rain) return { op: "rain", horizon, ...(place ? { place } : {}) };
  if (snow) return { op: "snow", horizon, ...(place ? { place } : {}) };
  return null;
}

// The daily forecast row for a horizon (today = days[0], tomorrow = days[1]); null if unavailable.
function dayFor(w: WeatherResult, horizon: "today" | "tomorrow") {
  return w.days?.[horizon === "tomorrow" ? 1 : 0] ?? null;
}

// WMO codes that mean rain vs snow (from weather.ts's table ranges).
const RAIN_CODES = new Set([51, 53, 55, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const RAIN_PROB_FIRE = 50; // precipitation_probability_max >= this counts as "it will rain"

/**
 * Evaluate a weather condition against a forecast. Returns {holds, detail} where detail is a human phrase
 * for the notification, or null when the forecast can't be assessed (missing day -> the caller HOLDS, i.e.
 * treats it like a soft failure: don't fire, don't advance). `units` is the user's preference for
 * formatting below/above thresholds. Exported for tests.
 */
export function evalWeatherCondition(cond: WeatherCondition, w: WeatherResult, units: "metric" | "imperial" = "imperial"): { holds: boolean; detail: string } | null {
  const day = dayFor(w, cond.horizon);
  if (!day) return null; // can't assess -> caller holds
  const when = cond.horizon === "tomorrow" ? "tomorrow" : "today";
  if (cond.op === "rain") {
    const holds = RAIN_CODES.has(day.code) || day.precipPct >= RAIN_PROB_FIRE;
    return { holds, detail: `🌧️ Rain likely ${when} in ${w.place} (${day.precipPct}% chance, ${day.desc}).` };
  }
  if (cond.op === "snow") {
    const holds = SNOW_CODES.has(day.code) || (/snow/.test(day.desc) && day.precipPct >= RAIN_PROB_FIRE);
    return { holds, detail: `❄️ Snow likely ${when} in ${w.place} (${day.precipPct}% chance, ${day.desc}).` };
  }
  if (cond.op === "wind") {
    // Forecast wind isn't in the daily row; use current windKph as a proxy (best available keyless field).
    const kph = w.current.windKph;
    const thresholdKph = cond.operand !== undefined ? (cond.units === "imperial" || (cond.operand > 0 && cond.operand < 60 && cond.units !== "metric") ? cond.operand * 1.60934 : cond.operand) : 32;
    const holds = kph >= thresholdKph;
    return { holds, detail: `💨 Windy in ${w.place} — ${Math.round(kph)} km/h right now.` };
  }
  // below / above a temperature. Compare in the threshold's own units; the day carries both C and F.
  const thUnits = cond.units ?? units;
  const opnd = cond.operand!;
  if (cond.op === "below") {
    const lo = thUnits === "metric" ? day.loC : day.loF;
    const holds = lo <= opnd;
    return { holds, detail: `🥶 Low ${when} ${Math.round(lo)}°${thUnits === "metric" ? "C" : "F"} in ${w.place} (below ${opnd}°).` };
  }
  // above
  const hi = thUnits === "metric" ? day.hiC : day.hiF;
  const holds = hi >= opnd;
  return { holds, detail: `🥵 High ${when} ${Math.round(hi)}°${thUnits === "metric" ? "C" : "F"} in ${w.place} (above ${opnd}°).` };
}

/** A short human summary of the condition for the "watching" confirmation. Exported. */
export function describeWeatherCondition(cond: WeatherCondition): string {
  const when = cond.horizon === "tomorrow" ? "tomorrow" : "today";
  const where = cond.place ? ` in ${cond.place}` : "";
  switch (cond.op) {
    case "rain": return `rain ${when}${where}`;
    case "snow": return `snow ${when}${where}`;
    case "wind": return `wind${cond.operand ? ` over ${cond.operand}` : ""} ${when}${where}`;
    case "below": return `the low ${when}${where} dropping below ${cond.operand}°`;
    case "above": return `the high ${when}${where} going above ${cond.operand}°`;
  }
}
