// Per-user profile (product-loop): home location + units, set once so location/unit-relative errands
// ("weather", "sushi near me", "how far to X") resolve without re-stating the city every message.
// Small persistent JSON store (atomic + corrupt-safe via safe-store), keyed by chatId. Free-infra.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

export interface Profile {
  chatId: number;
  location?: string;              // free-text home place, e.g. "Austin, TX"
  units?: "metric" | "imperial";  // preferred units
  tzOffsetMin?: number;           // minutes EAST of UTC (from a "UTC-5"-style clause), for schedules
  lat?: number;                   // precise coords from a shared location pin (telegram-location-pin)
  lng?: number;
  coordsAt?: number;              // epoch ms the coords were shared — coords expire after COORDS_TTL_MS
                                  // (coords-privacy-ttl) so a one-time pin isn't sent to the LLM forever
                                  // and "near me" doesn't resolve against a spot the user has left.
}

// A shared location pin is a point-in-time fix, not a durable home. After this long it's dropped from
// the agent context (privacy: stop leaking ~1m coords to the LLM on every later message; correctness:
// "near me" shouldn't use a stale spot). The free-text home location stays durable. Default 6h.
export const COORDS_TTL_MS = Math.max(60_000, Number(process.env.RELAY_COORDS_TTL_MS) || 6 * 3_600_000);

/** Render a minutes-east-of-UTC offset as "UTC-5" / "UTC+5:30" / "UTC+0". Preserves the half/quarter-
 * hour minutes that Math.round(offset/60) dropped (India UTC+5:30 wrongly showed "UTC+6"). Handles
 * negative offsets with a fractional part correctly (e.g. -210 -> "UTC-3:30"). */
