// World clock + timezone conversion (world-clock-tz): "what time is it in Tokyo" / "9am PT in London" /
// "convert 3pm EST to Tokyo time" is an everyday errand for anyone with remote contacts, yet the
// datetime injection only covers the USER's own zone — so the agent GUESSED (often wrong) or ran a slow,
// unreliable search. This does deterministic offset math from a city/region/abbrev -> UTC offset,
// reusing profile.ts's CITY_TZ table (via inferTzFromLocation) plus a tz-abbreviation map for "PT"/"EST".
// Pure helpers (nowMs injected) exported + unit-tested. STANDARD (non-DST) offsets, same as the reminder
// scheduler — a known, separately-tracked limitation (noted to the user by the tool, not silently wrong).
import { inferTzFromLocation } from "./profile.js";

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Timezone ABBREVIATIONS -> offset minutes east of UTC (standard time). Users type these constantly
// ("9am PT", "call at 3 EST"). Standard offsets; the daylight variants (PDT/EDT/BST/CEST) map to their
// summer offset since a user typing "PDT" means summer explicitly. Ambiguous CST (US -360 vs China +480)
// resolves to the US reading (far more common in this phrasing); a user meaning China says "China time".
const TZ_ABBR: Record<string, number> = {
  ut: 0, utc: 0, gmt: 0, z: 0, zulu: 0,
  est: -300, edt: -240, et: -300, "eastern": -300,
  cst: -360, cdt: -300, ct: -360, "central": -360,
  mst: -420, mdt: -360, mt: -420, "mountain": -420,
  pst: -480, pdt: -420, pt: -480, "pacific": -480,
  akst: -540, akdt: -480, hst: -600, hast: -600,
  bst: 60, // British Summer Time (users say BST in summer)
  cet: 60, cest: 120, met: 60,
  eet: 120, eest: 180, msk: 180,
  ist: 330, // India (the far-most-common IST; Israel/Ireland collide but India dominates this phrasing)
  gst: 240, // Gulf
  cst_cn: 480, hkt: 480, sgt: 480, awst: 480,
  jst: 540, kst: 540,
  aest: 600, aedt: 660, acst: 570, acdt: 630,
  nzst: 720, nzdt: 780,
};

export interface Zone { offsetMin: number; label: string; }

/** Resolve a place/region/abbreviation to a {offsetMin, label}, or null. Tries a tz abbreviation first
 * (whole-string or trailing token — "9am PT" / "PST"), then profile's CITY_TZ via inferTzFromLocation.
 * label is a tidy UTC±H:MM the formatter can show. Exported for tests. */
export function resolveZone(text: string): Zone | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const low = raw.toLowerCase().replace(/[^\p{L}\p{N}\s,+:-]/gu, " ").replace(/\s+/g, " ").trim();
  // whole string is an abbrev ("pst", "utc")
  if (low in TZ_ABBR) return { offsetMin: TZ_ABBR[low]!, label: utcLabel(TZ_ABBR[low]!) };
  // trailing token an abbrev ("9am pt", "3 est") — check the LAST word
  const words = low.split(" ");
  const last = words[words.length - 1]!;
  if (last in TZ_ABBR) return { offsetMin: TZ_ABBR[last]!, label: utcLabel(TZ_ABBR[last]!) };
  // explicit "utc+5" / "utc-8:30" / "gmt+1"
  const m = low.match(/(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/);
  if (m) {
    const off = (m[1] === "-" ? -1 : 1) * (parseInt(m[2]!, 10) * 60 + (m[3] ? parseInt(m[3]!, 10) : 0));
    return { offsetMin: off, label: utcLabel(off) };
  }
  // fall back to a city/region name
  const off = inferTzFromLocation(raw);
  return off === null ? null : { offsetMin: off, label: utcLabel(off) };
}

/** Render an offset (minutes east of UTC) as "UTC-5" / "UTC+5:30". Exported for tests. */
export function utcLabel(offsetMin: number): string {
  const sign = offsetMin < 0 ? "-" : "+";
  const h = Math.floor(Math.abs(offsetMin) / 60);
  const m = Math.abs(offsetMin) % 60;
  return `UTC${sign}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`;
}

/** Parse a clock time like "9am", "9:30 pm", "15:00", "noon", "midnight" to minutes-since-midnight, or
 * null. Exported for tests. */
