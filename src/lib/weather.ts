// Weather (geo-tool-cluster): "weather" is the #1 first errand + the flagship demo, but there was no
// tool — the agent guessed a forecast URL or scraped a JS weather shell (flaky/slow). This hits the
// keyless Open-Meteo APIs directly (geocoding city->coords, then current+daily forecast), for an
// instant, correct answer. Pure parse/format helpers exported + unit-tested; the network fetch takes
// an injected getter so it runs offline.

export interface ForecastDay { date: string; hiC: number; loC: number; hiF: number; loF: number; precipPct: number; code: number; desc: string; }

// One hourly point (hourly-rain-weather): the location's LOCAL timestamp broken into date + hour, plus
// rain chance + temp. Lets the tool answer "will it rain this afternoon / tonight / at 3pm" with WHEN,
// not a whole-day max.
export interface HourPoint { date: string; hour: number; precipPct: number; tempC: number; tempF: number; }

export interface WeatherResult {
  place: string;      // resolved place name ("Austin, Texas, United States")
  current: { tempC: number; tempF: number; code: number; desc: string; windKph: number };
  today: { hiC: number; loC: number; hiF: number; loF: number; precipPct: number };
  // Multi-day (weather-multi-day): daily forecast starting today (index 0). Present when the API
  // returned a daily block; lets the tool answer "tomorrow" / "this weekend" / "this week" instead of
  // confidently giving today's numbers to a future-day question.
  days?: ForecastDay[];
  // Hourly (hourly-rain-weather): per-hour rain chance + temp in the location's local time, so a
  // time-of-day question ("rain this afternoon?") gets a windowed answer, not the daily max.
  hours?: HourPoint[];
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
// 7 days so "tomorrow", "this weekend", "this week" resolve (weather-multi-day). Open-Meteo returns the
// daily code too, so each day gets its own condition, not just today's.
export function forecastUrl(lat: number, lng: number): string {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weather_code,wind_speed_10m` +
    `&hourly=precipitation_probability,temperature_2m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7`;
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
      daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[] };
      hourly?: { time?: string[]; precipitation_probability?: number[]; temperature_2m?: number[] };
    };
    const c = obj.current, d = obj.daily;
    if (!c || typeof c.temperature_2m !== "number") return null;
    const hiC = d?.temperature_2m_max?.[0], loC = d?.temperature_2m_min?.[0];
    const code = c.weather_code ?? 0;
    // Build the multi-day array from parallel daily arrays (weather-multi-day). Length driven by the
    // max/min arrays; each day carries its own weather_code so "rain tomorrow?" reads the right day.
    const n = d?.temperature_2m_max?.length ?? 0;
    const days: ForecastDay[] = [];
    for (let i = 0; i < n; i++) {
      const dhi = d!.temperature_2m_max![i]!, dlo = d!.temperature_2m_min?.[i] ?? dhi;
      const dcode = d!.weather_code?.[i] ?? 0;
      days.push({
        date: d!.time?.[i] ?? "", hiC: dhi, loC: dlo, hiF: cToF(dhi), loF: cToF(dlo),
        precipPct: d!.precipitation_probability_max?.[i] ?? 0, code: dcode, desc: weatherDesc(dcode),
      });
    }
    // Hourly points in the location's local time (timezone=auto -> the API's hourly.time is local, form
    // "YYYY-MM-DDTHH:MM"). Split into date + hour so a time-of-day window can slice by the local clock.
    const h = obj.hourly;
    const hours: HourPoint[] = [];
    const ht = h?.time ?? [];
    for (let i = 0; i < ht.length; i++) {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(ht[i] ?? "");
      if (!m) continue;
      const tC = h!.temperature_2m?.[i];
      hours.push({ date: m[1]!, hour: parseInt(m[2]!, 10), precipPct: h!.precipitation_probability?.[i] ?? 0, tempC: tC ?? 0, tempF: cToF(tC ?? 0) });
    }
    return {
      place,
      current: { tempC: c.temperature_2m, tempF: cToF(c.temperature_2m), code, desc: weatherDesc(code), windKph: Math.round(c.wind_speed_10m ?? 0) },
      today: {
        hiC: hiC ?? c.temperature_2m, loC: loC ?? c.temperature_2m,
        hiF: cToF(hiC ?? c.temperature_2m), loF: cToF(loC ?? c.temperature_2m),
        precipPct: d?.precipitation_probability_max?.[0] ?? 0,
      },
      ...(days.length ? { days } : {}),
      ...(hours.length ? { hours } : {}),
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

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Format a single forecast day into a human line ("Tomorrow (Sat): rain, high 68°, low 54°, 80% rain").
 * `label` is the leading day word ("Tomorrow", "Saturday"). Honors the unit preference. */
export function formatDay(day: ForecastDay, label: string, units: "metric" | "imperial" = "imperial"): string {
  const metric = units === "metric";
  const hi = metric ? `${Math.round(day.hiC)}°C` : `${day.hiF}°F`;
  const lo = metric ? `${Math.round(day.loC)}°` : `${day.loF}°`;
  const rain = day.precipPct > 0 ? `, ${day.precipPct}% rain` : "";
  return `${label}: ${day.desc}, high ${hi}, low ${lo}${rain}.`;
}

/** Resolve a natural "when" phrase in a weather question to day indices into `days` (index 0 = today).
 * Returns null when the phrase names no future day (caller then uses current/today). Handles: today,
 * tomorrow, a named weekday (next occurrence), "this weekend" (the coming Sat+Sun), "this week"/"next
 * N days" (a range). `todayDow` is 0..6 (Sun..Sat) for the resolved location's today. Pure + tested. */
export function resolveWhen(text: string, todayDow: number, maxDays: number): number[] | null {
  const t = text.toLowerCase();
  // "day after tomorrow" is +2 — checked BEFORE the \btomorrow\b branch, which would otherwise match it
  // and wrongly return [1] (tomorrow), a day early (weather-day-after-tomorrow).
  if (/\b(?:the\s+)?day after tomorrow\b/.test(t)) return maxDays > 2 ? [2] : null;
  if (/\btomorrow\b/.test(t)) return maxDays > 1 ? [1] : null;
  // "in 3 days" / "3 days from now" / "in a week" -> that day offset (weather-in-n-days): a natural
  // forecast phrasing that returned null, so the caller fell back to TODAY's weather for a future day.
  // n may exceed the forecast window — formatWeatherWhen turns an out-of-window index into an honest
  // "beyond my N-day forecast" note (same as the weekday branch), so we return [n] for any n>=1.
  const inN = t.match(/\bin\s+(\d+)\s+days?\b/) || t.match(/\b(\d+)\s+days?\s+from\s+(?:now|today)\b/);
  if (inN) { const n = parseInt(inN[1]!, 10); return n >= 1 ? [n] : null; }
  if (/\bin\s+a\s+week\b|\bin\s+1\s+week\b/.test(t)) return [7];
  if (/\bthis weekend\b|\bweekend\b/.test(t)) {
    const idx: number[] = [];
    for (let i = 0; i < maxDays; i++) { const dow = (todayDow + i) % 7; if (dow === 6 || dow === 0) idx.push(i); }
    return idx.length ? idx : null;
  }
  if (/\bthis week\b|\bnext (?:few days|7 days|week)\b|\bweek(?:'s)? (?:forecast|weather)\b/.test(t)) {
    return Array.from({ length: Math.min(maxDays, 7) }, (_, i) => i);
  }
  // A named weekday -> a day index (0=today). "next <weekday>" means the occurrence in the FOLLOWING
  // week, so "next Monday" said ON a Monday resolves to +7, NOT today (the old code returned [0] -> the
  // caller silently showed today's weather for a future question). A bare "<weekday>" is the soonest
  // occurrence today-or-later. The index may exceed the window; formatWeatherWhen turns an out-of-window
  // day into an honest "beyond my N-day forecast" note rather than falling back to today.
  for (let d = 0; d < 7; d++) {
    const dayName = DOW[d]!.toLowerCase();
    if (new RegExp(`\\b${dayName}\\b`).test(t)) {
      let target = -1;
      for (let i = 0; i < 7; i++) { if ((todayDow + i) % 7 === d) { target = i; break; } } // soonest, 0..6
      // "next <weekday>" means the occurrence in the FOLLOWING week, not this week's soonest — so "next
      // Friday" said on a Wed is +9 (this Fri +7), not +2 (weather-next-weekday). Bump the soonest by a
      // full week whenever "next" is present, not only when it lands on today.
      const wantsNext = new RegExp(`\\bnext\\s+${dayName}\\b`).test(t);
      if (wantsNext) target += 7;
      return target < 0 ? null : [target];
    }
  }
  return null;
}

/** Day label for an index: "Today", "Tomorrow", else the weekday name. */
export function dayLabel(index: number, todayDow: number): string {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  return DOW[(todayDow + index) % 7]!;
}

/** Answer a future-day weather question (weather-multi-day). Given a WeatherResult with a `days` array
 * and the user's original question text, resolve which day(s) they asked about and format those. Returns
 * null when the question names no specific future day (caller falls back to formatWeather / current).
 * todayDow is derived from days[0].date (the location's own calendar day), so no clock is needed. */
export function formatWeatherWhen(w: WeatherResult, question: string, units: "metric" | "imperial" = "imperial"): string | null {
  if (!w.days?.length) return null;
  const d0 = w.days[0]!.date;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(d0) ? new Date(`${d0}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  const todayDow = parsed.getUTCDay();
  const idx = resolveWhen(question, todayDow, w.days.length);
  if (!idx || !idx.length) return null;
  if (idx.length === 1 && idx[0] === 0) return null; // "today" -> use the richer current-weather line
  // A requested day BEYOND the forecast window (e.g. "next Monday" when the API only returned 7 days)
  // must NOT silently render today's numbers (weather-future-day-falls-back-to-today). Say so honestly.
  const inWindow = idx.filter((i) => i < w.days!.length);
  if (!inWindow.length) {
    const label = dayLabel(idx[0]!, todayDow);
    return `${w.place}: ${label} is beyond my ${w.days.length}-day forecast — ask again closer to then.`;
  }
  const lines = inWindow.map((i) => formatDay(w.days![i]!, dayLabel(i, todayDow), units));
  const dropped = inWindow.length < idx.length ? `\n(Some days you asked about are beyond my ${w.days.length}-day forecast.)` : "";
  return `${w.place}:\n${lines.join("\n")}${dropped}`;
}

// Named time-of-day windows [startHour, endHour] inclusive-exclusive-ish on the local clock, used by
// resolveHourWindow (hourly-rain-weather). "tonight"/"evening" run to end-of-day.
const DAYPARTS: Record<string, [number, number]> = {
  morning: [5, 12], afternoon: [12, 17], evening: [17, 22], tonight: [18, 24], night: [20, 24], noon: [11, 14],
};

/** Resolve a time-of-day phrase in a weather question to a local-hour window {startHour,endHour,label}
 * plus whether it's for TODAY (vs "tomorrow morning"). Handles named dayparts, a specific "at 3pm"/"at
 * 15:00", and "later"/"rest of the day"/"next few hours" (anchored to nowHour). Returns null when there's
 * no time-of-day cue (caller falls back to the daily line). Pure + tested. */
export function resolveHourWindow(text: string, nowHour: number): { startHour: number; endHour: number; label: string; tomorrow: boolean } | null {
  const t = text.toLowerCase();
  const tomorrow = /\btomorrow\b/.test(t);
  // "at 3pm" / "at 15:00" / "3pm" / "at 3 o'clock" -> a tight 1-hour window around that hour.
  const at = t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) || t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (at) {
    let hh = parseInt(at[1]!, 10);
    const ap = at[3];
    if (ap === "pm" && hh < 12) hh += 12; else if (ap === "am" && hh === 12) hh = 0;
    if (hh >= 0 && hh <= 23) return { startHour: hh, endHour: hh + 1, label: fmtHour(hh), tomorrow };
  }
  for (const [name, [s, e]] of Object.entries(DAYPARTS)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) return { startHour: s, endHour: e, label: name, tomorrow };
  }
  if (/\b(later|rest of (?:the|today|the day)|next few hours|coming hours|this afternoon|soon)\b/.test(t)) {
    return { startHour: nowHour, endHour: 24, label: "later today", tomorrow: false };
  }
  return null;
}