export function formatUtcOffset(offsetMin: number): string {
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`;
}

/** Parse a UTC-offset clause like "UTC-5", "utc+1", "GMT+5:30" -> minutes east of UTC, or null. */
export function parseUtcOffset(s: string): number | null {
  const m = s.match(/\b(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\b/i);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const h = parseInt(m[2]!, 10);
  const min = m[3] ? parseInt(m[3], 10) : 0;
  if (h > 14 || min > 59) return null;
  return sign * (h * 60 + min) || 0; // || 0 normalizes -0 (e.g. "GMT-0") to 0
}

/** Parse a "set location" command -> { location, units?, tzOffsetMin? } or null if it isn't one.
 *   "/setlocation Austin, TX"        "set my location to London"
 *   "i'm in Paris"                   "my location is Berlin (metric)"   "/setlocation NYC UTC-5"
 * A trailing "(metric)"/"(imperial)" or "in metric/imperial" sets units; a "UTC±N" clause sets tz. */
export function parseSetLocation(text: string, atMs?: number): { location: string; units?: "metric" | "imperial"; tzOffsetMin?: number } | null {
  const t = text.trim();
  // Explicit forms (/setlocation, "set my location to", "my location is") are unambiguous. The bare
  // "I'm in X" / "I am in X" form is captured separately because it also matches ordinary chat
  // ("I'm in a meeting, remind me in 10 min") — for THAT form we require the tail to look like a
  // place, so a normal message isn't hijacked (reminder dropped + profile corrupted).
  const explicit = t.match(/^\s*(?:\/setlocation|set\s+(?:my\s+)?location(?:\s+to)?|my\s+location\s+is)\s+(.+)$/i);
  const bare = explicit ? null : t.match(/^\s*i(?:'m| am)\s+in\s+(.+)$/i);
  const m = explicit ?? bare;
  if (!m) return null;
  let loc = m[1]!.trim();
  // Guard the bare "I'm in X" form: reject if the tail carries a task/scheduling clause or reads like
  // a sentence rather than a place. A real place is short and has no comma-separated follow-on verb.
  if (bare) {
    const tail = loc.toLowerCase();
    // A place is short and free of task/scheduling words. Keep a comma OK ("Austin, TX") but reject a
    // sentence ("a meeting, remind me in 10 min" -> caught by the keyword + length checks).
    const looksLikeTask = /\b(remind|reminder|remember|schedule|every|tomorrow|today|tonight|later|meeting|call|please|when|need|want|going|about|min|mins|minute|hour|hours)\b/.test(tail)
      || /\bin\s+\d/.test(tail) || /\bat\s+\d/.test(tail)  // "...in 10", "...at 3pm"
      || loc.split(/\s+/).length > 5;                      // a place is a few words, not a sentence
    if (looksLikeTask) return null; // not a location-set — let it fall through to scheduling/agent
    // "I'm in X" is also everyday chat where X is a STATE, not a place: "I'm in trouble / bed / a rush /
    // the office / a meeting / love". Reject when the tail starts with an article (a/an/the — a real
    // place-name doesn't) or is a known non-place state-of-being word. A bare "I'm in Paris" (a proper
    // noun, no article) still saves; the explicit /setlocation form covers any odd case this misses.
    const startsWithArticle = /^(?:a|an|the)\s+/i.test(loc);
    const NON_PLACE = /^(?:trouble|bed|love|charge|pain|class|court|jail|labor|labour|shock|denial|control|between|luck|debt|awe|sync|line|session|surgery|transit|traffic|hospital)\b/i;
    if (startsWithArticle || NON_PLACE.test(tail)) return null;
  }
  let units: "metric" | "imperial" | undefined;
  let tzOffsetMin: number | undefined;
  // A UTC offset can appear anywhere in the tail; pull it out first (it's unambiguous).
  const tz = parseUtcOffset(loc);
  if (tz !== null) { tzOffsetMin = tz; loc = loc.replace(/[([]?\b(?:utc|gmt)\s*[+-]\s*\d{1,2}(?::?\d{2})?\b[)\]]?/i, "").trim(); }
  // Trailing units clause: "(metric)" / "[imperial]" / "in metric". Match the WHOLE clause (incl. a
  // leading "in" / bracket) so slicing at its start doesn't leave a dangling word on the location.
  const u = loc.match(/[\s([]*(?:\bin\s+)?[([]?\b(metric|imperial)\b[)\]]?\s*$/i);
  if (u) { units = u[1]!.toLowerCase() as "metric" | "imperial"; loc = loc.slice(0, u.index).trim(); }
  loc = loc.replace(/["']|[.,;]\s*$/g, "").replace(/[([]\s*$/, "").trim().slice(0, 120);
  if (!loc) return null;
  const out: { location: string; units?: "metric" | "imperial"; tzOffsetMin?: number } = { location: loc };
  if (units) out.units = units;
  // Explicit "UTC-5" wins; else infer the tz from the city name (city-to-tz-inference) so a plain
  // "/setlocation Austin" still fires reminders at the right local hour — DST-correct at `atMs` when
  // given (reminder-wrong-timezone-dst), else the standard offset.
  const off = tzOffsetMin !== undefined ? tzOffsetMin : inferTzFromLocation(loc, atMs);
  if (off !== null && off !== undefined) out.tzOffsetMin = off;
  return out;
}

// A location-dependent errand: the answer changes with WHERE the user is, so with no saved location
// Relay would ask the city every time. Used to offer a one-time "save your city?" capture on the first
// such ask (first-location-capture). Deliberately specific so a generic task isn't intercepted.
const LOCATION_ERRAND_RE = /\b(weather|forecast|temperature|will it (?:rain|snow)|is it (?:raining|snowing)|sunset|sunrise|near\s?me|nearby|near here|around here|closest|nearest|how far|directions?|commute)\b/i;
export function needsLocationContext(text: string): boolean {
  return LOCATION_ERRAND_RE.test(text.trim());
}

// City / region -> tz offset (minutes east of UTC), so "Austin" alone sets the right reminder timing
// without the user typing "UTC-5" (city-to-tz-inference — the root of the wrong-hour reminder bug).
// A pragmatic table of common cities + US state abbreviations + country/region names. Uses STANDARD
// (non-DST) offsets — DST drift is a separately-tracked deferred item. Keys are lowercased whole tokens.
// Not exhaustive: a miss just leaves tz unset (caller can still ask), never guesses wrong.
const CITY_TZ: Record<string, number> = {
  // US cities
  "new york": -300, nyc: -300, brooklyn: -300, boston: -300, philadelphia: -300, philly: -300, atlanta: -300, miami: -300, "washington": -300, dc: -300, orlando: -300, detroit: -300, pittsburgh: -300, charlotte: -300, cleveland: -300,
  chicago: -360, houston: -360, dallas: -360, austin: -360, "san antonio": -360, "kansas city": -360, minneapolis: -360, "new orleans": -360, milwaukee: -360, memphis: -360, nashville: -360, "oklahoma city": -360,
  denver: -420, phoenix: -420, "salt lake city": -420, albuquerque: -420, boise: -420, tucson: -420,
  "los angeles": -480, la: -480, "san francisco": -480, sf: -480, "san diego": -480, seattle: -480, portland: -480, "san jose": -480, sacramento: -480, "las vegas": -480, vegas: -480, oakland: -480,
  anchorage: -540, honolulu: -600,
  // US state abbreviations (approx — most-populous zone)
  // US state abbreviations (approx — most-populous zone). Ambiguous ones that are also common English
  // words or collide with a city code (in, or, hi, la=Los Angeles, de, ok, ma-kept, id, ne) are OMITTED
  // — they'd mis-resolve a bare word; a "City, <that state>" is rare enough to fall back to the city.
  ny: -300, nj: -300, fl: -300, ga: -300, ma: -300, pa: -300, va: -300, nc: -300, sc: -300, oh: -300, mi: -300, me: -300, nh: -300, vt: -300, ct: -300, ri: -300, md: -300, wv: -300, ky: -300,
  tx: -360, il: -360, tn: -360, mo: -360, mn: -360, wi: -360, ia: -360, ks: -360, ar: -360, al: -360, ms: -360, nd: -360, sd: -360,
  co: -420, az: -420, ut: -420, nm: -420, mt: -420, wy: -420, ca: -480, wa: -480, nv: -480, ak: -540,
  // World cities
  london: 0, dublin: 0, lisbon: 0, reykjavik: 0,
  paris: 60, berlin: 60, madrid: 60, rome: 60, amsterdam: 60, brussels: 60, vienna: 60, prague: 60, warsaw: 60, zurich: 60, milan: 60, munich: 60, barcelona: 60, stockholm: 60, oslo: 60, copenhagen: 60,
  athens: 120, helsinki: 120, cairo: 120, "cape town": 120, johannesburg: 120, kyiv: 120, kiev: 120, istanbul: 180, moscow: 180, "tel aviv": 120, dubai: 240, "abu dhabi": 240,
  mumbai: 330, delhi: 330, bangalore: 330, bengaluru: 330, kolkata: 330, chennai: 330, hyderabad: 330,
  bangkok: 420, jakarta: 420, hanoi: 420, singapore: 480, "hong kong": 480, beijing: 480, shanghai: 480, shenzhen: 480, taipei: 480, "kuala lumpur": 480, manila: 480, perth: 480,
  tokyo: 540, osaka: 540, seoul: 540, adelaide: 570, sydney: 600, melbourne: 600, brisbane: 600, canberra: 600, auckland: 720, wellington: 720,
  toronto: -300, ottawa: -300, montreal: -300, vancouver: -480, calgary: -420, edmonton: -420, "mexico city": -360, guadalajara: -360, monterrey: -360,
  "sao paulo": -180, "rio de janeiro": -180, rio: -180, "buenos aires": -180, santiago: -180, lima: -300, bogota: -300,
  // Countries / regions (single-zone or dominant zone)
  uk: 0, ireland: 0, portugal: 0, france: 60, germany: 60, spain: 60, italy: 60, netherlands: 60, poland: 60, sweden: 60, norway: 60, switzerland: 60, greece: 120, israel: 120, india: 330, japan: 540, "south korea": 540, korea: 540, singapore_: 480, thailand: 420, australia: 600, "new zealand": 720, nz: 720, brazil: -180, argentina: -180, mexico: -360, canada: -300,
};

// City / region -> IANA zone id, so an inferred offset can be made DST-CORRECT at a given instant instead
// of the STANDARD-only offset CITY_TZ carries (reminder-wrong-timezone-dst): "Austin 7am" set in July
// must use -300 (CDT), not the table's -360 (CST), or it fires an hour early half the year. Keyed the same
// (lowercased city/state/country tokens); a miss falls back to the fixed CITY_TZ offset. Mirrors CITY_TZ's
// keys so the SAME resolution (whole string -> region tail -> word) picks a zone.
const CITY_ZONE: Record<string, string> = {
  "new york": "America/New_York", nyc: "America/New_York", brooklyn: "America/New_York", boston: "America/New_York", philadelphia: "America/New_York", philly: "America/New_York", atlanta: "America/New_York", miami: "America/New_York", washington: "America/New_York", dc: "America/New_York", orlando: "America/New_York", detroit: "America/New_York", pittsburgh: "America/New_York", charlotte: "America/New_York", cleveland: "America/New_York",
  chicago: "America/Chicago", houston: "America/Chicago", dallas: "America/Chicago", austin: "America/Chicago", "san antonio": "America/Chicago", "kansas city": "America/Chicago", minneapolis: "America/Chicago", "new orleans": "America/Chicago", milwaukee: "America/Chicago", memphis: "America/Chicago", nashville: "America/Chicago", "oklahoma city": "America/Chicago",
  denver: "America/Denver", "salt lake city": "America/Denver", albuquerque: "America/Denver", boise: "America/Boise", phoenix: "America/Phoenix", tucson: "America/Phoenix",
  "los angeles": "America/Los_Angeles", la: "America/Los_Angeles", "san francisco": "America/Los_Angeles", sf: "America/Los_Angeles", "san diego": "America/Los_Angeles", seattle: "America/Los_Angeles", portland: "America/Los_Angeles", "san jose": "America/Los_Angeles", sacramento: "America/Los_Angeles", "las vegas": "America/Los_Angeles", vegas: "America/Los_Angeles", oakland: "America/Los_Angeles",
  anchorage: "America/Anchorage", honolulu: "Pacific/Honolulu",
  ny: "America/New_York", nj: "America/New_York", fl: "America/New_York", ga: "America/New_York", ma: "America/New_York", pa: "America/New_York", va: "America/New_York", nc: "America/New_York", sc: "America/New_York", oh: "America/New_York", mi: "America/New_York", me: "America/New_York", nh: "America/New_York", vt: "America/New_York", ct: "America/New_York", ri: "America/New_York", md: "America/New_York", wv: "America/New_York", ky: "America/New_York",
  tx: "America/Chicago", il: "America/Chicago", tn: "America/Chicago", mo: "America/Chicago", mn: "America/Chicago", wi: "America/Chicago", ia: "America/Chicago", ks: "America/Chicago", ar: "America/Chicago", al: "America/Chicago", ms: "America/Chicago", nd: "America/Chicago", sd: "America/Chicago",
  co: "America/Denver", az: "America/Phoenix", ut: "America/Denver", nm: "America/Denver", mt: "America/Denver", wy: "America/Denver", ca: "America/Los_Angeles", wa: "America/Los_Angeles", nv: "America/Los_Angeles", ak: "America/Anchorage",
  london: "Europe/London", dublin: "Europe/Dublin", lisbon: "Europe/Lisbon", reykjavik: "Atlantic/Reykjavik",
  paris: "Europe/Paris", berlin: "Europe/Berlin", madrid: "Europe/Madrid", rome: "Europe/Rome", amsterdam: "Europe/Amsterdam", brussels: "Europe/Brussels", vienna: "Europe/Vienna", prague: "Europe/Prague", warsaw: "Europe/Warsaw", zurich: "Europe/Zurich", milan: "Europe/Rome", munich: "Europe/Berlin", barcelona: "Europe/Madrid", stockholm: "Europe/Stockholm", oslo: "Europe/Oslo", copenhagen: "Europe/Copenhagen",
  athens: "Europe/Athens", helsinki: "Europe/Helsinki", cairo: "Africa/Cairo", "cape town": "Africa/Johannesburg", johannesburg: "Africa/Johannesburg", kyiv: "Europe/Kyiv", kiev: "Europe/Kyiv", istanbul: "Europe/Istanbul", moscow: "Europe/Moscow", "tel aviv": "Asia/Jerusalem", dubai: "Asia/Dubai", "abu dhabi": "Asia/Dubai",
  mumbai: "Asia/Kolkata", delhi: "Asia/Kolkata", bangalore: "Asia/Kolkata", bengaluru: "Asia/Kolkata", kolkata: "Asia/Kolkata", chennai: "Asia/Kolkata", hyderabad: "Asia/Kolkata",
  bangkok: "Asia/Bangkok", jakarta: "Asia/Jakarta", hanoi: "Asia/Bangkok", singapore: "Asia/Singapore", "hong kong": "Asia/Hong_Kong", beijing: "Asia/Shanghai", shanghai: "Asia/Shanghai", shenzhen: "Asia/Shanghai", taipei: "Asia/Taipei", "kuala lumpur": "Asia/Kuala_Lumpur", manila: "Asia/Manila", perth: "Australia/Perth",
  tokyo: "Asia/Tokyo", osaka: "Asia/Tokyo", seoul: "Asia/Seoul", adelaide: "Australia/Adelaide", sydney: "Australia/Sydney", melbourne: "Australia/Melbourne", brisbane: "Australia/Brisbane", canberra: "Australia/Sydney", auckland: "Pacific/Auckland", wellington: "Pacific/Auckland",
  toronto: "America/Toronto", ottawa: "America/Toronto", montreal: "America/Toronto", vancouver: "America/Vancouver", calgary: "America/Edmonton", edmonton: "America/Edmonton", "mexico city": "America/Mexico_City", guadalajara: "America/Mexico_City", monterrey: "America/Monterrey",
  "sao paulo": "America/Sao_Paulo", "rio de janeiro": "America/Sao_Paulo", rio: "America/Sao_Paulo", "buenos aires": "America/Argentina/Buenos_Aires", santiago: "America/Santiago", lima: "America/Lima", bogota: "America/Bogota",
  uk: "Europe/London", ireland: "Europe/Dublin", portugal: "Europe/Lisbon", france: "Europe/Paris", germany: "Europe/Berlin", spain: "Europe/Madrid", italy: "Europe/Rome", netherlands: "Europe/Amsterdam", poland: "Europe/Warsaw", sweden: "Europe/Stockholm", norway: "Europe/Oslo", switzerland: "Europe/Zurich", greece: "Europe/Athens", israel: "Asia/Jerusalem", india: "Asia/Kolkata", japan: "Asia/Tokyo", "south korea": "Asia/Seoul", korea: "Asia/Seoul", thailand: "Asia/Bangkok", australia: "Australia/Sydney", "new zealand": "Pacific/Auckland", nz: "Pacific/Auckland", brazil: "America/Sao_Paulo", argentina: "America/Argentina/Buenos_Aires", mexico: "America/Mexico_City", canada: "America/Toronto",
};

/** The actual UTC offset (minutes east) of an IANA zone AT a specific instant — DST-correct, via Intl's
 * longOffset (full ICU; Node 18+ ships it). Returns null if the zone is unknown/unsupported so the caller
 * falls back to the standard table. */
export function offsetForZoneAt(zone: string, atMs: number): number | null {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date(atMs)).find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = s.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return s === "GMT" ? 0 : null; // "GMT" (no offset shown) = UTC+0
    return (m[1] === "-" ? -1 : 1) * (parseInt(m[2]!, 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));
  } catch {
    return null;
  }
}

/** Resolve a free-text location to an IANA zone id (or null), using the SAME most-specific-first matching
 * as inferTzFromLocation. Lets the caller get a DST-correct offset via offsetForZoneAt. Exported for tests. */
export function inferZoneFromLocation(location: string): string | null {
  return resolveFromTable(location, CITY_ZONE);
}

// Shared resolver for CITY_TZ (number) + CITY_ZONE (string): whole string -> comma region tail -> word.
// Generic over the value type so both tables use identical disambiguation (region-qualifier + foreign-tail).
function resolveFromTable<V>(location: string, table: Record<string, V>): V | null {
  const norm = location.toLowerCase().replace(/[^\p{L}\p{N}\s,]/gu, " ").replace(/\s+/g, " ").trim();
  if (!norm) return null;
  if (norm in table) return table[norm]!;
  const parts = norm.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1]!;
    if (tail in table) return table[tail]!;
    const US_MARKERS = new Set(["usa", "us", "u s", "united states", "united states of america", "america"]);
    const isUsStateShaped = /^[a-z]{2}$/.test(tail);
    if (!US_MARKERS.has(tail) && !isUsStateShaped) return null; // unknown foreign tail -> can't disambiguate
  }
  const words = norm.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : "";
    if (pair && pair in table) return table[pair]!;
    if (words[i]! in table) return table[words[i]!]!;
  }
  return null;
}

/** Infer a tz offset (minutes east of UTC) from a free-text location, or null if unknown. Matches the
 * whole location, then a trailing "City, ST"/"City, Country" token, then any word — most specific first.
 * With `atMs`, returns the DST-CORRECT offset at that instant (via the IANA zone) so a reminder set in
 * summer uses summer time (reminder-wrong-timezone-dst); without it, the STANDARD offset. Exported for tests. */
export function inferTzFromLocation(location: string, atMs?: number): number | null {
  if (atMs !== undefined) {
    const zone = inferZoneFromLocation(location);
    if (zone) { const off = offsetForZoneAt(zone, atMs); if (off !== null) return off; }
    // zone unknown / Intl failed -> fall through to the standard table below.
  }
  return inferTzFromLocationStd(location);
}

/** Standard (non-DST) offset lookup — the original table-only inference. */
function inferTzFromLocationStd(location: string): number | null {
  const norm = location.toLowerCase().replace(/[^\p{L}\p{N}\s,]/gu, " ").replace(/\s+/g, " ").trim();
  if (!norm) return null;
  // 1. whole string ("new york")
  if (norm in CITY_TZ) return CITY_TZ[norm]!;
  // 2. comma-separated "City, Region" — the REGION tail DISAMBIGUATES the city, so resolve it FIRST
  // (region-qualifier-tz-inference): "Paris, TX" must be US-Central (tx=-360), NOT Paris-France (60).
  const parts = norm.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1]!;
    if (tail in CITY_TZ) return CITY_TZ[tail]!;         // region wins ("..., tx" / "..., france")
    // Treat the tail as US (and fall through to the leftmost city token) when it's a US country marker
    // OR a 2-letter US-state-shaped code. Some state abbrevs (or/in/hi/la/de/ok/id/ne) are deliberately
    // OMITTED from CITY_TZ because they collide with common words, so "Portland, OR" has an unknown tail
    // that's still clearly a US state — the city ("portland") gives the right zone.
    const US_MARKERS = new Set(["usa", "us", "u s", "united states", "united states of america", "america"]);
    const isUsStateShaped = /^[a-z]{2}$/.test(tail);
    if (!US_MARKERS.has(tail) && !isUsStateShaped) {
      // The user QUALIFIED the city with a spelled-out region we don't recognize and isn't US ("San
      // Jose, Costa Rica"). Falling back to the leftmost city token would guess the wrong continent (San
      // Jose -> California, -480) and fire every reminder hours off, silently (inferTz-region-tail-wrong).
      // The point of a tail is to disambiguate; an unknown foreign tail means we CAN'T, so leave tz unset
      // (the caller asks) — matching the "a miss just leaves tz unset, never guesses wrong" contract.
      return null;
    }
    // US-marker / state-shaped tail: fall through to the leftmost known city token (a US city).
  }
  // 3. try the single-token city, then any whole word / adjacent word pair (reached for a no-comma
  // location, or a "City, USA" whose US-marker tail fell through above). Commas stripped so a city token
  // beside the marker still matches.
  const words = norm.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : "";
    if (pair && pair in CITY_TZ) return CITY_TZ[pair]!;
    if (words[i]! in CITY_TZ) return CITY_TZ[words[i]!]!;
  }
  return null;
}

/** Parse a user's reply to "which city?" into a location (+ optional tz) — permissive because we're
 * EXPECTING a place here, but rejects a reply that's clearly NOT a city (a slash command, a question,
 * or a long sentence) so an abandoned capture ("actually never mind, top HN story") falls through
 * instead of being saved as a bogus location. */
export function parseCityReply(text: string, atMs?: number): { location: string; tzOffsetMin?: number } | null {
  let s = text.trim();
  if (!s || s.length > 60 || s.startsWith("/")) return null;
  if (/[?]/.test(s)) return null;                        // a question, not a place
  const tz = parseUtcOffset(s);
  if (tz !== null) s = s.replace(/[([]?\b(?:utc|gmt)\s*[+-]\s*\d{1,2}(?::?\d{2})?\b[)\]]?/i, "").trim();
  // Strip a polite lead-in ("it's", "i'm in", "i live in") so "I'm in Austin" -> "Austin".
  s = s.replace(/^\s*(?:it'?s\s+|i'?m\s+in\s+|i\s+live\s+in\s+|in\s+)/i, "").trim();
  s = s.replace(/["']|[.,;]\s*$/g, "").trim();
  if (!s || s.split(/\s+/).length > 5 || !/[a-z]/i.test(s)) return null; // a place is short, not a sentence
  // Reject if it reads like a fresh task rather than a place.
  if (/\b(remind|schedule|watch|remember|weather|forecast|story|price|news|search|find|show me)\b/i.test(s)) return null;
  const location = s.slice(0, 120);
  const out: { location: string; tzOffsetMin?: number } = { location };
  // Prefer an explicit "UTC-5" if given; else infer from the city name (city-to-tz-inference) so a bare
  // "Austin" still fires reminders at the right local hour without the user typing an offset.
  const off = tz !== null ? tz : inferTzFromLocation(location, atMs);
  if (off !== null) out.tzOffsetMin = off;
  return out;
}

export class ProfileStore {
  private file: string;
  private items: Profile[] = [];
  constructor(opts: { file: string }) { this.file = opts.file; this.load(); }

  private load(): void {
    const obj = readJsonSafe<{ items?: Profile[] }>(this.file);
    if (obj && Array.isArray(obj.items)) this.items = obj.items.filter((p) => p && typeof p.chatId === "number");
  }
  private lastWriteOk = true;
  /** Did the most recent write to disk succeed? (persist-bool-all-stores) */
  lastSaveOk(): boolean { return this.lastWriteOk; }
  private persist(): boolean { return (this.lastWriteOk = atomicWriteJson(this.file, { v: 1, items: this.items })); }

  get(chatId: number): Profile | undefined { return this.items.find((p) => p.chatId === chatId); }

  /** Set/merge a chat's profile fields. Returns the updated record. */
  set(chatId: number, patch: Partial<Omit<Profile, "chatId">>): Profile {
    let p = this.items.find((x) => x.chatId === chatId);
    if (!p) { p = { chatId }; this.items.push(p); }
    if (patch.location !== undefined) p.location = patch.location;
    if (patch.units !== undefined) p.units = patch.units;
    if (patch.tzOffsetMin !== undefined) p.tzOffsetMin = patch.tzOffsetMin;
    if (patch.lat !== undefined) p.lat = patch.lat;
    if (patch.lng !== undefined) p.lng = patch.lng;
    if (patch.coordsAt !== undefined) p.coordsAt = patch.coordsAt;
    this.persist();
    return p;
  }

  /** Fresh (non-expired) coords for a chat, or undefined once past COORDS_TTL_MS (coords-privacy-ttl).
   * `now` injected so it's deterministic. Callers use this instead of reading lat/lng directly. */
  freshCoords(chatId: number, now: number): { lat: number; lng: number } | undefined {
    const p = this.get(chatId);
    if (!p || typeof p.lat !== "number" || typeof p.lng !== "number") return undefined;
    if (typeof p.coordsAt === "number" && now - p.coordsAt > COORDS_TTL_MS) return undefined;
    return { lat: p.lat, lng: p.lng };
  }

  /** Durable coords for a PROACTIVE run (recurring-near-me-pin-ttl-breaks), ignoring the privacy TTL that
   * freshCoords enforces. The TTL exists so an ad-hoc inbound turn stops leaking a ~1m pin to the LLM
   * after 6h — but a STANDING automation the user explicitly set ("weather near me every morning") needs
   * a location anchor to keep working; without this it silently fires "which city?" into the void the
   * same day. Use ONLY for scheduled/alert/digest runs the user opted into, never for ad-hoc replies. */
  homeCoords(chatId: number): { lat: number; lng: number } | undefined {
    const p = this.get(chatId);
    if (!p || typeof p.lat !== "number" || typeof p.lng !== "number") return undefined;
    return { lat: p.lat, lng: p.lng };
  }

  /** The chat's tz offset (min east of UTC) if set, else undefined so callers fall back to global. */
  offsetMin(chatId: number): number | undefined { return this.get(chatId)?.tzOffsetMin; }

  /** The chat's IANA zone (inferred from its saved location) if resolvable, else undefined. Lets a
   * recurring schedule store the zone so its reschedule stays DST-correct (recurring-reminder-dst-drift). */
  zone(chatId: number): string | undefined {
    const loc = this.get(chatId)?.location;
    return loc ? (inferZoneFromLocation(loc) ?? undefined) : undefined;
  }

  /** Forget a chat's stored profile (location/units/tz). Returns true if there was one to clear. */
  clear(chatId: number): boolean {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.chatId !== chatId);
    const cleared = this.items.length < before;
    if (cleared) this.persist();
    return cleared;
  }

  /** A one-line context string for the agent, or "" if nothing set. `now` (epoch ms) gates whether the
   * shared coords are still fresh (coords-privacy-ttl): once expired they're omitted so ~1m coords
   * aren't leaked to the LLM forever. Omit `now` to always include coords (back-compat / tests). */
  contextLine(chatId: number, now?: number): string {
    const p = this.get(chatId);
    if (!p) return "";
    const bits: string[] = [];
    if (p.location) bits.push(`home location is ${p.location}`);
    const coordsFresh = typeof p.lat === "number" && typeof p.lng === "number"
      && (now === undefined || typeof p.coordsAt !== "number" || now - p.coordsAt <= COORDS_TTL_MS);
    if (coordsFresh) bits.push(`current coordinates are ${p.lat!.toFixed(5)},${p.lng!.toFixed(5)} (use for "near me"/directions)`);
    if (p.units) bits.push(`prefers ${p.units} units`);
    if (typeof p.tzOffsetMin === "number") bits.push(`timezone is ${formatUtcOffset(p.tzOffsetMin)}`);
    return bits.join("; ");
  }

  size(): number { return this.items.length; }
}
