// Per-user profile (product-loop): home location + units, set once so location/unit-relative errands
// ("weather", "sushi near me", "how far to X") resolve without re-stating the city every message.
// Small persistent JSON store (atomic + corrupt-safe via safe-store), keyed by chatId. Free-infra.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

export interface Profile {
  chatId: number;
  location?: string;              // free-text home place, e.g. "Austin, TX"
  units?: "metric" | "imperial";  // preferred units
  tzOffsetMin?: number;           // minutes EAST of UTC (from a "UTC-5"-style clause), for schedules
}

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
export function parseSetLocation(text: string): { location: string; units?: "metric" | "imperial"; tzOffsetMin?: number } | null {
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
  // "/setlocation Austin" still fires reminders at the right local hour.
  const off = tzOffsetMin !== undefined ? tzOffsetMin : inferTzFromLocation(loc);
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
  ny: -300, nj: -300, fl: -300, ga: -300, ma: -300, pa: -300, va: -300, nc: -300, oh: -300, mi: -300, tx: -360, il: -360, tn: -360, mo: -360, mn: -360, co: -420, az: -420, ut: -420, nm: -420, ca: -480, wa: -480, or: -480, nv: -480,
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

/** Infer a tz offset (minutes east of UTC) from a free-text location, or null if unknown. Matches the
 * whole location, then a trailing "City, ST"/"City, Country" token, then any word — most specific first.
 * Standard (non-DST) offsets. Exported for tests. */
export function inferTzFromLocation(location: string): number | null {
  const norm = location.toLowerCase().replace(/[^\p{L}\p{N}\s,]/gu, " ").replace(/\s+/g, " ").trim();
  if (!norm) return null;
  // 1. whole string ("new york")
  if (norm in CITY_TZ) return CITY_TZ[norm]!;
  // 2. comma-separated parts, most specific (leftmost city) first, then the region tail ("austin, tx")
  const parts = norm.split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of parts) if (p in CITY_TZ) return CITY_TZ[p]!;
  // 3. any whole word / adjacent word pair
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
export function parseCityReply(text: string): { location: string; tzOffsetMin?: number } | null {
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
  const off = tz !== null ? tz : inferTzFromLocation(location);
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
  private persist(): void { atomicWriteJson(this.file, { v: 1, items: this.items }); }

  get(chatId: number): Profile | undefined { return this.items.find((p) => p.chatId === chatId); }

  /** Set/merge a chat's profile fields. Returns the updated record. */
  set(chatId: number, patch: Partial<Omit<Profile, "chatId">>): Profile {
    let p = this.items.find((x) => x.chatId === chatId);
    if (!p) { p = { chatId }; this.items.push(p); }
    if (patch.location !== undefined) p.location = patch.location;
    if (patch.units !== undefined) p.units = patch.units;
    if (patch.tzOffsetMin !== undefined) p.tzOffsetMin = patch.tzOffsetMin;
    this.persist();
    return p;
  }

  /** The chat's tz offset (min east of UTC) if set, else undefined so callers fall back to global. */
  offsetMin(chatId: number): number | undefined { return this.get(chatId)?.tzOffsetMin; }

  /** Forget a chat's stored profile (location/units/tz). Returns true if there was one to clear. */
  clear(chatId: number): boolean {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.chatId !== chatId);
    const cleared = this.items.length < before;
    if (cleared) this.persist();
    return cleared;
  }

  /** A one-line context string for the agent, or "" if nothing set. */
  contextLine(chatId: number): string {
    const p = this.get(chatId);
    if (!p) return "";
    const bits: string[] = [];
    if (p.location) bits.push(`home location is ${p.location}`);
    if (p.units) bits.push(`prefers ${p.units} units`);
    if (typeof p.tzOffsetMin === "number") bits.push(`timezone is ${formatUtcOffset(p.tzOffsetMin)}`);
    return bits.join("; ");
  }

  size(): number { return this.items.length; }
}
