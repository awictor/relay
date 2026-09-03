// Countdowns (countdown-tracker): "countdown to my flight Dec 20", "days until vacation on 2026-07-01"
// — a one-shot "days until" (date_math) forgets the moment it answers. A countdown PERSISTS as a set of
// milestone reminders (a week out, the day before, the morning of) so Relay proactively pings as the day
// nears — an emotionally sticky re-engagement hook (trips, birthdays, deadlines). Pure parse + milestone
// math here; the handler turns the milestones into reminder-onces via the existing ScheduleStore (no new
// runner). `today`/`nowMs` are injected so it's offline-testable + tz-correct. No key, no anvil.
import { parseDate, formatDate, type Ymd } from "./datecalc.js";

export interface Countdown {
  label: string;   // what it's counting down to ("my flight", "vacation")
  target: Ymd;     // the target calendar date
  daysAway: number; // whole days from today to target (negative if past)
}

// Match "countdown to <label> [on|by] <date>" / "days until <label> <date>" / "<label> countdown <date>".
// The date is parsed by datecalc.parseDate (holidays, ISO, M/D, "July 4", "Dec 20"), so this just splits
// the label from the date phrase. A trailing date token is required (a bare "countdown to vacation" has
// no date to anchor). Exported for tests.
export function parseCountdown(text: string, today: Ymd): Countdown | null {
  const t = String(text ?? "").trim();
  // Grab everything after the intent verb, then peel the DATE off the end (longest trailing phrase that
  // parseDate accepts). "countdown to my flight on Dec 20" -> label "my flight", date "Dec 20".
  const m = t.match(/^\s*(?:countdown\s+(?:to|for)|days?\s+(?:until|til|till|to)|time\s+(?:until|til|to))\s+(.+)$/i)
    || t.match(/^\s*(.+?)\s+countdown\s+(.+)$/i);
  if (!m) return null;
  // Two shapes: intent-first (m[1] = "label ... date") or "<label> countdown <date>" (m[1]=label,m[2]=date).
  let labelPart: string, datePart: string | null = null;
  if (m[2] !== undefined) { labelPart = m[1]!.trim(); datePart = m[2]!.trim(); }
  else {
    // Peel a trailing date phrase off m[1]: try progressively shorter suffixes (up to 4 words) until one
    // parses, so "my flight on Dec 20 2026" splits at "Dec 20 2026" and label = "my flight".
    const words = m[1]!.trim().split(/\s+/);
    for (let take = Math.min(4, words.length); take >= 1; take--) {
      const cand = words.slice(words.length - take).join(" ").replace(/^(?:on|by|the)\s+/i, "");
      if (parseDate(cand, today, true)) { datePart = cand; labelPart = words.slice(0, words.length - take).join(" "); break; }
    }
    if (datePart === null) return null;
    labelPart = (labelPart! ?? "").trim();
  }
  let label = labelPart.replace(/\s+(?:on|by)$/i, "").replace(/^(?:my|the)\s+/i, "").replace(/[?.!,]+$/g, "").trim();
  if (!label) label = "it";
  const target = parseDate(datePart, today, true); // preferFuture: "Dec 20" means the next one
  if (!target) return null;
  return { label: label.slice(0, 60), target, daysAway: daysBetween(today, target) };
}

/** Whole days from a to b (b-a), UTC-midnight anchored (mirrors datecalc, kept local to avoid an export). */
function daysBetween(a: Ymd, b: Ymd): number {
  const ms = (x: Ymd) => Date.UTC(x.y, x.m - 1, x.d);
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

// Default milestone offsets (days BEFORE the target) to ping at. A countdown further out gets the
// earlier ones; a near-term one only the applicable milestones. Env-agnostic (kept simple).
export const MILESTONE_DAYS = [30, 7, 1, 0];

/**
 * The milestone fire instants (epoch ms) for a countdown, at `hourLocal` (default 9) in the chat's tz.
 * Only milestones strictly in the FUTURE (> nowMs) are returned — a countdown set 3 days out won't fire
 * the 30d/7d pings (already past), just the 1d + day-of. `tzOffsetMin` shifts local->UTC. Pure.
 */
export function countdownMilestones(target: Ymd, nowMs: number, tzOffsetMin = 0, hourLocal = 9): Array<{ daysBefore: number; whenMs: number }> {
  const out: Array<{ daysBefore: number; whenMs: number }> = [];
  for (const daysBefore of MILESTONE_DAYS) {
    // The milestone's calendar day = target minus daysBefore, at hourLocal local time.
    const dayUtcMidnight = Date.UTC(target.y, target.m - 1, target.d) - daysBefore * 86_400_000;
    // hourLocal in the chat's tz -> UTC instant: add the hour, subtract the east-offset.
    const whenMs = dayUtcMidnight + hourLocal * 3_600_000 - tzOffsetMin * 60_000;
    if (whenMs > nowMs) out.push({ daysBefore, whenMs });
  }
  return out;
}

/** The immediate "N days until X" confirmation line + the target date. */
export function formatCountdown(c: Countdown): string {
  if (c.daysAway < 0) return `"${c.label}" (${formatDate(c.target)}) was ${-c.daysAway} day${-c.daysAway === 1 ? "" : "s"} ago — that date has passed.`;
  const when = c.daysAway === 0 ? "today" : c.daysAway === 1 ? "tomorrow" : `in ${c.daysAway} days`;
  return `⏳ ${c.daysAway === 0 ? "Today's the day" : `${c.daysAway} day${c.daysAway === 1 ? "" : "s"} until "${c.label}"`} — ${formatDate(c.target)} (${when}). I'll ping you as it gets close.`;
}

/** The text of a single milestone ping (daysBefore 0 = the day itself). */
export function milestonePing(label: string, daysBefore: number): string {
  if (daysBefore === 0) return `⏳ Today's the day: ${label}!`;
  if (daysBefore === 1) return `⏳ Tomorrow: ${label}.`;
  return `⏳ ${daysBefore} days until ${label}.`;
}
