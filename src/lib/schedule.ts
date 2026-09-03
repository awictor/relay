// Scheduled/proactive tasks (m4): a user texts "remind me to X in 10m" or "check X
// every morning" and Relay fires the agent later, texting the result unprompted. This
// module is the pure parse + persistent store; the runner (schedule-runner.ts) polls it.
// Free-infra: a JSON file like MemoryStore — no external cron/DB. Clock is injected so
// parse + due-check are deterministic and unit-testable.

import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

// once = fire + drop; daily = re-fire every day at hourMin; weekly = re-fire on the given weekdays at
// hourMin ("every monday", "weekdays at 8"); interval = re-fire every intervalMs ("every 2 hours").
export type ScheduleKind = "once" | "daily" | "weekly" | "interval";

export interface Schedule {
  id: string;
  chatId: number;
  kind: ScheduleKind;
  task: string;        // the natural-language task to hand runAgent
  dueMs: number;       // next fire time (epoch ms)
  hourMin?: string;    // "HH:MM" local, for daily/weekly reschedule
  offsetMin?: number;  // tz offset (min east of UTC) the hourMin is measured in, for daily/weekly reschedule
  weekdays?: number[]; // for weekly: days-of-week to fire on (0=Sun..6=Sat), in the user's zone
  intervalMs?: number; // for interval: gap between fires
  attempts?: number;   // failed fire attempts (once-reminder transient-retry); dropped after a cap
  reminderOnly?: boolean; // a pure personal to-do ("take meds"): echo the note at fire time, don't run the agent
  pausedUntil?: number; // snooze (snooze-automations): while now < this, the runner skips it WITHOUT firing
                        // or completing; auto-clears when it passes. Number.MAX_SAFE_INTEGER = indefinite.
  created: number;
}

// A pause with no duration ("pause btc") is indefinite until an explicit resume — stored as a far-future
// instant so the same "now < pausedUntil" runner check handles both timed snoozes and indefinite pauses.
export const PAUSE_INDEFINITE = Number.MAX_SAFE_INTEGER;

