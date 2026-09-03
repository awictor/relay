// "Open now" for near-me (nearby-open-now): OSM tags a place's hours as an opening_hours string
// ("Mo-Fr 08:00-18:00; Sa 09:00-13:00", "24/7", "Mo-Su 00:00-24:00"). Relay showed it raw, so "pharmacy
// near me" at 9pm listed one that closed at 6 without saying so. This is a lightweight evaluator: given
// the string + the user's LOCAL day-of-week + minutes-since-midnight, decide open / closed / unknown.
// Deliberately covers the COMMON subset (weekday ranges/lists + time ranges + 24/7); an exotic rule it
// can't parse returns "unknown" (never a wrong open/closed). Pure; unit-tested.

export type OpenState = "open" | "closed" | "unknown";

const DOW = ["su", "mo", "tu", "we", "th", "fr", "sa"]; // index 0=Sun..6=Sat (JS getDay/getUTCDay order)
const DOW_IDX: Record<string, number> = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };

/** Parse "HH:MM" -> minutes since midnight, or null. */
function hm(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1]!, 10), min = parseInt(m[2]!, 10);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

// Expand a day token/range ("Mo", "Mo-Fr", "Sa-Su") into a set of dow indices, or null if unparseable.
function daySet(token: string): Set<number> | null {
  const t = token.toLowerCase().trim();
  const out = new Set<number>();
  for (const part of t.split(",")) {
    const range = part.trim().match(/^([a-z]{2})\s*-\s*([a-z]{2})$/);
    if (range) {
      const a = DOW_IDX[range[1]!], b = DOW_IDX[range[2]!];
      if (a === undefined || b === undefined) return null;
      for (let i = 0; i < 7; i++) { const d = (a + i) % 7; out.add(d); if (d === b) break; } // wraps Sa-Su
    } else {
      const d = DOW_IDX[part.trim()];
      if (d === undefined) return null;
      out.add(d);
    }
  }
  return out.size ? out : null;
}

/**
 * Evaluate an OSM opening_hours string at a local day+time. `dow` is 0..6 (Sun..Sat), `mins` is
 * minutes-since-midnight. Returns "open"/"closed"/"unknown". Exported for tests.
 */
export function isOpenNow(spec: string, dow: number, mins: number): OpenState {
  const s = String(spec ?? "").trim();
  if (!s) return "unknown";
  const low = s.toLowerCase();
  if (low === "24/7" || low === "24x7" || /\bmo-su\s+00:00-24:00\b/.test(low)) return "open";
  // Rules are ';'-separated; each is "[days] time[,time]" or just "time". A matching-day rule with a
  // time range that contains `mins` -> open. If a rule contains the word "closed"/"off" for today -> a
  // closure. If NOTHING parses, unknown; if days parse but no window covers now, closed.
  let anyParsed = false, dayMatchedToday = false;
  for (const raw of low.split(";")) {
    const rule = raw.trim();
    if (!rule) continue;
    // Split leading day spec (letters/ranges/commas) from the time spec.
    const m = rule.match(/^((?:[a-z]{2}(?:\s*-\s*[a-z]{2})?\s*,?\s*)+)?\s*(.*)$/);
    if (!m) continue;
    const dayTok = (m[1] ?? "").trim();
    const timeTok = (m[2] ?? "").trim();
    const days = dayTok ? daySet(dayTok) : null;
    // No day token means "every day" (e.g. "08:00-18:00"). A day token that won't parse -> skip rule.
    if (dayTok && !days) continue;
    const appliesToday = !dayTok || (days?.has(dow) ?? false);
    if (dayTok && days) anyParsed = true;
    if (!appliesToday) continue;
    dayMatchedToday = true;
    if (/\b(closed|off)\b/.test(timeTok)) return "closed"; // explicit closure for today
    // One or more comma-separated HH:MM-HH:MM windows.
    const windows = timeTok.match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/g) ?? [];
    if (windows.length) anyParsed = true;
    for (const w of windows) {
      const [a, b] = w.split("-");
      const start = hm(a!.trim()), end0 = hm(b!.trim());
      if (start === null || end0 === null) continue;
      const end = end0 === 0 ? 24 * 60 : end0; // "24:00" / "00:00" as close = midnight
      if (mins >= start && mins < end) return "open";
    }
  }
  if (!anyParsed) return "unknown";
  return dayMatchedToday ? "closed" : "closed"; // parsed days/times but nothing covers now -> closed
}

/** A short human tag for a place's open state ("open", "closed", "" when unknown). Exported. */
export function openTag(spec: string | undefined, dow: number, mins: number): string {
  if (!spec) return "";
  const st = isOpenNow(spec, dow, mins);
  return st === "open" ? "open now" : st === "closed" ? "closed now" : "";
}
