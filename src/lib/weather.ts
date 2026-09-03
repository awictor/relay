// Weather (geo-tool-cluster): "weather" is the #1 first errand + the flagship demo, but there was no
// tool — the agent guessed a forecast URL or scraped a JS weather shell (flaky/slow). This hits the
// keyless Open-Meteo APIs directly (geocoding city->coords, then current+daily forecast), for an
// instant, correct answer. Pure parse/format helpers exported + unit-tested; the network fetch takes
// an injected getter so it runs offline.

export interface WeatherResult {
  place: string;      // resolved place name ("Austin, Texas, United States")
  current: { tempC: number; tempF: number; code: number; desc: string; windKph: number };
  today: { hiC: number; loC: number; hiF: number; loF: number; precipPct: number };
}

// Open-Meteo WMO weather codes -> short human descriptions (the common buckets).
const WMO: Record<number, string> = {
  0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "rime fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers", 85: "snow showers", 86: "snow showers",
  95: "thunderstorm", 96: "thunderstorm w/ hail", 99: "thunderstorm w/ hail",
};
export function weatherDesc(code: number): string { return WMO[code] ?? "unknown"; }

const cToF = (c: number) => Math.round((c * 9) / 5 + 32);

export function geocodeUrl(place: string): string {
  // Ask for several candidates (not count=1) so an ambiguous name ("Portland", "Springfield") can be
  // disambiguated toward the user's region instead of always the highest-population match.
  return `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=5`;
}
export function forecastUrl(lat: number, lng: number): string {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`;
}

export interface GeoCandidate { lat: number; lng: number; place: string }

/** Parse an Open-Meteo geocoding response into ALL candidates (weather-ambiguous-city), most-relevant
 * first (the API's own order — population-weighted). Exported for tests. */
export function parseGeocodeAll(body: string): GeoCandidate[] {
  try {
    const obj = JSON.parse(body) as { results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string; country?: string }> };
    return (obj.results ?? [])
      .filter((r) => typeof r.latitude === "number" && typeof r.longitude === "number")
      .map((r) => ({ lat: r.latitude, lng: r.longitude, place: [r.name, r.admin1, r.country].filter(Boolean).join(", ") }));
  } catch { return []; }
}

/** Pick the best candidate for an ambiguous city: when the user's coords are known, prefer the nearest
 * candidate that's within ~250km (a same-name city in their region), else fall back to the API's top
 * (highest-population) result. No coords -> top result. Exported for tests. */
export function pickCandidate(cands: GeoCandidate[], near?: { lat: number; lng: number }): GeoCandidate | null {
  if (!cands.length) return null;
  if (near) {
    const withDist = cands.map((c) => ({ c, d: haversineKm(near.lat, near.lng, c.lat, c.lng) })).sort((a, b) => a.d - b.d);
    if (withDist[0]!.d <= 250) return withDist[0]!.c; // a same-name place near the user wins
  }
  return cands[0]!; // default: the most-relevant (population) match
}

// Haversine (km) — small local copy so weather doesn't depend on places.ts.
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(s));
}

/** Back-compat: the single best candidate (top result), no user-region bias. */
export function parseGeocode(body: string): { lat: number; lng: number; place: string } | null {
  return parseGeocodeAll(body)[0] ?? null;
}

/** Parse an Open-Meteo forecast response into the current + today fields, or null if malformed. */
export function parseForecast(body: string, place: string): WeatherResult | null {
  try {
    const obj = JSON.parse(body) as {
      current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number };
      daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[] };
    };
    const c = obj.current, d = obj.daily;
    if (!c || typeof c.temperature_2m !== "number") return null;
    const hiC = d?.temperature_2m_max?.[0], loC = d?.temperature_2m_min?.[0];
    const code = c.weather_code ?? 0;
    return {
      place,
      current: { tempC: c.temperature_2m, tempF: cToF(c.temperature_2m), code, desc: weatherDesc(code), windKph: Math.round(c.wind_speed_10m ?? 0) },
      today: {
        hiC: hiC ?? c.temperature_2m, loC: loC ?? c.temperature_2m,
        hiF: cToF(hiC ?? c.temperature_2m), loF: cToF(loC ?? c.temperature_2m),
        precipPct: d?.precipitation_probability_max?.[0] ?? 0,
      },
    };
  } catch { return null; }
}

/** Format a WeatherResult into a short human line, honoring the user's unit preference (default F for
 * a US-style imperial pref, else C — the caller passes "metric"/"imperial"). */
export function formatWeather(w: WeatherResult, units: "metric" | "imperial" = "imperial"): string {
  const metric = units === "metric";
  const t = metric ? `${Math.round(w.current.tempC)}°C` : `${w.current.tempF}°F`;
  const hi = metric ? `${Math.round(w.today.hiC)}°` : `${w.today.hiF}°`;
  const lo = metric ? `${Math.round(w.today.loC)}°` : `${w.today.loF}°`;
  const rain = w.today.precipPct > 0 ? `, ${w.today.precipPct}% rain` : "";
  return `${w.place}: ${t}, ${w.current.desc}. High ${hi}, low ${lo}${rain}.`;
}

/**
 * Fetch current weather for a place name OR explicit coords. `fetchText` is injected (guarded GET in
 * prod, a fake in tests). When coords are given, geocoding is skipped (label falls back to "your
 * location"). Returns null on a bad place / fetch failure so the caller can fall back. Never throws.
 */
export async function getWeather(
  opts: { place?: string; lat?: number; lng?: number; near?: { lat: number; lng: number } },
  fetchText: (url: string) => Promise<string>,
): Promise<WeatherResult | null> {
  try {
    let lat = opts.lat, lng = opts.lng, place = "your location";
    if ((lat === undefined || lng === undefined) && opts.place) {
      // Disambiguate an ambiguous city toward the user's region when their coords are known
      // (weather-ambiguous-city), else take the top match.
      const geo = pickCandidate(parseGeocodeAll(await fetchText(geocodeUrl(opts.place))), opts.near);
      if (!geo) return null;
      lat = geo.lat; lng = geo.lng; place = geo.place;
    } else if (opts.place) {
      place = opts.place;
    }
    if (lat === undefined || lng === undefined) return null;
    return parseForecast(await fetchText(forecastUrl(lat, lng)), place);
  } catch { return null; }
}