export interface ParsedSchedule {
  kind: ScheduleKind;
  task: string;
  dueMs: number;
  hourMin?: string;
  offsetMin?: number;  // tz offset used to compute dueMs, carried so reschedule stays in the user's zone
  weekdays?: number[];
  intervalMs?: number;
  reminderOnly?: boolean; // pure personal to-do: echo at fire time, don't run the agent
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Strip a leading "remind me to"/"remind me"/"reminder:" so the stored task reads naturally.
const REMINDER_PREFIX_RE = /^\s*(please\s+)?(remind me to|remind me|reminder:?|remember to)\s+/i;
function stripReminderPrefix(s: string): string {
  return s.replace(REMINDER_PREFIX_RE, "").trim();
}

// Info-fetch cues: if a reminder's task contains one, the user wants the AGENT to look something up at
// fire time ("remind me to check the weather at 8"), so it's NOT reminder-only. Absent = a pure personal
// to-do ("take my meds", "call mom") that should just echo the note back, not run a 30s browser errand.
// DELIBERATELY NARROW: bare question words (when/where/who/why) and generic verbs (find/get/top/tell/
// show) were removed — they dominate PERSONAL to-dos ("call mom when I get home", "find my keys", "top
// up my card", "tell dad happy birthday") and wrongly routed them to a confused browse
// (reminder-only-common-verb). Kept: explicit lookup/data words + "what's/how's the ..." question forms.
const FETCH_CUE_RE = /\b(check on|check the|look\s?up|search (?:for |the |online)|google|weather|forecast|temperature|the news|headlines?|the price|the cost|the score|scores|the status|standings|stock price|exchange rate|summar\w+|any new|what'?s (?:the|my|happening)|how'?s the)\b/i;

// A reminder is "reminder-only" (echo the stored text, don't run the agent) when it CAME from a reminder
// phrase AND its task has no info-fetch cue. Keeps "remind me to check BTC" on the agent path while
// "remind me to take my meds" just re-sends the note — no confused browse/refusal appended.
function isReminderOnly(raw: string, task: string): boolean {
  return REMINDER_PREFIX_RE.test(raw.trim()) && !FETCH_CUE_RE.test(task);
}

/**
 * Parse a natural scheduling phrase relative to `now`. Returns null if it isn't a
 * schedule request. Supported (case-insensitive):
 *   - "in N min/mins/minutes | N hour/hours | N day/days"  -> once
 *   - "tomorrow at 9am" / "tomorrow 9:30" / "at 5pm"        -> once
 *   - "every morning" (9am) / "every day at 8pm" / "daily at 07:00" -> daily
 * The task is whatever remains after removing the time clause + a reminder prefix.
 */
/**
 * Parse ONLY the timing from a clause and attach a caller-supplied task — for scheduling a
 * saved recipe ("schedule btc every morning" -> timing from "every morning", task = the
 * recipe's stored task). Reuses parseSchedule with a placeholder task, then swaps it in.
 */
export function parseScheduleFor(clause: string, task: string, now: number, offsetMin?: number): ParsedSchedule | null {
  const p = parseSchedule(`${clause} __recipe__`, now, offsetMin);
  if (!p || !task.trim()) return null;
  return { ...p, task: task.trim() };
}

/**
 * Split a "schedule <name> <when>" command into the saved-item name and the trailing time
 * clause. The name may itself contain time-ish words ("check in", "log in", "my daily
 * report") — so a naive "split at the first every|in|at" truncates it (DEV-0129: `schedule
 * check in every morning` wrongly yielded name="check"). This scans split points left→right
 * and returns the FIRST where the trailing clause parses as a PURE time clause (nothing but
 * the cadence phrase remains, checked via a placeholder task), giving the longest name that
 * still leaves a clean clause. `text` is the full command including the leading "schedule".
 * An optional "recipe" keyword ("schedule recipe <name> <when>", DEV-0131) is stripped and
 * surfaced as `explicitRecipe` so the caller can force the recipe over a same-named digest.
 * Returns null if no split yields a parseable clause.
 */
export function splitScheduleCommand(text: string, now: number): { name: string; clause: string; explicitRecipe: boolean } | null {
  const m = text.trim().match(/^schedule\s+(?:(recipe)\s+)?(.+)$/i);
  if (!m) return null;
  const explicitRecipe = !!m[1];
  const tokens = m[2]!.trim().split(/\s+/);
  for (let k = 1; k < tokens.length; k++) {
    const name = tokens.slice(0, k).join(" ");
    const clause = tokens.slice(k).join(" ");
    const p = parseSchedule(`${clause} __recipe__`, now);
    if (p && p.task === "__recipe__") return { name, clause, explicitRecipe };
  }
  return null;
}

/**
 * Parse a pause/snooze or resume command (snooze-automations). Returns {action, which, untilMs?} or
 * null. Lets a user quiet an automation through travel/noise instead of destroying it with /cancel:
 *   "snooze btc 3 days"  "pause btc for 2 hours"  "pause btc"  "mute my morning digest 1 week"
 *   "resume btc"  "unpause btc"  "unmute morning digest"
 * `which` is the trailing name/id (or "all"); untilMs is now + the parsed duration, absent for an
 * indefinite pause (caller uses PAUSE_INDEFINITE). Duration grammar reuses min/hour/day/week.
 */
export function parseSnoozeCommand(text: string, now: number): { action: "pause" | "resume"; which: string; untilMs?: number } | null {
  const t = text.trim();
  const resume = t.match(/^\s*(?:resume|unpause|unmute|un-?snooze)\s+(?:my\s+)?(.+?)\s*$/i);
  if (resume) { const which = cleanSnoozeName(resume[1]!); return which ? { action: "resume", which } : null; }
  const pause = t.match(/^\s*(?:snooze|pause|mute)\s+(?:my\s+)?(.+?)\s*$/i);
  if (!pause) return null;
  let rest = pause[1]!.trim();
  // A trailing duration: "for 3 days" / "3 days" / "2 hours" / "1 week" / "90 min". Strip it off the name.
  const dur = rest.match(/(?:\s+for)?\s+(\d+)\s*(min(?:ute)?s?|hours?|hrs?|days?|weeks?|wks?)\s*$/i);
  let untilMs: number | undefined;
  if (dur) {
    const n = parseInt(dur[1]!, 10);
    // Always STRIP the duration clause off the name (even when n===0) so "snooze btc for 0 hours" doesn't
    // leave "btc 0 hours" as the name — and a zero/negative duration is a no-op, NOT an indefinite pause
    // (snooze-zero-duration-guard): a fat-fingered "snooze btc 0 days" must not silently freeze btc
    // forever. Reject the whole command so the caller can ask for a positive duration.
    rest = rest.slice(0, dur.index).trim();
    if (n <= 0) return null;
    const unit = dur[2]!.toLowerCase();
    const ms = /^w/.test(unit) ? n * 7 * DAY : /^d/.test(unit) ? n * DAY : /^h/.test(unit) ? n * HOUR : n * MINUTE;
    untilMs = now + ms;
  }
  const which = cleanSnoozeName(rest);
  if (!which) return null;
  return untilMs !== undefined ? { action: "pause", which, untilMs } : { action: "pause", which };
}

function cleanSnoozeName(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "").replace(/^(?:the|my)\s+/i, "").replace(/\s+/g, " ").toLowerCase().slice(0, 60);
}

