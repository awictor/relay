// Date & calendar math (date-calendar-math): "how many days until Christmas", "what day is July 4th",
// "how old is someone born in 1990", "days between Mar 1 and my trip" had no home — calc.ts is
// arithmetic-only, so these fell to a slow browse or a hallucinated guess (the model doesn't know
// today's date reliably). This is a SAFE deterministic date evaluator: parse a common date phrase +
// a small set of intents (until / day-of-week / age / diff / N-days-from) against a caller-supplied
// "today". Pure (no Date.now inside — today is injected so it's offline-testable + tz-correct). No key.

export interface Ymd { y: number; m: number; d: number } // m is 1-12, d is 1-31

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A UTC Date at midnight for a Y-M-D (UTC so day math never crosses a DST boundary). */
function toDate(x: Ymd): Date { return new Date(Date.UTC(x.y, x.m - 1, x.d)); }
/** Whole days from a to b (b - a), calendar days (UTC midnight anchored). */
function daysBetween(a: Ymd, b: Ymd): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}
/** Day-of-week name for a date. */
export function weekdayName(x: Ymd): string { return WEEKDAYS[toDate(x).getUTCDay()]!; }
/** True if the Y-M-D is a real calendar date (catches Feb 30, month 13, etc.). */
function isValid(x: Ymd): boolean {
  if (x.m < 1 || x.m > 12 || x.d < 1 || x.d > 31) return false;
  const dt = toDate(x);
  return dt.getUTCFullYear() === x.y && dt.getUTCMonth() === x.m - 1 && dt.getUTCDate() === x.d;
}

