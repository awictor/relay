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
  if (tzOffsetMin !== undefined) out.tzOffsetMin = tzOffsetMin;
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
