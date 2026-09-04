// Time-until countdown (time-until-tool): "how long until 5pm", "how many minutes until midnight", "time
// until 9:30" is a very common quick ask that had no path — date_math handles days-until-a-DATE but returns
// null for a clock time, and get_time only tells the current time. This computes the h/m remaining until the
// next occurrence of a clock time in the USER's timezone, rolling to tomorrow when the time already passed
// today. Pure: nowMs + tzOffsetMin are injected (both already threaded to the agent env), so it's fully
// deterministic to test. Exported for tests.

export interface TimeUntilRequest {
  hour: number;   // 0-23 local
  minute: number; // 0-59
  label: string;  // how to name the target in the reply ("5:00 PM", "midnight", "noon")
}

/**
 * Parse a "how long until <clock time>" ask into a target hour/minute, or null. Handles:
 *   "how long until 5pm", "how many minutes until 9:30am", "time until midnight", "until noon"
 *   "how long till 17:00", "how long until 8 o'clock"
 * Requires an "until/till" + a clock time (or midnight/noon) so a date ask ("how long until Friday") and
 * ordinary chat fall through to date_math / the agent. Exported for tests.
 */
export function parseTimeUntil(text: string): TimeUntilRequest | null {
  const t = String(text ?? "").toLowerCase().trim();
  // Must be a duration-to-a-time ask. "how long/how many minutes/hours until|till <X>".
  if (!/\b(how\s+long|how\s+many\s+(?:minutes?|hours?)|time|minutes?|hours?)\b.*\b(until|till|til|to)\b/.test(t)
      && !/^\buntil\b/.test(t)) return null;

  // midnight / noon shortcuts.
  if (/\b(until|till|til|to)\s+midnight\b/.test(t)) return { hour: 0, minute: 0, label: "midnight" };
  if (/\b(until|till|til|to)\s+noon\b/.test(t)) return { hour: 12, minute: 0, label: "noon" };

  // A clock time after until/till: "5pm", "9:30am", "17:00", "8 o'clock", "8".
  const m = t.match(/\b(?:until|till|til|to)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*o'?clock)?\b/);
  if (!m) return null;
  let hour = parseInt(m[1]!, 10);
  const minute = m[2] ? parseInt(m[2]!, 10) : 0;
  const ampm = m[3];
  if (hour > 23 || minute > 59) return null;
  if (ampm === "pm" && hour < 12) hour += 12;
  else if (ampm === "am" && hour === 12) hour = 0;
  // No am/pm + hour 1-11 is ambiguous; assume the NEXT occurrence (handled by rollover), keeping the
  // 12-hour reading as-is (so "until 8" at 3pm means 8pm tonight, at 9pm means 8am tomorrow — next 8:00).
  return { hour, minute, label: formatClock(hour, minute) };
}

/**
 * Compute the reply: the h/m remaining until the next occurrence of the target time in the user's tz.
 * nowMs = epoch; tzOffsetMin = minutes east of UTC. Deterministic. Rolls to tomorrow when the time has
 * already passed today (or is exactly now). Exported for tests.
 */
export function runTimeUntil(req: TimeUntilRequest, nowMs: number, tzOffsetMin: number): string {
  // Local wall-clock now = shift epoch by the tz offset, then read UTC fields (avoids host-tz coupling).
  const localNow = new Date(nowMs + tzOffsetMin * 60_000);
  const curMinutes = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
  const curSec = localNow.getUTCSeconds();
  const targetMinutes = req.hour * 60 + req.minute;
  // Minutes from now to the target today; if <=0 (passed or exactly now), roll to tomorrow (+1440).
  let deltaMin = targetMinutes - curMinutes;
  // Account for the seconds already elapsed in the current minute so "1h" doesn't over-report by <1min.
  let totalSec = deltaMin * 60 - curSec;
  if (totalSec <= 0) totalSec += 1440 * 60; // next occurrence is tomorrow
  const mins = Math.round(totalSec / 60);
  const h = Math.floor(mins / 60);
  const mm = mins % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (mm) parts.push(`${mm} minute${mm === 1 ? "" : "s"}`);
  const dur = parts.length ? parts.join(" ") : "less than a minute";
  const tomorrow = targetMinutes - curMinutes <= 0 ? " (tomorrow)" : "";
  return `⏳ ${dur} until ${req.label}${tomorrow}.`;
}

function formatClock(hour: number, minute: number): string {
  const ampm = hour < 12 ? "AM" : "PM";
  let h12 = hour % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}