export function parseSchedule(text: string, now: number, offsetMin: number = tzOffsetMin()): ParsedSchedule | null {
  const raw = text.trim();
  const lower = raw.toLowerCase();

  // --- alarm (worded-duration-reminders): "set an alarm for 7am" / "wake me (up) at 6" — a headline
  // assistant expectation. Parse the clock time (am/pm, or a BARE hour which we bias am->pm sensibly for
  // "wake me": a bare 6 means 6am, a bare 9pm-ish stays as given) into a once at the next occurrence, with
  // a "wake up" reminder-only note. Handled here so a bare-hour alarm ("wake me at 6") that the generic
  // 'at' branch rejects (no am/pm) still works. ---
  // NOT when a duration unit follows ("alarm for 20 minutes" is a TIMER, handled by the relative branch
  // below — the negative lookahead stops the bare number being read as an 8pm clock hour).
  const alarm = lower.match(/\b(?:set\s+(?:an?\s+)?alarm(?:\s+for)?|wake\s+me(?:\s+up)?(?:\s+at)?)\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?\b(?!\s*(?:min|hour|hr|sec))/);
  if (alarm) {
    let hh = parseInt(alarm[1]!, 10);
    const mm = alarm[2] ? parseInt(alarm[2], 10) : 0;
    if (alarm[3]) hh = to24h(hh, alarm[3]);            // explicit am/pm
    else if (hh >= 1 && hh <= 11) { /* bare morning hour: 6 -> 6am, keep as-is */ }
    if (hh <= 23 && mm <= 59) {
      // Keep any purpose the user attached ("alarm for 6am to leave for the airport" -> task "leave for
      // the airport"), else a plain "wake up" (alarm-drops-task).
      const t = cleanTask(raw, alarm[0]!);
      const task = t || "wake up";
      return { kind: "once", task, dueMs: nextDailyMs(now, hh, mm, offsetMin), reminderOnly: true };
    }
  }

  // --- relative: "in 10 minutes", "in 2 hours", "in 1 day", "in 3 weeks" ---
  // Worded quantities (worded-duration-reminders): "in an hour" / "in half an hour" / "in a couple days"
  // / "in a few minutes" have no digit, so the \d+ match below missed them and the bot re-asked "when?"
  // though the user said exactly when. Normalize the count word to a digit first: a/an -> 1, couple -> 2,
  // few/several -> 3, half -> handled by a dedicated half-hour/half-an-hour rule (30 min).
  let relLower = lower.replace(/\bin\s+half\s+an?\s+hour\b/g, "in 30 minutes").replace(/\bin\s+half\s+a\s+day\b/g, "in 12 hours");
  relLower = relLower.replace(/\bin\s+(?:an?|one)\s+(min(?:ute)?s?|hour|hr|day|week|wk)\b/g, "in 1 $1")
    .replace(/\bin\s+(?:a\s+couple(?:\s+of)?|two)\s+(min(?:ute)?s?|hours?|hrs?|days?|weeks?|wks?)\b/g, "in 2 $1")
    .replace(/\bin\s+(?:a\s+few|several|three)\s+(min(?:ute)?s?|hours?|hrs?|days?|weeks?|wks?)\b/g, "in 3 $1");
  const rel = relLower.match(/\bin\s+(\d+)\s*(min(?:ute)?s?|hours?|hrs?|days?|weeks?|wks?)\b/);
  if (rel) {
    const n = parseInt(rel[1]!, 10);
    const unit = rel[2]!;
    const ms = /^w/.test(unit) ? n * 7 * DAY : /^h/.test(unit) ? n * HOUR : /^d/.test(unit) ? n * DAY : n * MINUTE;
    // Strip the ORIGINAL time phrase from the task, not the normalized one — the original may be worded
    // ("in half an hour"), which the normalized "in 30 minutes" wouldn't match in `raw`.
    // Longest alternatives FIRST so "a couple"/"a few"/"half an" win before the bare "a"/"an" (else "an?"
    // eats just the article and leaves "couple hours" in the task).
    const origClause = lower.match(/\bin\s+(?:half\s+an?\s+\w+|a\s+couple(?:\s+of)?\s+\w+|a\s+few\s+\w+|several\s+\w+|one\s+\w+|two\s+\w+|three\s+\w+|an?\s+\w+|\d+\s*\w+)/)?.[0] ?? rel[0]!;
    const task = cleanTask(raw, origClause);
    if (!task) return null;
    return { kind: "once", task, dueMs: now + ms, ...(isReminderOnly(raw, task) ? { reminderOnly: true } : {}) };
  }

  // --- interval: "every 2 hours", "every 30 min", "every 2 days", "every 2 weeks" (recurring gap) ---
  // Sub-daily AND multi-day/week gaps: "water the plants every 2 days" / "report every other week".
  // "every N minutes/hours/days/weeks"; "every other <unit>" = every 2. Distinct from the daily/weekly
  // clock branches below (those fire at a wall-clock time; this is a fixed gap from now).
  const interval = lower.match(/\bevery\s+(\d+|other)\s*(min(?:ute)?s?|hours?|hrs?|days?|weeks?|wks?)\b/);
  if (interval) {
    const n = interval[1] === "other" ? 2 : parseInt(interval[1]!, 10);
    const unit = interval[2]!;
    const ms = /^w/.test(unit) ? n * 7 * DAY : /^d/.test(unit) ? n * DAY : /^h/.test(unit) ? n * HOUR : n * MINUTE;
    if (n >= 1 && ms >= MINUTE) {
      const task = cleanTask(raw, interval[0]!);
      if (!task) return null;
      return { kind: "interval", task, dueMs: now + ms, intervalMs: ms, ...(isReminderOnly(raw, task) ? { reminderOnly: true } : {}) };
    }
  }

  const WEEKDAY: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

  // --- absolute date (absolute-date-reminders): "next Monday", "on March 5", "on the 15th", "on Dec 25"
  // — a one-shot at that calendar day. A detached "at <time>" sets the hour (else default 9am). Handled
  // BEFORE the weekly branch so "next friday" (no recurrence) fires ONCE, and so "on the 15th" (an
  // ordinal, no weekday) is caught. Appointment/birthday reminders were bouncing without this. ---
  {
    const loose = extractLooseAtTime(lower); // a stated "at 3pm" anywhere; else 9am default
    const hh = loose ? loose.hh : 9, mm = loose ? loose.mm : 0;
    const stripTime = (s: string) => (loose ? cleanTask(s, loose.clause) : s);
    // "next <weekday>" -> that weekday's next occurrence (strip the "next" so it doesn't linger in task).
    // Match the FULL weekday word (bounded) so "next month" isn't read as "next mon" (next-month-not-monday).
    const nextDow = lower.match(/\bnext\s+(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/);
    if (nextDow) {
      const dow = WEEKDAY[nextDow[1]!] ?? WEEKDAY[nextDow[1]!.slice(0, 3)];
      if (dow !== undefined) {
        const dueMs = nextWeeklyMs(now, hh, mm, [dow], offsetMin);
        const task = stripTime(cleanTask(raw, nextDow[0]!));
        if (task) return { kind: "once", task, dueMs, ...(isReminderOnly(raw, task) ? { reminderOnly: true } : {}) };
      }
    }
    // "on <Month> <day>" / "<Month> <day>" (day 1-31, optional ordinal/comma-year).
    const MONTHS: Record<string, number> = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
    // Match a FULL month name, OR a 3-letter abbrev that is NOT the prefix of a longer word (word-
    // boundary or a trailing period) — so 'mark 5' / 'separate 3' / 'junk 4' / 'may 6 people' don't get
    // hijacked into a date reminder (month-word-prefix-collision). 'may' the month still works after 'on'
    // or with an ordinal; a bare 'may N' is too ambiguous (modal verb) so it's only accepted with 'on'.
    const md = lower.match(/\b(?:on\s+)?(january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\.|\b)\s+([0-9]{1,2})(?:st|nd|rd|th)?\b/)
      ?? lower.match(/\bon\s+(may)\s+([0-9]{1,2})(?:st|nd|rd|th)?\b/); // bare "may N" only after "on"
    if (md) {
      const mon = MONTHS[md[1]!]; const day = parseInt(md[2]!, 10);
      if (mon !== undefined && day >= 1 && day <= 31) {
        const dueMs = dateAtMs(now, mon, day, hh, mm, offsetMin);
        const task = stripTime(cleanTask(raw, md[0]!));
        if (task) return { kind: "once", task, dueMs, ...(isReminderOnly(raw, task) ? { reminderOnly: true } : {}) };
      }
    }
    // "on the <Nth>" — a day-of-month in the current or next month.
    const dom = lower.match(/\bon\s+the\s+([0-9]{1,2})(?:st|nd|rd|th)\b/);
    if (dom) {
      const day = parseInt(dom[1]!, 10);
      if (day >= 1 && day <= 31) {
        const dueMs = domAtMs(now, day, hh, mm, offsetMin);
        const task = stripTime(cleanTask(raw, dom[0]!));
        if (task) return { kind: "once", task, dueMs, ...(isReminderOnly(raw, task) ? { reminderOnly: true } : {}) };
      }
    }
  }

  // --- weekly: "every monday", "every mon and thu", "every weekday", "weekends", optional "at HH:MM" ---
  const weeklyClause = lower.match(/\b(?:every\s+)?((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:(?:\s*,\s*|\s+and\s+|\s+)(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)*|weekdays?|weekends?)\b(?:\s+at\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?)?/);
  // Require a recurring cue ("every" / "weekday"/"weekend" / an explicit time) so a bare "monday" in
  // a task ("email bob monday's report") isn't turned into a weekly schedule.
  if (weeklyClause && /\bevery\b|weekday|weekend|\bat\b/.test(weeklyClause[0]!)) {
    let weekdays: number[];
    const grp = weeklyClause[1]!;
    if (/weekday/.test(grp)) weekdays = [1, 2, 3, 4, 5];
    else if (/weekend/.test(grp)) weekdays = [0, 6];
    else {
      weekdays = [...new Set(
        (grp.match(/mon|tue|wed|thu|fri|sat|sun[a-z]*|[a-z]+day/g) ?? [])
          .map((w) => WEEKDAY[w] ?? WEEKDAY[w.slice(0, 3)])
          .filter((n): n is number => n !== undefined),
      )];
    }
    if (weekdays.length) {
      let hh = 9, mm = 0;
      let extraClause = "";
      if (weeklyClause[2]) { hh = to24h(parseInt(weeklyClause[2], 10), weeklyClause[4]); mm = weeklyClause[3] ? parseInt(weeklyClause[3], 10) : 0; }
      else {
        // No time right after the weekday clause — look for a detached "at 8pm" elsewhere ("every monday
        // to submit the report at 9am") so it isn't defaulted to 9am + left in the task (recurring-time-
        // after-task).
        const loose = extractLooseAtTime(lower);
        if (loose) { hh = loose.hh; mm = loose.mm; extraClause = loose.clause; }
      }
      const hourMin = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
      let task = cleanTask(raw, weeklyClause[0]!);
      if (extraClause) task = cleanTask(task, extraClause);
      if (!task) return null;
      const dueMs = nextWeeklyMs(now, hh, mm, weekdays, offsetMin);
      // "Friday at 3pm" (a SINGLE weekday, no "every", not a weekday/weekend group) is a ONE-SHOT next-
      // occurrence reminder, NOT a standing weekly — turning it recurring made "remind me Friday at 3pm
      // to submit taxes" ping every Friday forever (weekly-single-weekday-once). Recurring only when the
      // user signalled repetition: "every", a weekday/weekend group, or more than one named day.
      const isGroup = /weekday|weekend/.test(grp);
      // A PLURAL weekday ("mondays at 9am", "fridays") is a clear recurring signal even without "every" —
      // treating it as a one-shot made "remind me mondays at 9am" fire once then never again (plural-
      // weekday-recurring, a regression in the single-weekday-once rule). Match a day word + trailing 's'.
      const isPlural = /\b(?:mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(?:day)?s\b/.test(grp);
      const recurring = /\bevery\b/.test(weeklyClause[0]!) || isGroup || isPlural || weekdays.length > 1;
      if (!recurring) {
        return { kind: "once", task, dueMs, ...(isReminderOnly(raw, task) ? { reminderOnly: true } : {}) };
      }
      return { kind: "weekly", task, dueMs, hourMin, offsetMin, weekdays, ...(isReminderOnly(raw, task) ? { reminderOnly: true } : {}) };
    }
  }

  // --- daily: "every morning", "every day at 8pm", "daily at 07:00" ---
  const daily = lower.match(/\b(every day|daily|every morning|every evening|every night)\b(?:\s+at\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?)?/);
  if (daily) {
    let hh: number, mm = 0;
    let extraClause = "";
    if (daily[2]) { hh = parseInt(daily[2], 10); mm = daily[3] ? parseInt(daily[3], 10) : 0; hh = to24h(hh, daily[4]); }
    else {
      // No time right after "every day"/"daily" — look for a detached "at 8pm" ("remind me every day to
      // take my meds at 8pm") before falling back to the morning/evening/night word default, so it isn't
      // silently scheduled at 9am with "at 8pm" left in the task (recurring-time-after-task).
      const loose = extractLooseAtTime(lower);
      if (loose) { hh = loose.hh; mm = loose.mm; extraClause = loose.clause; }
      else if (/morning/.test(daily[1]!)) hh = 9;
      else if (/evening/.test(daily[1]!)) hh = 18;
      else if (/night/.test(daily[1]!)) hh = 21;
      else hh = 9;
    }
    const hourMin = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    let task = cleanTask(raw, daily[0]!);
    if (extraClause) task = cleanTask(task, extraClause);
    if (!task) return null;
    return { kind: "daily", task, dueMs: nextDailyMs(now, hh, mm, offsetMin), hourMin, offsetMin, ...(isReminderOnly(raw, task) ? { reminderOnly: true } : {}) };
  }

  // --- 24-hour clock: "at 14:30", "tomorrow at 09:00" (DEV-0189) ---
  // The am/pm branch below can't match a 24h time, but a COLON form "HH:MM" is unambiguous (it can't
  // be a stray bare integer), so accept it here. Hour 0-23, minute 00-59; requires the colon + 2-digit
  // minute so a lone "at 5" (no colon, no am/pm) still doesn't match.
  const at24 = lower.match(/\b(tomorrow\s+)?(?:at\s+)?([01]?[0-9]|2[0-3]):([0-5][0-9])\b(?!\s*(?:am|pm))/);
  if (at24) {
    const hh = parseInt(at24[2]!, 10);
    const mm = parseInt(at24[3]!, 10);
    // "tomorrow" -> the calendar next day at hh:mm (dayAtMs, no double-roll); otherwise the next
    // occurrence today-or-later (nextDailyMs). DEV: the old "nextDailyMs then +DAY if <DAY away" made
    // "tomorrow at 9am" said after 9am fire ~47h out because nextDailyMs had already advanced to tomorrow.
    const due = at24[1] ? dayAtMs(now, hh, mm, 1, offsetMin) : nextDailyMs(now, hh, mm, offsetMin);
    const task = cleanTask(raw, at24[0]!);
    if (!task) return null;
    return { kind: "once", task, dueMs: due, ...(isReminderOnly(raw, task) ? { reminderOnly: true } : {}) };
  }

  // --- absolute-ish: "tomorrow at 9am", "tomorrow 9:30", "at 5pm" (today or next day) ---
  const at = lower.match(/\b(tomorrow\s+)?(?:at\s+)?([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)\b/);
  if (at && (at[1] || at[4])) { // require "tomorrow" or an am/pm to avoid matching stray numbers
    const hh = to24h(parseInt(at[2]!, 10), at[4]);
    const mm = at[3] ? parseInt(at[3], 10) : 0;
    // "tomorrow at 9am" -> calendar next day at hh:mm (dayAtMs); "at 5pm" -> next occurrence today-or-later.
    const due = at[1] ? dayAtMs(now, hh, mm, 1, offsetMin) : nextDailyMs(now, hh, mm, offsetMin);
    const task = cleanTask(raw, at[0]!);
    if (!task) return null;
    return { kind: "once", task, dueMs: due, ...(isReminderOnly(raw, task) ? { reminderOnly: true } : {}) };
  }

  return null;
}

function to24h(h: number, ampm?: string): number {
  if (!ampm) return h % 24;
  const pm = ampm.toLowerCase() === "pm";
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

/** Find a DETACHED clock time in a daily/weekly request whose time clause didn't sit right after the
 * cadence word — "remind me every day to take my meds at 8pm" / "every morning check the news at 7am".
 * Returns {hh, mm, clause} for the LAST "at HH[:MM][am/pm]" (or a 24h "at HH:MM") in the lowercased text,
 * or null. The caller uses it as a fallback when the adjacent time was absent (defaulted to 9am), and
 * strips `clause` from the task so "at 8pm" isn't left dangling (recurring-time-after-task). */
function extractLooseAtTime(lower: string): { hh: number; mm: number; clause: string } | null {
  // Scan all "at <time>" occurrences; take the last (most likely the intended fire time, after the task).
  const re = /\bat\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?\b/gi;
  let m: RegExpExecArray | null, last: RegExpExecArray | null = null;
  while ((m = re.exec(lower)) !== null) {
    // Require am/pm OR a colon-minute (matching the main branches' discipline) so a bare "at 5 tabs"
    // doesn't become a schedule time. Take the LAST such match.
    if (m[3] || m[2] !== undefined) last = m;
  }
  if (!last) return null;
  const rawH = parseInt(last[1]!, 10);
  if (rawH > 23) return null;
  const hh = to24h(rawH, last[3]);
  const mm = last[2] ? parseInt(last[2], 10) : 0;
  if (hh > 23 || mm > 59) return null;
  return { hh, mm, clause: last[0] };
}

// Timezone offset (minutes EAST of UTC) the user's "9am" is measured in. Default 0 = UTC. Set
// RELAY_TZ_OFFSET_MIN (e.g. -300 for US-Eastern EST, 60 for CET) so a daily fires at the user's
// wall-clock hour, not the deploy host's — on a UTC VM the old server-local setHours() made
// "every morning 9am" arrive at 9am UTC (middle of the night). Read at call time so it's tunable.
export function tzOffsetMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.RELAY_TZ_OFFSET_MIN);
  return Number.isFinite(n) ? n : 0;
}

// Next occurrence of hh:mm (in the user's timezone) at/after now, as an epoch-ms instant. Computes
// purely from UTC + the offset so it's independent of the SERVER's local zone (the bug this fixes).
export function nextDailyMs(now: number, hh: number, mm: number, offsetMin = tzOffsetMin()): number {
  // Shift into the user's zone, snap to today's hh:mm there, shift back to a UTC instant.
  const userNow = now + offsetMin * 60_000;
  const d = new Date(userNow);
  const atUser = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, 0, 0);
  let t = atUser - offsetMin * 60_000; // back to real UTC instant
  if (t <= now) t += DAY;
  return t;
}

// Next occurrence of hh:mm on one of `weekdays` (0=Sun..6=Sat, in the user's zone) at/after now.
// Scans up to 7 candidate days from today, returning the first that lands strictly after now.
// The instant for hh:mm on a specific offset-from-today day (in the user's zone), as epoch ms.
// dayOffset=1 => tomorrow. Used for "tomorrow at 9am": the calendar next day at that time, computed
// directly so it never double-rolls the way nextDailyMs + a "+DAY if still today" guard did (that
// made "tomorrow at 9am" said after 9am land ~47h out — nextDailyMs had ALREADY advanced to tomorrow).
export function dayAtMs(now: number, hh: number, mm: number, dayOffset: number, offsetMin = tzOffsetMin()): number {
  const d = new Date(now + offsetMin * 60_000);
  const atUser = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dayOffset, hh, mm, 0, 0);
  return atUser - offsetMin * 60_000;
}

// A specific calendar month+day at hh:mm in the user's zone, as epoch ms (absolute-date-reminders).
// Uses THIS year, but rolls to next year if that date already passed (so "on Jan 5" in December means
// next January, not one that's gone). Day is clamped by JS Date rollover (Feb 30 -> early March).
export function dateAtMs(now: number, month: number, day: number, hh: number, mm: number, offsetMin = tzOffsetMin()): number {
  const d = new Date(now + offsetMin * 60_000);
  let year = d.getUTCFullYear();
  let atUser = Date.UTC(year, month, day, hh, mm, 0, 0);
  if (atUser - offsetMin * 60_000 <= now) { year += 1; atUser = Date.UTC(year, month, day, hh, mm, 0, 0); }
  return atUser - offsetMin * 60_000;
}

// A day-of-month at hh:mm in the user's zone: this month if still upcoming, else next month
// (absolute-date-reminders "on the 15th"). Rolls forward month-by-month so a 31st in a short month lands
// the next month that has it (JS Date rollover handles the overflow).
export function domAtMs(now: number, day: number, hh: number, mm: number, offsetMin = tzOffsetMin()): number {
  const d = new Date(now + offsetMin * 60_000);
  for (let add = 0; add <= 12; add++) {
    const atUser = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, day, hh, mm, 0, 0);
    const t = atUser - offsetMin * 60_000;
    if (t > now && new Date(atUser).getUTCDate() === day) return t; // valid day in that month + future
  }
  return dayAtMs(now, hh, mm, 1, offsetMin); // fallback (shouldn't hit)
}