/** Nth (1-based) given weekday of a month, e.g. the 4th Thursday of November = US Thanksgiving. */
function nthWeekdayOfMonth(y: number, month1: number, weekday: number, nth: number): Ymd {
  const first = new Date(Date.UTC(y, month1 - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  return { y, m: month1, d: day };
}

// Fixed-date holidays (month/day). Thanksgiving is computed (4th Thu of Nov). Year is filled by the caller.
const FIXED_HOLIDAYS: Record<string, { m: number; d: number }> = {
  christmas: { m: 12, d: 25 }, xmas: { m: 12, d: 25 }, "christmas eve": { m: 12, d: 24 },
  halloween: { m: 10, d: 31 }, "new year": { m: 1, d: 1 }, "new years": { m: 1, d: 1 },
  "new year's": { m: 1, d: 1 }, "new years day": { m: 1, d: 1 }, "new year's day": { m: 1, d: 1 },
  "valentine's": { m: 2, d: 14 }, valentines: { m: 2, d: 14 }, "valentine's day": { m: 2, d: 14 }, "valentines day": { m: 2, d: 14 },
  "independence day": { m: 7, d: 4 }, "july 4th": { m: 7, d: 4 }, "4th of july": { m: 7, d: 4 }, "fourth of july": { m: 7, d: 4 },
  "christmas day": { m: 12, d: 25 }, "st patrick's day": { m: 3, d: 17 }, "st patricks day": { m: 3, d: 17 },
  "cinco de mayo": { m: 5, d: 5 }, juneteenth: { m: 6, d: 19 }, "veterans day": { m: 11, d: 11 },
  "groundhog day": { m: 2, d: 2 }, "april fools": { m: 4, d: 1 }, "april fools day": { m: 4, d: 1 },
};

/**
 * Parse a date phrase into {y,m,d}. `today` supplies the current year for phrases with no year and
 * resolves "today"/"tomorrow"/"yesterday". `preferFuture` (for "days until X") rolls a bare month/day
 * (no year) to next year when it's already past this year. Returns null if it can't parse. Exported.
 */
export function parseDate(raw: string, today: Ymd, preferFuture = false): Ymd | null {
  let s = raw.toLowerCase().trim().replace(/^(the|on|is|was|of|in|at)\s+/g, "").replace(/[?.!,]+$/g, "").trim();
  if (!s) return null;
  if (s === "today") return { ...today };
  if (s === "tomorrow") { const d = new Date(toDate(today).getTime() + 86_400_000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; }
  if (s === "yesterday") { const d = new Date(toDate(today).getTime() - 86_400_000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; }

  // Named holiday (fixed or computed). No year -> this year, rolled forward if preferFuture + already past.
  if (s === "thanksgiving" || s === "thanksgiving day") {
    let t = nthWeekdayOfMonth(today.y, 11, 4, 4); // 4th Thursday of Nov
    if (preferFuture && daysBetween(today, t) < 0) t = nthWeekdayOfMonth(today.y + 1, 11, 4, 4);
    return t;
  }
  const holiday = FIXED_HOLIDAYS[s];
  if (holiday) {
    let cand: Ymd = { y: today.y, m: holiday.m, d: holiday.d };
    if (preferFuture && daysBetween(today, cand) < 0) cand = { ...cand, y: today.y + 1 };
    return isValid(cand) ? cand : null;
  }

  // ISO: 2026-12-25
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { const cand = { y: +m[1]!, m: +m[2]!, d: +m[3]! }; return isValid(cand) ? cand : null; }

  // US numeric: M/D or M/D/YYYY (or M-D-YYYY)
  m = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (m) {
    let year = m[3] ? +m[3] : today.y;
    if (m[3] && m[3].length === 2) year += year < 70 ? 2000 : 1900; // 2-digit year
    let cand: Ymd = { y: year, m: +m[1]!, d: +m[2]! };
    if (!m[3] && preferFuture && daysBetween(today, cand) < 0) cand = { ...cand, y: today.y + 1 };
    return isValid(cand) ? cand : null;
  }

  // "July 4", "July 4th", "July 4 2026", "4 July", "25 December 1990"
  const monthDay = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/);
  const dayMonth = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:,?\s+(\d{4}))?$/);
  const md = monthDay ? { mon: monthDay[1]!, day: +monthDay[2]!, yr: monthDay[3] } : dayMonth ? { mon: dayMonth[2]!, day: +dayMonth[1]!, yr: dayMonth[3] } : null;
  if (md) {
    const mm = MONTHS[md.mon];
    if (mm) {
      let cand: Ymd = { y: md.yr ? +md.yr : today.y, m: mm, d: md.day };
      if (!md.yr && preferFuture && daysBetween(today, cand) < 0) cand = { ...cand, y: today.y + 1 };
      return isValid(cand) ? cand : null;
    }
  }

  // Bare year "1990" -> Jan 1 of that year (mainly for "born in 1990" age math).
  if (/^\d{4}$/.test(s)) return { y: +s, m: 1, d: 1 };

  return null;
}

/** Peel a trailing date phrase off a labeled string ("my birthday on 2025-06-15", "the deadline July 4")
 * and parse it, dropping the label (datecalc-labeled-until). Tries progressively shorter trailing suffixes
 * (up to 4 words), stripping a leading "on/is/:" connector, until one parses. null if none does. */
function parseTrailingDate(phrase: string, today: Ymd): Ymd | null {
  const words = phrase.trim().split(/\s+/);
  for (let take = Math.min(4, words.length); take >= 1; take--) {
    const cand = words.slice(words.length - take).join(" ").replace(/^(?:on|is|for|by|the)\s+/i, "");
    const d = parseDate(cand, today, true);
    if (d) return d;
  }
  return null;
}

/** Human date like "Saturday, July 4, 2026". */
export function formatDate(x: Ymd): string {
  const mon = MONTH_NAMES[x.m - 1] ?? String(x.m);
  return `${weekdayName(x)}, ${mon} ${x.d}, ${x.y}`;
}

function plural(n: number, unit: string): string { return `${n} ${unit}${Math.abs(n) === 1 ? "" : "s"}`; }

/**
 * Answer a free-text date/calendar question against `today` (the user's LOCAL Y-M-D). Returns a ready
 * sentence, or null if it isn't a date question this tool handles. Intents: days-until, day-of-week,
 * age-from-birthdate, days-between, and date-in-N-days. Exported; the agent tool wraps this.
 */
export function runDateCalc(raw: string, today: Ymd): string | null {
  const q = raw.toLowerCase().trim();
  if (!q) return null;

  // "days between X and Y" / "days from X to Y" / "how many days between X and Y"
  let m = q.match(/(?:days?|weeks?)\s+(?:between|from)\s+(.+?)\s+(?:and|to|until|till)\s+(.+)$/);
  if (m) {
    const a = parseDate(m[1]!, today), b = parseDate(m[2]!, today);
    if (!a || !b) return null;
    const days = Math.abs(daysBetween(a, b));
    const weeks = q.includes("week") ? ` (${(days / 7).toFixed(1)} weeks)` : "";
    return `${formatDate(a)} → ${formatDate(b)} is ${plural(days, "day")}${weeks} apart.`;
  }

  // "how many days until X" / "days till X" / "how long until X" / "days until my birthday 2026-..."
  m = q.match(/(?:how\s+(?:many|long)\s+)?(?:days?|weeks?|time)\s+(?:until|till|to|before)\s+(.+)$/) || q.match(/(?:how\s+long\s+)(?:until|till|to)\s+(.+)$/);
  if (m) {
    // Parse the target. If the whole phrase doesn't parse (a labeled date like "my birthday on 2025-06-15"
    // or "the deadline is July 4"), peel a trailing date token off the end so the label is dropped
    // (datecalc-labeled-until): otherwise a common phrasing fell through to null -> a slow agent guess.
    const target = parseDate(m[1]!, today, true) ?? parseTrailingDate(m[1]!, today);
    if (!target) return null;
    const days = daysBetween(today, target);
    if (days === 0) return `${formatDate(target)} is today.`;
    if (days < 0) return `${formatDate(target)} was ${plural(-days, "day")} ago.`;
    const weeks = q.includes("week") ? ` (${(days / 7).toFixed(1)} weeks)` : "";
    return `${plural(days, "day")}${weeks} until ${formatDate(target)}.`;
  }

  // "what day (of the week) is/was X" / "what weekday is X"
  m = q.match(/what\s+(?:day(?:\s+of\s+the\s+week)?|weekday)\s+(?:is|was|will\s+it\s+be(?:\s+on)?)\s+(.+)$/);
  if (m) {
    const d = parseDate(m[1]!, today, false);
    if (!d) return null;
    const rel = daysBetween(today, d);
    const tense = rel < 0 ? "was" : "is";
    return `${formatDate(d)} — that ${tense} a ${weekdayName(d)}.`;
  }

  // "how old ... born X" / "age if born X" / "someone born X" -> full years (and months).
  m = q.match(/(?:how\s+old|age).*?(?:born|birth(?:day|date)?(?:\s+is)?|on|in)\s+(.+)$/) || q.match(/born\s+(?:on\s+|in\s+)?(.+?)\s*(?:how\s+old|age)/);
  if (m) {
    const birth = parseDate(m[1]!, today, false);
    if (!birth || daysBetween(birth, today) < 0) return null;
    let years = today.y - birth.y;
    let months = today.m - birth.m;
    if (today.d < birth.d) months--;
    if (months < 0) { years--; months += 12; }
    const monPart = months > 0 ? ` and ${plural(months, "month")}` : "";
    return `Someone born ${formatDate(birth)} is ${plural(years, "year")}${monPart} old.`;
  }

  // "what's the date in N days" / "N days from today" / "N weeks from now"
  m = q.match(/(?:date\s+)?(\d+)\s+(day|week)s?\s+(?:from\s+(?:now|today)|later|out|ahead)/) || q.match(/(?:what(?:'s| is)\s+the\s+date\s+)?in\s+(\d+)\s+(day|week)s?$/);
  if (m) {
    const n = +m[1]! * (m[2] === "week" ? 7 : 1);
    const d = new Date(toDate(today).getTime() + n * 86_400_000);
    const target: Ymd = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
    return `${m[1]} ${m[2]}${+m[1]! === 1 ? "" : "s"} from today is ${formatDate(target)}.`;
  }

  return null;
}