function fmtHour(h: number): string {
  const ap = h < 12 ? "am" : "pm"; const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${ap}`;
}

/** Answer a time-of-day rain/temp question (hourly-rain-weather) from the hourly block. Slices the hours
 * matching the resolved window (today or tomorrow, on the location's local clock) and summarizes the rain
 * chance + temp range. Returns null when there's no hourly data or no time-of-day cue (caller falls back
 * to the daily forecast). `nowHour` is the location's current local hour (0..23) for "later today". */
export function formatWeatherHourly(w: WeatherResult, question: string, nowHour: number, units: "metric" | "imperial" = "imperial"): string | null {
  if (!w.hours?.length) return null;
  const win = resolveHourWindow(question, nowHour);
  if (!win) return null;
  // Which local date: hours[0].date is today for the location; "tomorrow" bumps to the next date present.
  const today = w.hours[0]!.date;
  const dates = Array.from(new Set(w.hours.map((h) => h.date)));
  const targetDate = win.tomorrow ? (dates[1] ?? today) : today;
  const slice = w.hours.filter((h) => h.date === targetDate && h.hour >= win.startHour && h.hour < win.endHour);
  if (!slice.length) return null;
  const maxPrecip = Math.max(...slice.map((h) => h.precipPct));
  const metric = units === "metric";
  const temps = slice.map((h) => (metric ? h.tempC : h.tempF));
  const lo = Math.round(Math.min(...temps)), hi = Math.round(Math.max(...temps));
  const unit = metric ? "°C" : "°F";
  const tempPart = lo === hi ? `${hi}${unit}` : `${lo}–${hi}${unit}`;
  // Find the peak-rain hour so "will it rain this afternoon" can say WHEN it's likeliest.
  const peak = slice.reduce((a, b) => (b.precipPct > a.precipPct ? b : a));
  const when = win.tomorrow ? `tomorrow ${win.label}` : win.label;
  let rainLine: string;
  if (maxPrecip < 15) rainLine = `little to no rain (${maxPrecip}% at most)`;
  else if (maxPrecip < 50) rainLine = `a slight chance of rain (up to ${maxPrecip}%, around ${fmtHour(peak.hour)})`;
  else rainLine = `likely rain (up to ${maxPrecip}%, around ${fmtHour(peak.hour)})`;
  return `${w.place} ${when}: ${rainLine}, ${tempPart}.`;
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
