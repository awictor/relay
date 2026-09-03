// Sunrise / sunset (sunrise-sunset-tool): "what time is sunset today", "sunrise tomorrow in Denver",
// "is it dark by 7" is a common photographer/hiker/commuter ask. profile.ts already routes these as
// location errands but no tool returned them, so they degraded to weather or web_search. Open-Meteo (the
// existing weather provider) exposes daily sunrise/sunset with tz=auto, so this reuses weather's geocode
// + fetch. Pure parse/format helpers exported + unit-tested; the fetch is injected.
import { geocodeUrl, parseGeocodeAll, pickCandidate } from "./weather.js";

export interface SunTimes { place: string; day: "today" | "tomorrow"; date: string; sunrise: string; sunset: string; daylight: string; }

/** Open-Meteo daily sunrise/sunset URL (local ISO times via timezone=auto). Exported for tests. */
export function sunUrl(lat: number, lng: number): string {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=sunrise,sunset,daylight_duration&timezone=auto&forecast_days=2`;
}

/** True if a message is a sunrise/sunset/daylight ask. Exported for tests. */
export function isSunRequest(text: string): boolean {
  return /\b(sunrise|sunset|sundown|golden hour|when (?:does|will) (?:the sun|it) (?:rise|set|get dark)|what time (?:is|does) (?:sun(?:rise|set)|it get dark)|how (?:long|much) daylight|hours of daylight|is it (?:still )?(?:light|dark)\b)/i.test(text);
}

/** Which day the ask is about (default today; "tomorrow" -> tomorrow). Exported for tests. */
export function sunDayIndex(text: string): 0 | 1 {
  return /\btomorrow\b/i.test(text) ? 1 : 0;
}

/** Extract a place from a sun request ("sunset in Denver", "when's sunrise tomorrow in Paris"), or null
 * (caller uses saved coords). Only a trailing "in <place>" — deliberately narrow. Exported for tests. */
export function sunPlace(text: string): string | null {
  const m = text.match(/\bin\s+([A-Za-z][A-Za-z .,'-]*?)\s*[?.!]*$/);
  if (!m) return null;
  const p = m[1]!.trim();
  // Reject time-ish tails ("in 2 hours", "in the morning") + the word "in <daylight>" false hits.
  if (/^\d|^(the|a|an)\b|\b(hours?|minutes?|morning|evening|afternoon|daylight|winter|summer)\b/i.test(p)) return null;
  return p || null;
}

// "06:30" from an Open-Meteo local ISO "2026-09-03T06:30" -> "6:30 AM".
function fmtClock(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return iso;
  let h = parseInt(m[1]!, 10); const min = m[2]!;
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${min} ${ap}`;
}
function fmtDaylight(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Parse an Open-Meteo daily response into the requested day's sun times, or null. Exported for tests. */
export function parseSunTimes(body: string, place: string, dayIdx: 0 | 1): SunTimes | null {
  try {
    const obj = JSON.parse(body) as { daily?: { time?: string[]; sunrise?: string[]; sunset?: string[]; daylight_duration?: number[] } };
    const d = obj.daily;
    const sunrise = d?.sunrise?.[dayIdx], sunset = d?.sunset?.[dayIdx];
    if (!sunrise || !sunset) return null;
    return {
      place, day: dayIdx === 1 ? "tomorrow" : "today", date: d?.time?.[dayIdx] ?? "",
      sunrise: fmtClock(sunrise), sunset: fmtClock(sunset),
      daylight: fmtDaylight(d?.daylight_duration?.[dayIdx] ?? 0),
    };
  } catch { return null; }
}

/** Format sun times into a short human line. */
export function formatSunTimes(s: SunTimes): string {
  const when = s.day === "tomorrow" ? "Tomorrow" : "Today";
  return `${when} in ${s.place}: sunrise ${s.sunrise}, sunset ${s.sunset} (${s.daylight} of daylight).`;
}

/**
 * Answer a sunrise/sunset request. `fetchText` injected. Resolves the place (geocode) or uses given
 * coords; fetches Open-Meteo; returns the requested day's times. Returns null on no place/coords, an
 * unknown place, or a fetch failure. Exported for the tool dispatch.
 */
export async function getSunTimes(
  opts: { text: string; place?: string; lat?: number; lng?: number; near?: { lat: number; lng: number } },
  fetchText: (url: string) => Promise<string>,
): Promise<SunTimes | null> {
  try {
    const dayIdx = sunDayIndex(opts.text);
    let lat = opts.lat, lng = opts.lng, place = "your location";
    const named = opts.place ?? sunPlace(opts.text) ?? undefined;
    if ((lat === undefined || lng === undefined) && named) {
      const geo = pickCandidate(parseGeocodeAll(await fetchText(geocodeUrl(named))), opts.near);
      if (!geo) return null;
      lat = geo.lat; lng = geo.lng; place = geo.place;
    } else if (named) {
      place = named;
    }
    if (lat === undefined || lng === undefined) return null;
    return parseSunTimes(await fetchText(sunUrl(lat, lng)), place, dayIdx);
  } catch { return null; }
}