export function nextWeeklyMs(now: number, hh: number, mm: number, weekdays: number[], offsetMin = tzOffsetMin()): number {
  const want = new Set(weekdays);
  const userNow = now + offsetMin * 60_000;
  const base = new Date(userNow);
  for (let add = 0; add <= 7; add++) {
    const atUser = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + add, hh, mm, 0, 0);
    const dow = new Date(atUser).getUTCDay();
    if (!want.has(dow)) continue;
    const t = atUser - offsetMin * 60_000;
    if (t > now) return t;
  }
  // Fallback (shouldn't hit with a non-empty weekday set): a week out.
  return now + 7 * DAY;
}

// Quiet-hours (quiet-hours): if `now` falls inside a [startHour, endHour) window in the user's zone
// (wrapping midnight when start>end, e.g. 22->7), return the epoch-ms of the NEXT endHour boundary so
// a proactive send defers to then; else 0 (not quiet -> send now). startHour===endHour = no window.
export function quietUntilMs(now: number, startHour: number, endHour: number, offsetMin = tzOffsetMin()): number {
  if (startHour === endHour) return 0;
  const d = new Date(now + offsetMin * 60_000);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const inWindow = startHour < endHour ? (h >= startHour && h < endHour) : (h >= startHour || h < endHour);
  if (!inWindow) return 0;
  // Next endHour boundary: today if we're before it, else tomorrow (wrapping case, pre-midnight).
  const endToday = h < endHour ? 0 : 1;
  return dayAtMs(now, endHour, 0, endToday, offsetMin);
}

