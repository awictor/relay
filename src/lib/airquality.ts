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
  uv?: number;        // current UV index (0-11+); may be 0 at night / early morning
  uvMax?: number;     // TODAY's peak UV (uv-instant-not-daily-peak) — sunscreen guidance leads off this,
                      // so an 8am reading of 2 doesn't say "you're fine" when midday peaks at 9
  // Pollen (pollen-matched-not-fetched): grains/m³ for the common allergens. Open-Meteo covers pollen in
  // EUROPE only — outside it these come back null, so `pollenCovered` is false and the formatter says so
  // instead of implying "no pollen". Present only when at least one pollen value is a real number.
  pollen?: { grass?: number; birch?: number; alder?: number; ragweed?: number };
  pollenCovered?: boolean;
}

/** Open-Meteo air-quality URL (US AQI + pollutants + current UV + pollen; local time via timezone=auto).
 * Pollen fields are Europe-only (null elsewhere) — requested always, surfaced only when present. */
export function airQualityUrl(lat: number, lng: number): string {
  return `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}` +
    `&current=us_aqi,pm2_5,pm10,ozone,uv_index,grass_pollen,birch_pollen,alder_pollen,ragweed_pollen` +
    `&daily=uv_index_max&timezone=auto&forecast_days=1`;
}

/** True if the ask is specifically about pollen/allergies (so the reply leads with pollen). Exported. */
export function isPollenRequest(text: string): boolean {
  return /\b(pollen|allergy|allergies|hay ?fever|allergen)\b/i.test(text);
}

/** True if a message is an air-quality / smoke / UV / sunscreen ask. Exported for tests. */
export function isAirRequest(text: string): boolean {
  return /\b(air quality|air pollution|how'?s the air|is the air|aqi|smog|smoke|smoky|hazy|haze|pollen|allergy|allergies|hay ?fever|allergen|uv( index)?|sunscreen|suncream|sun protection|safe to (?:run|go|be) (?:outside|out|for a run))\b/i.test(text);
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

// Peak pollen grains/m³ -> risk word (rough, aligned to common allergy scales). Exported for tests.
export function pollenRisk(peak: number): string {
  if (peak <= 0) return "none";
  if (peak < 10) return "low";
  if (peak < 30) return "moderate";
  if (peak < 70) return "high";
  return "very high";
}

/** Parse an Open-Meteo air-quality response, or null if malformed. Exported for tests. */
export function parseAirQuality(body: string, place: string): AirQuality | null {
  try {
    const obj = JSON.parse(body) as { current?: { us_aqi?: number; pm2_5?: number; pm10?: number; ozone?: number; uv_index?: number; grass_pollen?: number | null; birch_pollen?: number | null; alder_pollen?: number | null; ragweed_pollen?: number | null }; daily?: { uv_index_max?: Array<number | null> } };
    const c = obj.current;
    if (!c || typeof c.us_aqi !== "number") return null;
    const uvMax = obj.daily?.uv_index_max?.[0]; // today's peak UV
    // Pollen is Europe-only; outside it every field is null. Collect the numeric ones; covered iff any.
    const pollen: NonNullable<AirQuality["pollen"]> = {};
    if (typeof c.grass_pollen === "number") pollen.grass = c.grass_pollen;
    if (typeof c.birch_pollen === "number") pollen.birch = c.birch_pollen;
    if (typeof c.alder_pollen === "number") pollen.alder = c.alder_pollen;
    if (typeof c.ragweed_pollen === "number") pollen.ragweed = c.ragweed_pollen;
    const pollenCovered = Object.keys(pollen).length > 0;
    return {
      place, aqi: Math.round(c.us_aqi), category: aqiCategory(c.us_aqi),
      ...(typeof c.pm2_5 === "number" ? { pm25: c.pm2_5 } : {}),
      ...(typeof c.pm10 === "number" ? { pm10: c.pm10 } : {}),
      ...(typeof c.ozone === "number" ? { ozone: c.ozone } : {}),
      ...(typeof c.uv_index === "number" ? { uv: c.uv_index } : {}),
      ...(typeof uvMax === "number" ? { uvMax } : {}),
      ...(pollenCovered ? { pollen, pollenCovered: true } : {}),
    };
  } catch { return null; }
}

/** Format an air-quality result into a short human line. `lead` picks what to lead with for the user's
 * ask: "uv" (do I need sunscreen), "pollen" (allergies), else AQI. */
export function formatAirQuality(a: AirQuality, lead: "aqi" | "uv" | "pollen" = "aqi"): string {
  const aqiPart = `Air quality in ${a.place}: AQI ${a.aqi} (${a.category})`;
  const pm = typeof a.pm25 === "number" ? `, PM2.5 ${Math.round(a.pm25)}µg/m³` : "";
  // UV: base the sunscreen call on TODAY'S PEAK, not the instant reading (uv-instant-not-daily-peak) — an
  // 8am UV of 2 shouldn't say "you're fine" when midday hits 9. Lead with the peak + a "wear sunscreen"
  // nudge when the peak is moderate+, and note the current reading as context.
  let uvPart = "";
  if (typeof a.uvMax === "number") {
    const nudge = a.uvMax >= 3 ? " — wear sunscreen midday" : "";
    const nowNote = typeof a.uv === "number" ? `, ${Math.round(a.uv)} right now` : "";
    uvPart = `UV peaks at ${Math.round(a.uvMax)} today (${uvRisk(a.uvMax)}${nudge})${nowNote}`;
  } else if (typeof a.uv === "number") {
    // No daily peak available — fall back to the instant reading, labeled honestly as "right now".
    uvPart = `UV index ${Math.round(a.uv)} right now (${uvRisk(a.uv)}${a.uv >= 3 ? " — wear sunscreen" : ""})`;
  }
  // Pollen line: the peak allergen level + which. Only when Europe-covered; else an honest "not available".
  let pollenPart = "";
  if (a.pollenCovered && a.pollen) {
    const entries = Object.entries(a.pollen).filter(([, v]) => typeof v === "number") as Array<[string, number]>;
    const peak = entries.reduce((m, [, v]) => Math.max(m, v), 0);
    const worst = entries.sort((x, y) => y[1] - x[1])[0];
    pollenPart = `Pollen: ${pollenRisk(peak)}${worst && peak > 0 ? ` (${worst[0]} highest)` : ""}`;
  }
  if (lead === "pollen") {
    // Lead with pollen; if the location isn't covered, say so plainly rather than implying "no pollen".
    const p = pollenPart || `I don't have pollen data for ${a.place} (Open-Meteo covers pollen in Europe only)`;
    return `${a.place}: ${p}. ${aqiPart}${pm}.`;
  }
  if (lead === "uv" && uvPart) {
    return `${a.place}: ${uvPart}. ${aqiPart}${pm}.`;
  }
  const tail = [uvPart, pollenPart].filter(Boolean).map((s) => ` ${s}.`).join("");
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
