// Air quality + UV (air-quality-uv): "is the air OK to run", "how bad is the smoke", "UV today / do I
// need sunscreen" fell through to a flaky web_search/scrape — there was no tool. Open-Meteo's keyless
// air-quality API returns US AQI + PM2.5/PM10/ozone + a current UV index at the same lat/lng the weather
// tool already resolves + stores per-chat, so this is a near-clone of suntimes.ts: reuse weather's
// geocode + fetch, one call. Pure parse/format helpers exported + unit-tested; the fetch is injected.
import { geocodeUrl, parseGeocodeAll, pickCandidate } from "./weather.js";

export interface AirQuality {
  place: string;
  aqi: number;        // US AQI (0-500+)
  category: string;   // "Good" / "Moderate" / ...
  pm25?: number;      // µg/m³
  pm10?: number;      // µg/m³
  ozone?: number;     // µg/m³
  uv?: number;        // current UV index (0-11+); may be 0 at night
}

/** Open-Meteo air-quality URL (US AQI + pollutants + current UV; local time via timezone=auto). */
export function airQualityUrl(lat: number, lng: number): string {
  return `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}` +
    `&current=us_aqi,pm2_5,pm10,ozone,uv_index&timezone=auto`;
}

/** True if a message is an air-quality / smoke / UV / sunscreen ask. Exported for tests. */
export function isAirRequest(text: string): boolean {
  return /\b(air quality|air pollution|how'?s the air|is the air|aqi|smog|smoke|smoky|hazy|haze|pollen|uv( index)?|sunscreen|suncream|sun protection|safe to (?:run|go|be) (?:outside|out|for a run))\b/i.test(text);
}

/** True if the ask is specifically about UV/sunscreen (so the reply leads with UV, not AQI). Exported. */
export function isUvRequest(text: string): boolean {
  return /\b(uv( index)?|sunscreen|suncream|sun protection|sunburn)\b/i.test(text);
}

/** Extract a trailing "in <place>" from an air/UV request, or null (caller uses saved coords). Mirrors
 * suntimes.sunPlace — deliberately narrow, rejecting time-ish / adjective tails. Exported for tests. */
export function airPlace(text: string): string | null {
  const m = text.match(/\bin\s+([A-Za-z][A-Za-z .,'-]*?)\s*[?.!]*$/);
  if (!m) return null;
  const p = m[1]!.trim();
  if (/^\d|^(the|a|an)\b|\b(hours?|minutes?|morning|evening|afternoon|winter|summer|air|sun)\b/i.test(p)) return null;
  return p || null;
}

/** US AQI -> EPA category name. Exported for tests. */
export function aqiCategory(aqi: number): string {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for sensitive groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

/** UV index -> risk word. Exported for tests. */
export function uvRisk(uv: number): string {
  if (uv < 3) return "low";
  if (uv < 6) return "moderate";
  if (uv < 8) return "high";
  if (uv < 11) return "very high";
  return "extreme";
}

/** Parse an Open-Meteo air-quality response, or null if malformed. Exported for tests. */
export function parseAirQuality(body: string, place: string): AirQuality | null {
  try {
    const obj = JSON.parse(body) as { current?: { us_aqi?: number; pm2_5?: number; pm10?: number; ozone?: number; uv_index?: number } };
    const c = obj.current;
    if (!c || typeof c.us_aqi !== "number") return null;
    return {
      place, aqi: Math.round(c.us_aqi), category: aqiCategory(c.us_aqi),
      ...(typeof c.pm2_5 === "number" ? { pm25: c.pm2_5 } : {}),
      ...(typeof c.pm10 === "number" ? { pm10: c.pm10 } : {}),
      ...(typeof c.ozone === "number" ? { ozone: c.ozone } : {}),
      ...(typeof c.uv_index === "number" ? { uv: c.uv_index } : {}),
    };
  } catch { return null; }
}

/** Format an air-quality result into a short human line. `uvFirst` leads with the UV/sunscreen answer
 * (for a "do I need sunscreen" ask) instead of AQI. */
export function formatAirQuality(a: AirQuality, uvFirst = false): string {
  const aqiPart = `Air quality in ${a.place}: AQI ${a.aqi} (${a.category})`;
  const pm = typeof a.pm25 === "number" ? `, PM2.5 ${Math.round(a.pm25)}µg/m³` : "";
  const uvPart = typeof a.uv === "number"
    ? `UV index ${Math.round(a.uv)} (${uvRisk(a.uv)}${a.uv >= 3 ? " — wear sunscreen" : ""})`
    : "";
  if (uvFirst && uvPart) {
    // Lead with UV; append AQI as context. A 0/low UV (night) is reported honestly.
    return `${a.place}: ${uvPart}. ${aqiPart}${pm}.`;
  }
  const tail = uvPart ? ` ${uvPart}.` : "";
  return `${aqiPart}${pm}.${tail}`;
}

/**
 * Answer an air-quality / UV request. `fetchText` injected. Resolves the place (geocode) or uses given
 * coords; fetches Open-Meteo air-quality; returns the parsed result. Returns null on no place/coords, an
 * unknown place, or a fetch failure. Exported for the tool dispatch.
 */
export async function getAirQuality(
  opts: { text?: string; place?: string; lat?: number; lng?: number; near?: { lat: number; lng: number } },
  fetchText: (url: string) => Promise<string>,
): Promise<AirQuality | null> {
  try {
    let lat = opts.lat, lng = opts.lng, place = "your location";
    const named = opts.place ?? (opts.text ? airPlace(opts.text) : null) ?? undefined;
    if ((lat === undefined || lng === undefined) && named) {
      const geo = pickCandidate(parseGeocodeAll(await fetchText(geocodeUrl(named))), opts.near);
      if (!geo) return null;
      lat = geo.lat; lng = geo.lng; place = geo.place;
    } else if (named) {
      place = named;
    }
    if (lat === undefined || lng === undefined) return null;
    return parseAirQuality(await fetchText(airQualityUrl(lat, lng)), place);
  } catch { return null; }
}