function cleanTask(raw: string, timeClause: string): string {
  // Remove the time clause (case-insensitive) + reminder prefix + dangling connectors.
  const idx = raw.toLowerCase().indexOf(timeClause.toLowerCase());
  let s = idx >= 0 ? raw.slice(0, idx) + " " + raw.slice(idx + timeClause.length) : raw;
  s = stripReminderPrefix(s);
  return s.replace(/\s+/g, " ").replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, "").trim();
}

// --- persistent store (JSON file, gitignored — like MemoryStore) ---

export interface ScheduleStoreOptions {
  file: string;
  maxPerChat?: number;   // cap runaway scheduling (default 20)
}

export class ScheduleStore {
  private file: string;
  private maxPerChat: number;
  private items: Schedule[] = [];
  private seq = 0;

  constructor(opts: ScheduleStoreOptions) {
    this.file = opts.file;
    this.maxPerChat = opts.maxPerChat ?? 20;
    this.load();
  }

  private load(): void {
    const obj = readJsonSafe<{ items?: Schedule[]; seq?: number }>(this.file);
    if (!obj) return; // missing or corrupt (corrupt is backed up to .corrupt by readJsonSafe)
    if (Array.isArray(obj.items)) this.items = obj.items.filter((s) => s && typeof s.id === "string" && typeof s.dueMs === "number");
    if (typeof obj.seq === "number") this.seq = obj.seq;
  }