export function parseClockTime(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (t === "noon" || t === "midday") return 12 * 60;
  if (t === "midnight") return 0;
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2]!, 10) : 0;
  const ap = m[3];
  if (h > 23 || min > 59) return null;
  if (ap === "am") { if (h === 12) h = 0; }
  else if (ap === "pm") { if (h !== 12) h += 12; }
  return h * 60 + min;
}

/** Format minutes-since-midnight as "9:00 AM". */
function fmtHM(mins: number): string {
  const m = ((mins % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60); const mm = m % 60;
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(mm).padStart(2, "0")} ${ap}`;
}

export type WorldClockRequest =
  | { kind: "now"; place: string }
  | { kind: "convert"; time: string; from: string; to: string };

/**
 * Parse a world-clock request, or null (not one -> falls through to the agent). Handles:
 *   now:     "what time is it in Tokyo", "time in London", "current time in Paris", "Tokyo time"
 *   convert: "what's 9am PT in London", "convert 3pm EST to Tokyo", "9:30am EST in IST"
 * Exported for tests.
 */
export function parseWorldClock(text: string): WorldClockRequest | null {
  const t = text.trim();

  // convert: "<time> <fromzone> in|to <place>"  e.g. "9am PT in London", "convert 3pm EST to Tokyo time"
  // Time = clock token; from = the word(s) between the time and the in/to; to = the tail.
  const conv = t.match(/^\s*(?:convert\s+|what(?:'?s| is)\s+)?((?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?)|noon|midnight|midday)\s+([a-z][\w\s,]*?)\s+(?:in|to)\s+(.+?)(?:\s+time)?\s*\??\s*$/i);
  if (conv) {
    const time = conv[1]!.trim();
    if (parseClockTime(time) !== null) {
      return { kind: "convert", time, from: conv[2]!.trim(), to: conv[3]!.trim() };
    }
  }

  // now: "what time is it in X" / "(current) time in X" / "the time in X"
  const now = t.match(/^\s*(?:what(?:'?s| is)?\s+)?(?:the\s+)?(?:current\s+)?(?:local\s+)?time\s+(?:is\s+it\s+)?(?:right\s+now\s+)?(?:in|at)\s+(.+?)(?:\s+(?:right\s+)?now)?\s*\??\s*$/i);
  if (now) return { kind: "now", place: now[1]!.trim() };

  // "<place> time" / "time in <place>" bare ("Tokyo time", "what time is it in Tokyo" caught above)
  const bare = t.match(/^\s*(?:what(?:'?s| is)?\s+)?(?:the\s+)?time\s+in\s+(.+?)\s*\??\s*$/i);
  if (bare) return { kind: "now", place: bare[1]!.trim() };

  return null;
}

/** Answer a parsed world-clock request from an injected nowMs, or null if a zone can't be resolved.
 * Exported for tests + the tool dispatch. */
export function runWorldClock(req: WorldClockRequest, nowMs: number): string | null {
  if (req.kind === "now") {
    const z = resolveZone(req.place);
    if (!z) return null;
    const d = new Date(nowMs + z.offsetMin * 60_000);
    const place = req.place.replace(/\s+time$/i, "").trim();
    return `In ${titleCase(place)} it's ${fmtHM(d.getUTCHours() * 60 + d.getUTCMinutes())}, ${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()} (${z.label}). Note: I use standard time, so during daylight-saving months this may be an hour off.`;
  }
  // convert
  const from = resolveZone(req.from);
  const to = resolveZone(req.to);
  const mins = parseClockTime(req.time);
  if (!from || !to || mins === null) return null;
  // Convert: a wall-clock time in `from` maps to UTC (mins - fromOffset), then to `to` (+ toOffset).
  const toMins = mins - from.offsetMin + to.offsetMin;
  const dayShift = Math.floor(toMins / 1440);
  const shiftNote = dayShift > 0 ? " (next day)" : dayShift < 0 ? " (previous day)" : "";
  return `${fmtHM(mins)} ${from.label} is ${fmtHM(toMins)}${shiftNote} in ${titleCase(req.to.replace(/\s+time$/i, "").trim())} (${to.label}). Note: standard time — may shift an hour during daylight-saving months.`;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