  // Whether the LAST persist() write reached disk. Read synchronously right after add()/save() (no
   // await between, so it's race-free) to hedge a "saved" confirmation when the disk write failed
   // (persist-bool-all-stores). Defaults true so a read before any write isn't a false alarm.
  private lastWriteOk = true;
  /** Did the most recent write to disk succeed? See lastWriteOk. */
  lastSaveOk(): boolean { return this.lastWriteOk; }
  private persist(): boolean {
    return (this.lastWriteOk = atomicWriteJson(this.file, { v: 1, seq: this.seq, items: this.items }));
  }

  /** Add a schedule for a chat. Returns the stored record, or null if the chat is at its cap. */
  add(chatId: number, p: ParsedSchedule, now: number): Schedule | null {
    if (this.items.filter((s) => s.chatId === chatId).length >= this.maxPerChat) return null;
    const s: Schedule = { id: `s${++this.seq}`, chatId, kind: p.kind, task: p.task, dueMs: p.dueMs, hourMin: p.hourMin, offsetMin: p.offsetMin, weekdays: p.weekdays, intervalMs: p.intervalMs, ...(p.reminderOnly ? { reminderOnly: true } : {}), created: now };
    this.items.push(s);
    this.persist();
    return s;
  }

  list(chatId: number): Schedule[] {
    return this.items.filter((s) => s.chatId === chatId).sort((a, b) => a.dueMs - b.dueMs);
  }

  /** Remove by id (optionally scoped to a chat). Returns true if something was removed. */
  remove(id: string, chatId?: number): boolean {
    const before = this.items.length;
    this.items = this.items.filter((s) => !(s.id === id && (chatId === undefined || s.chatId === chatId)));
    const removed = this.items.length < before;
    if (removed) this.persist();
    return removed;
  }

  /** Push a schedule's next fire to a specific instant (quiet-hours defer) without advancing its
   * recurrence. Only moves it FORWARD (never earlier). Returns true if found + moved. */
  deferTo(id: string, whenMs: number): boolean {
    const s = this.items.find((x) => x.id === id);
    if (!s || whenMs <= s.dueMs) return false;
    s.dueMs = whenMs;
    this.persist();
    return true;
  }

  /** Snooze (snooze-automations): pause every schedule for a chat that MATCHES `which` (an id, a marker
   * name — alert:/digest:/recipe: — or a substring of a reminder's task; "all" matches every schedule)
   * until `untilMs` (PAUSE_INDEFINITE for no end). The runner skips a paused schedule without firing or
   * completing it, and auto-clears the flag once now passes untilMs. Returns how many were paused. */
  pause(chatId: number, which: string, untilMs: number): number {
    // A "once" reminder is a discrete promise ("remind me at 3pm"). An INDEFINITE pause (from "snooze
    // all" / "pause <x>" with no duration) would freeze it FOREVER — a silent black hole for the highest-
    // trust item (pause-all-freezes-once-reminders). Snooze is for quieting RECURRING noise, so skip a
    // once on an indefinite pause. A TIMED snooze of a once is fine: the runner auto-resumes it when the
    // window elapses (clearExpiredPause), so it still fires — just later. Returns how many were paused.
    const matches = this.matchByRef(chatId, which).filter((s) => !(s.kind === "once" && untilMs === PAUSE_INDEFINITE));
    for (const s of matches) s.pausedUntil = untilMs;
    if (matches.length) this.persist();
    return matches.length;
  }

  /** Resume (snooze-automations): clear the pause on every matching schedule so the runner fires it
   * again. A resumed recurring schedule whose next fire is now in the past is pulled forward to now so
   * it fires promptly on the next tick rather than storming a backlog. Returns how many were resumed. */
  resume(chatId: number, which: string, now: number): number {
    const matches = this.matchByRef(chatId, which).filter((s) => s.pausedUntil !== undefined);
    for (const s of matches) {
      s.pausedUntil = undefined;
      if (s.kind !== "once" && s.dueMs < now) s.dueMs = now;
    }
    if (matches.length) this.persist();
    return matches.length;
  }

  /** Clear a schedule's pause flag if it has EXPIRED (now past pausedUntil) — a timed snooze auto-resumes
   * without an explicit command, so the runner calls this before firing to tidy the stale flag. No-op if
   * absent or still active. Returns true if it cleared one. */
  clearExpiredPause(id: string, now: number): boolean {
    const s = this.items.find((x) => x.id === id);
    if (!s || s.pausedUntil === undefined || now < s.pausedUntil) return false;
    s.pausedUntil = undefined;
    this.persist();
    return true;
  }

  /** Find a chat's schedules by a loose reference: "all", an exact id, an alert:/digest:/recipe: marker
   * name (case-insensitive), or a substring of the (marker-stripped) task. Shared by pause/resume. */
  private matchByRef(chatId: number, which: string): Schedule[] {
    const mine = this.items.filter((s) => s.chatId === chatId);
    const w = which.trim().toLowerCase();
    if (!w) return [];
    if (w === "all") return mine;
    const labelOf = (s: Schedule) => {
      const marker = s.task.match(/^(?:alert|digest|recipe):(.+)$/i);
      return (marker ? marker[1]! : s.task).toLowerCase();
    };
    // Tiered so a snooze/pause is SURGICAL, not a broad substring sweep (matchByRef-word-boundary): an
    // EXACT id or label wins outright; else a WHOLE-WORD match ("news" hits "news" / "morning news", not
    // "call about the news story"); only if nothing matches on a word boundary do we fall back to a raw
    // substring. So "pause news" freezes the news watch, not an unrelated reminder that mentions news.
    const exact = mine.filter((s) => s.id.toLowerCase() === w || labelOf(s) === w);
    if (exact.length) return exact;
    const wordRe = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const word = mine.filter((s) => wordRe.test(labelOf(s)));
    if (word.length) return word;
    return mine.filter((s) => labelOf(s).includes(w));
  }

  /** Remove every schedule for a chat whose task exactly matches `task`. Returns how many were
   * removed. Used to clean up orphaned schedules when a digest/recipe/alert is forgotten (a scheduled
   * digest stores "digest:<name>", an alert "alert:<name>", a scheduled recipe the recipe's task) —
   * otherwise the runner keeps firing "(digest is empty or was removed)" forever. */
  removeByTask(chatId: number, task: string): number {
    const before = this.items.length;
    this.items = this.items.filter((s) => !(s.chatId === chatId && s.task === task));
    const removed = before - this.items.length;
    if (removed) this.persist();
    return removed;
  }

  /** Schedules due at/before now. */
  dueNow(now: number): Schedule[] {
    return this.items.filter((s) => s.dueMs <= now);
  }

  /** Record a failed fire attempt for a schedule; returns the new attempt count (0 if not found).
   * Lets the runner defer a transiently-failing "once" reminder and drop it only after a cap, so a
   * momentary anvil/LLM hiccup doesn't delete an explicit single-shot promise. */
  recordFailure(id: string): number {
    const s = this.items.find((x) => x.id === id);
    if (!s) return 0;
    s.attempts = (s.attempts ?? 0) + 1;
    this.persist();
    return s.attempts;
  }

  /** Clear a schedule's failure streak (after a successful fire). No-op if not found / already 0. */
  resetFailures(id: string): void {
    const s = this.items.find((x) => x.id === id);
    if (s && s.attempts) { s.attempts = 0; this.persist(); }
  }

  /** Re-stamp a chat's RECURRING schedules to a new tz offset (min east of UTC) and recompute their
   * next fire so a daily/weekly reminder created before the user set their timezone stops firing at the
   * wrong wall-clock hour (tz-restamp-on-setlocation). Only daily/weekly are re-stamped (they carry an
   * hourMin to recompute from); interval is gap-based (tz-independent) and once is left alone — a
   * relative "in 3 hours" once has no clock meaning to shift, and a clock "at 8am" once fires just once
   * shortly anyway. Returns how many schedules were moved. */
  restampTz(chatId: number, offsetMin: number, now: number): number {
    let moved = 0;
    for (const s of this.items) {
      if (s.chatId !== chatId) continue;
      if ((s.offsetMin ?? 0) === offsetMin) continue;
      if (s.kind === "daily" && s.hourMin) {
        const [hh, mm] = s.hourMin.split(":").map((n) => parseInt(n, 10));
        s.offsetMin = offsetMin;
        s.dueMs = nextDailyMs(now, hh!, mm!, offsetMin);
        moved++;
      } else if (s.kind === "weekly" && s.hourMin && s.weekdays?.length) {
        const [hh, mm] = s.hourMin.split(":").map((n) => parseInt(n, 10));
        s.offsetMin = offsetMin;
        s.dueMs = nextWeeklyMs(now, hh!, mm!, s.weekdays, offsetMin);
        moved++;
      }
    }
    if (moved) this.persist();
    return moved;
  }

  /** After firing: drop a "once", or advance a recurring schedule to its next occurrence. */
  complete(id: string, now: number): void {
    const s = this.items.find((x) => x.id === id);
    if (!s) return;
    const [hh, mm] = (s.hourMin ?? "9:0").split(":").map((n) => parseInt(n, 10));
    // Reschedule in the SAME zone the schedule was created in (per-chat offset stamped at add time),
    // falling back to the global default for schedules created before offsets existed.
    const off = s.offsetMin ?? tzOffsetMin();
    if (s.kind === "daily" && s.hourMin) {
      s.dueMs = nextDailyMs(now, hh!, mm!, off);
    } else if (s.kind === "weekly" && s.hourMin && s.weekdays?.length) {
      s.dueMs = nextWeeklyMs(now, hh!, mm!, s.weekdays, off);
    } else if (s.kind === "interval" && s.intervalMs) {
      // Advance by whole intervals past now so a missed tick (downtime) doesn't fire a burst of backlog.
      const next = s.dueMs + Math.max(1, Math.ceil((now - s.dueMs) / s.intervalMs)) * s.intervalMs;
      s.dueMs = next > now ? next : now + s.intervalMs;
    } else {
      this.items = this.items.filter((x) => x.id !== id);
    }
    this.persist();
  }

  size(): number { return this.items.length; }
}
