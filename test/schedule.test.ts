import { describe, it, expect, afterEach } from "vitest";
import { parseSchedule, parseScheduleFor, splitScheduleCommand, parseSnoozeCommand, ScheduleStore, quietUntilMs, PAUSE_INDEFINITE } from "../src/lib/schedule.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NOW = 1_700_000_000_000; // fixed epoch for deterministic relative math
const MIN = 60_000, HR = 3_600_000, DAY = 86_400_000;

describe("parseSchedule — relative", () => {
  it("in N minutes/hours/days -> once, correct delta, task cleaned", () => {
    const a = parseSchedule("remind me to stretch in 10 minutes", NOW)!;
    expect(a.kind).toBe("once");
    expect(a.dueMs - NOW).toBe(10 * MIN);
    expect(a.task).toBe("stretch");

    const b = parseSchedule("in 2 hours check the news", NOW)!;
    expect(b.dueMs - NOW).toBe(2 * HR);
    expect(b.task).toBe("check the news");

    const c = parseSchedule("ping me in 1 day about the invoice", NOW)!;
    expect(c.dueMs - NOW).toBe(1 * DAY);
    expect(c.task).toMatch(/invoice/);
  });

  it("worded durations resolve to a relative once (worded-duration-reminders)", () => {
    expect(parseSchedule("remind me to leave in an hour", NOW)!.dueMs - NOW).toBe(HR);
    expect(parseSchedule("remind me in half an hour to check the oven", NOW)!.dueMs - NOW).toBe(30 * MIN);
    expect(parseSchedule("ping me in a couple hours", NOW)!.dueMs - NOW).toBe(2 * HR);
    const few = parseSchedule("in a few minutes take the pizza out", NOW)!;
    expect(few.dueMs - NOW).toBe(3 * MIN);
    expect(few.task).toBe("take the pizza out"); // count word stripped, not left in the task
  });
  it("alarm phrasing schedules a wake-up once, incl. a bare hour (worded-duration-reminders)", () => {
    const a = parseSchedule("set an alarm for 7am", NOW)!;
    expect(a.kind).toBe("once");
    expect(a.reminderOnly).toBe(true);
    expect(new Date(a.dueMs).getUTCHours()).toBe(7);
    const w = parseSchedule("wake me at 6", NOW)!; // bare hour, no am/pm — the generic 'at' branch rejects it
    expect(w.kind).toBe("once");
    expect(new Date(w.dueMs).getUTCHours()).toBe(6);
    expect(parseSchedule("set an alarm for 9pm", NOW)!.dueMs && new Date(parseSchedule("set an alarm for 9pm", NOW)!.dueMs).getUTCHours()).toBe(21);
  });
  it("returns null for a non-schedule message", () => {
    expect(parseSchedule("what's the top HN story", NOW)).toBeNull();
    expect(parseSchedule("compare these two links", NOW)).toBeNull();
  });

  it("returns null when there's a time but no task", () => {
    expect(parseSchedule("in 10 minutes", NOW)).toBeNull();
    expect(parseSchedule("remind me in 5 mins", NOW)).toBeNull();
  });

  it("marks a pure personal to-do as reminderOnly, but not an info-fetch reminder (reminder-only-no-agent)", () => {
    // Personal to-dos: echo at fire time, don't run the browser agent.
    expect(parseSchedule("remind me to take my meds in 3 hours", NOW)!.reminderOnly).toBe(true);
    expect(parseSchedule("remind me to call mom at 5pm", NOW)!.reminderOnly).toBe(true);
    expect(parseSchedule("remind me to stretch every 2 hours", NOW)!.reminderOnly).toBe(true);
    // Info-fetch reminders stay on the agent path (an explicit lookup cue present).
    expect(parseSchedule("remind me to check the weather at 8am", NOW)!.reminderOnly).toBeUndefined();
    expect(parseSchedule("remind me to look up the score in 1 hour", NOW)!.reminderOnly).toBeUndefined();
    // A non-reminder schedule ("in 2 hours check the news") is never reminder-only.
    expect(parseSchedule("in 2 hours check the news", NOW)!.reminderOnly).toBeUndefined();
  });

  // reminder-only-common-verb: personal to-dos that HAPPEN to contain a common verb/question word
  // (find/get/when/where/top/tell/show) must NOT be misrouted to a 30s browse — they echo.
  it("keeps personal to-dos with a common verb/question word as reminderOnly (reminder-only-common-verb)", () => {
    for (const t of [
      "remind me to find my keys in 20 min",
      "remind me to get the mail at 5pm",
      "remind me to top up my transit card tomorrow at 9am",
      "remind me to water the plants every morning",
      "remind me to show my badge at the door in 2 hours",
      "remind me to call the dentist at 9am",
      "remind me to tell mom about dinner at 6pm",
    ]) {
      expect(parseSchedule(t, NOW)!.reminderOnly, t).toBe(true);
    }
  });
});

describe("parseSchedule — 24-hour clock (DEV-0189)", () => {
  it("'at HH:MM' 24h time parses to a once-task (the am/pm branch couldn't)", () => {
    const a = parseSchedule("remind me to call the vet at 14:30", NOW)!;
    expect(a).not.toBeNull();
    expect(a.kind).toBe("once");
    expect(a.task).toBe("call the vet");
    expect(a.clockTime).toBe(true); // a wall-clock once -> eligible for tz-restamp (once-reminder-tz-restamp)
    // due is the next 14:30 in the configured zone (default UTC) — assert host-independently.
    const d = new Date(a.dueMs);
    expect(d.getUTCHours()).toBe(14);
    expect(d.getUTCMinutes()).toBe(30);
  });
  it("a RELATIVE once ('in 2 hours') is NOT flagged clockTime (no wall-clock to restamp)", () => {
    const r = parseSchedule("remind me to stretch in 2 hours", NOW)!;
    expect(r.kind).toBe("once");
    expect(r.clockTime).toBeFalsy();
  });
  it("'tomorrow at 09:00' forces the next day", () => {
    const s = parseSchedule("tomorrow at 09:00 send the report", NOW)!;
    expect(s.kind).toBe("once");
    expect(s.task).toBe("send the report");
    expect(new Date(s.dueMs).getUTCHours()).toBe(9);
  });
  it("a bare 'at 5' (no colon, no am/pm) still does NOT match (no stray-integer schedule)", () => {
    expect(parseSchedule("look at 5 tabs", NOW)).toBeNull();
  });
  it("am/pm times still route through the existing branch (no regression)", () => {
    const s = parseSchedule("remind me at 2:30pm to stretch", NOW)!;
    expect(s.kind).toBe("once");
    expect(new Date(s.dueMs).getUTCHours()).toBe(14);
    expect(new Date(s.dueMs).getUTCMinutes()).toBe(30);
  });
});

describe("parseScheduleFor (m7 recipe-3: timing-only + supplied task)", () => {
  it("attaches the recipe task to a daily clause", () => {
    const s = parseScheduleFor("every morning", "check the price of bitcoin", NOW)!;
    expect(s.kind).toBe("daily");
    expect(s.hourMin).toBe("09:00");
    expect(s.task).toBe("check the price of bitcoin");
  });
  it("attaches to a relative clause", () => {
    const s = parseScheduleFor("in 5 min", "top HN", NOW)!;
    expect(s.kind).toBe("once");
    expect(s.dueMs - NOW).toBe(5 * MIN);
    expect(s.task).toBe("top HN");
  });
  it("null on an unparseable clause or empty task", () => {
    expect(parseScheduleFor("whenever", "x", NOW)).toBeNull();
    expect(parseScheduleFor("every morning", "  ", NOW)).toBeNull();
  });
});

describe("splitScheduleCommand (DEV-0129: name<->clause split keeps interior time words)", () => {
  it("single-word name", () => {
    expect(splitScheduleCommand("schedule digest daily", NOW)).toEqual({ name: "digest", clause: "daily", explicitRecipe: false });
  });
  it("name whose 2nd token is a time keyword is NOT truncated (the bug)", () => {
    // old lazy regex gave name="check", clause="in every morning"; now the longest clean split wins.
    expect(splitScheduleCommand("schedule check in every morning", NOW)).toEqual({ name: "check in", clause: "every morning", explicitRecipe: false });
    expect(splitScheduleCommand("schedule log in at 5pm", NOW)).toEqual({ name: "log in", clause: "at 5pm", explicitRecipe: false });
  });
  it("multi-word name + relative clause", () => {
    expect(splitScheduleCommand("schedule my news brief in 2 hours", NOW)).toEqual({ name: "my news brief", clause: "in 2 hours", explicitRecipe: false });
  });
  it("null when nothing after the name parses as a time clause", () => {
    expect(splitScheduleCommand("schedule check in whenever", NOW)).toBeNull();
    expect(splitScheduleCommand("schedule report", NOW)).toBeNull();
  });
  it("not a schedule command -> null", () => {
    expect(splitScheduleCommand("run digest", NOW)).toBeNull();
  });
  it("DEV-0131: strips the explicit 'recipe' keyword and flags it, keeping name+clause intact", () => {
    expect(splitScheduleCommand("schedule recipe brief every morning", NOW)).toEqual({ name: "brief", clause: "every morning", explicitRecipe: true });
    // a recipe named with an interior time word still works under the keyword form.
    expect(splitScheduleCommand("schedule recipe check in at 5pm", NOW)).toEqual({ name: "check in", clause: "at 5pm", explicitRecipe: true });
  });
});

describe("parseSchedule — daily", () => {
  it("every morning -> daily at 09:00", () => {
    const s = parseSchedule("every morning tell me the weather", NOW)!;
    expect(s.kind).toBe("daily");
    expect(s.hourMin).toBe("09:00");
    expect(s.task).toMatch(/weather/);
    expect(s.dueMs).toBeGreaterThan(NOW); // next occurrence in the future
  });

  it("daily at an explicit time", () => {
    const s = parseSchedule("every day at 8pm summarize my emails", NOW)!;
    expect(s.kind).toBe("daily");
    expect(s.hourMin).toBe("20:00");
    expect(s.task).toMatch(/summarize my emails/);
  });
  it("captures a time placed AFTER the task, not just after the cadence word (recurring-time-after-task)", () => {
    const s = parseSchedule("remind me every day to take my meds at 8pm", NOW)!;
    expect(s.kind).toBe("daily");
    expect(s.hourMin).toBe("20:00");        // NOT the 9am default
    expect(s.task).toBe("to take my meds"); // "at 8pm" stripped, not left dangling
    const w = parseSchedule("every monday to submit the report at 9am", NOW)!;
    expect(w.kind).toBe("weekly");
    expect(w.hourMin).toBe("09:00");
    expect(w.task).toBe("to submit the report");
  });
  it("a word-default daily with no time anywhere still uses the morning/evening default", () => {
    expect(parseSchedule("every morning tell me the weather", NOW)!.hourMin).toBe("09:00");
    expect(parseSchedule("every evening summarize my day", NOW)!.hourMin).toBe("18:00");
  });

  it("an explicit offset stamps offsetMin + shifts dueMs into that zone (tz-from-location)", () => {
    // "every morning" == 09:00 local; with offsetMin=-300 (Eastern) that's 14:00 UTC.
    const s = parseSchedule("every morning tell me the weather", NOW, -300)!;
    expect(s.offsetMin).toBe(-300);
    expect(new Date(s.dueMs).getUTCHours()).toBe(14);
  });
});

describe("nextDailyMs — timezone offset (tz-daily fix)", () => {
  it("fires at the wall-clock hour in the user's zone, not the server's", async () => {
    const { nextDailyMs } = await import("../src/lib/schedule.js");
    const now = Date.UTC(2026, 0, 1, 0, 0, 0); // midnight UTC
    // UTC user: next 9am is 9:00 UTC the same day.
    expect(new Date(nextDailyMs(now, 9, 0, 0)).getUTCHours()).toBe(9);
    // US-Eastern (UTC-5, offset -300): their 9am local == 14:00 UTC.
    expect(new Date(nextDailyMs(now, 9, 0, -300)).getUTCHours()).toBe(14);
    // CET (UTC+1, offset +60): their 9am local == 08:00 UTC.
    expect(new Date(nextDailyMs(now, 9, 0, 60)).getUTCHours()).toBe(8);
  });
  it("rolls to tomorrow when the time already passed today (in-zone)", async () => {
    const { nextDailyMs } = await import("../src/lib/schedule.js");
    const now = Date.UTC(2026, 0, 1, 10, 0, 0); // 10:00 UTC
    const t = nextDailyMs(now, 9, 0, 0); // 9am UTC already passed -> tomorrow
    expect(t).toBeGreaterThan(now);
    expect(new Date(t).getUTCDate()).toBe(2);
    expect(new Date(t).getUTCHours()).toBe(9);
  });
});

describe("parseSchedule — recurring (weekly / interval)", () => {
  it("'every 2 hours' -> interval", () => {
    const s = parseSchedule("every 2 hours check the site", NOW)!;
    expect(s.kind).toBe("interval");
    expect(s.intervalMs).toBe(2 * 60 * 60 * 1000);
    expect(s.dueMs).toBe(NOW + 2 * 60 * 60 * 1000);
    expect(s.task).toMatch(/check the site/);
  });
  it("'every 30 min' -> interval", () => {
    const s = parseSchedule("every 30 min ping me the price", NOW)!;
    expect(s.kind).toBe("interval");
    expect(s.intervalMs).toBe(30 * 60 * 1000);
  });
  it("'every 2 days' -> interval (multi-day gap, was a silent no-op)", () => {
    const s = parseSchedule("every 2 days water the plants", NOW)!;
    expect(s.kind).toBe("interval");
    expect(s.intervalMs).toBe(2 * DAY);
    expect(s.dueMs).toBe(NOW + 2 * DAY);
    expect(s.task).toMatch(/water the plants/);
  });
  it("'every 1 week' + 'every other week' -> interval (weekly gap / every 2 weeks)", () => {
    expect(parseSchedule("every 1 week review the budget", NOW)!.intervalMs).toBe(7 * DAY);
    const other = parseSchedule("every other week send the newsletter", NOW)!;
    expect(other.kind).toBe("interval");
    expect(other.intervalMs).toBe(14 * DAY);
  });
  it("'in 3 weeks' -> once, 21 days out (was unparseable -> silent one-shot browse)", () => {
    const s = parseSchedule("remind me to renew the lease in 3 weeks", NOW)!;
    expect(s.kind).toBe("once");
    expect(s.dueMs - NOW).toBe(21 * DAY);
    expect(s.task).toMatch(/renew the lease/);
  });
  it("'every monday at 9am' -> weekly on [Mon]", () => {
    const s = parseSchedule("every monday at 9am send the report", NOW)!;
    expect(s.kind).toBe("weekly");
    expect(s.weekdays).toEqual([1]);
    expect(s.hourMin).toBe("09:00");
    expect(new Date(s.dueMs).getUTCDay()).toBe(1); // lands on a Monday (UTC offset 0 in test)
  });
  it("'every weekday at 8' -> weekly Mon-Fri", () => {
    const s = parseSchedule("every weekday at 8 remind me to stand up", NOW)!;
    expect(s.kind).toBe("weekly");
    expect(s.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(s.hourMin).toBe("08:00");
  });
  it("'weekends at 10am' -> weekly Sat+Sun", () => {
    const s = parseSchedule("weekends at 10am brunch spots near me", NOW)!;
    expect(s.kind).toBe("weekly");
    expect(s.weekdays).toEqual([0, 6]);
  });
  it("a bare weekday inside a task is NOT a weekly schedule", () => {
    expect(parseSchedule("email bob the monday report", NOW)).toBeNull();
  });
  it("a SINGLE weekday + time with no 'every' is a ONE-SHOT, not recurring (weekly-single-weekday-once)", () => {
    const s = parseSchedule("remind me Friday at 3pm to submit taxes", NOW)!;
    expect(s.kind).toBe("once");                 // NOT weekly — must not ping every Friday forever
    expect(s.weekdays).toBeUndefined();
    expect(new Date(s.dueMs).getUTCDay()).toBe(5); // lands on a Friday
    expect(s.task).toMatch(/submit taxes/);
  });
  it("'every friday at 3pm' stays recurring weekly", () => {
    const s = parseSchedule("every friday at 3pm submit the report", NOW)!;
    expect(s.kind).toBe("weekly");
    expect(s.weekdays).toEqual([5]);
  });
  it("multiple named days (no 'every') is still recurring weekly", () => {
    const s = parseSchedule("mon and thu at 8am standup", NOW)!;
    expect(s.kind).toBe("weekly");
    expect(s.weekdays).toEqual([1, 4]);
  });
  it("a PLURAL weekday ('mondays at 9am') is recurring weekly, not a one-shot (plural-weekday-recurring)", () => {
    const s = parseSchedule("remind me mondays at 9am to submit the timesheet", NOW)!;
    expect(s.kind).toBe("weekly");           // NOT once — 'mondays' plural signals repetition
    expect(s.weekdays).toEqual([1]);
    const f = parseSchedule("fridays at 5pm water the plants", NOW)!;
    expect(f.kind).toBe("weekly");
    expect(f.weekdays).toEqual([5]);
  });
  it("the SINGULAR weekday one-shot still holds ('monday at 9am' -> once)", () => {
    const s = parseSchedule("remind me monday at 9am to submit taxes", NOW)!;
    expect(s.kind).toBe("once");             // regression guard: single-weekday-once unaffected
  });
});

describe("parseSchedule — absolute calendar date (absolute-date-reminders)", () => {
  const JUN1 = new Date("2024-06-01T12:00:00Z").getTime(); // a Saturday
  it("'next Monday' -> once on the next Monday (9am default), 'next' stripped from task", () => {
    const s = parseSchedule("remind me next Monday to call the vet", JUN1, 0)!;
    expect(s.kind).toBe("once");
    expect(new Date(s.dueMs).getUTCDay()).toBe(1);       // Monday
    expect(new Date(s.dueMs).getUTCHours()).toBe(9);
    expect(s.task).toBe("to call the vet");              // no leftover "next"
  });
  it("'on March 5' -> that calendar day; rolls to next year when it already passed", () => {
    const s = parseSchedule("remind me on March 5 to renew the lease", JUN1, 0)!; // March past in June
    expect(new Date(s.dueMs).getUTCFullYear()).toBe(2025);
    expect(new Date(s.dueMs).getUTCMonth()).toBe(2);     // March
    expect(new Date(s.dueMs).getUTCDate()).toBe(5);
    expect(s.task).toMatch(/renew the lease/);
  });
  it("'on Dec 25' this year (still upcoming) + 'on the 15th' this month", () => {
    expect(new Date(parseSchedule("remind me on Dec 25 to call mom", JUN1, 0)!.dueMs).getUTCFullYear()).toBe(2024);
    const dom = parseSchedule("remind me on the 15th to pay rent", JUN1, 0)!;
    expect(new Date(dom.dueMs).getUTCDate()).toBe(15);
    expect(new Date(dom.dueMs).getUTCMonth()).toBe(5);   // June (15th still upcoming)
  });
  it("a stated 'at <time>' sets the hour on a dated reminder", () => {
    const s = parseSchedule("remind me on March 5 at 2pm to renew", JUN1, 0)!;
    expect(new Date(s.dueMs).getUTCHours()).toBe(14);
  });
  it("a month name with no day is NOT a date reminder (no hijack)", () => {
    expect(parseSchedule("email bob the march report", JUN1, 0)).toBeNull();
  });
  it("a month-PREFIX word ('mark 5', 'separate 3', 'junk 4', 'may 6 people') is NOT hijacked into a date (month-word-prefix-collision)", () => {
    expect(parseSchedule("separate 3 files", JUN1, 0)).toBeNull();
    expect(parseSchedule("mark 5 emails as read", JUN1, 0)).toBeNull();
    expect(parseSchedule("junk 4 tabs", JUN1, 0)).toBeNull();
    expect(parseSchedule("may 6 people are coming", JUN1, 0)).toBeNull(); // bare 'may N' isn't a date
    expect(parseSchedule("remind me on may 6 to call", JUN1, 0)!.kind).toBe("once"); // but 'on may 6' is
  });
  it("'next month' is NOT parsed as 'next Monday' (next-month-not-monday)", () => {
    // 'next month' should fall through (no monthly recurrence yet), NOT fire ~3 weeks early on a Monday.
    const p = parseSchedule("remind me next month to pay rent", JUN1, 0);
    expect(p === null || p.kind !== "once" || new Date(p.dueMs).getUTCDay() !== 1).toBe(true);
  });
  it("'set an alarm for N minutes' is NOT a clock-hour alarm (alarm-duration-not-hour)", () => {
    // 'alarm for 20 minutes' must NOT become an 8pm alarm; it falls through (a timer, no 'in') -> not 20:00.
    const p = parseSchedule("set an alarm for 20 minutes", JUN1, 0);
    expect(p === null || new Date(p.dueMs).getUTCHours() !== 20).toBe(true);
  });
  it("an alarm keeps the user's purpose as the task (alarm-drops-task)", () => {
    const s = parseSchedule("set an alarm for 6am to leave for the airport", JUN1, 0)!;
    expect(new Date(s.dueMs).getUTCHours()).toBe(6);
    expect(s.task).toMatch(/leave for the airport/);
    expect(parseSchedule("wake me at 7", JUN1, 0)!.task).toBe("wake up"); // bare alarm still 'wake up'
  });
});

describe("parseSchedule — absolute", () => {
  it("tomorrow at 9am -> once, >= ~1 day out", () => {
    const s = parseSchedule("tomorrow at 9am check the deploy", NOW)!;
    expect(s.kind).toBe("once");
    expect(s.dueMs - NOW).toBeGreaterThan(0);
    expect(s.task).toMatch(/deploy/);
  });
  it("'tomorrow at 9am' lands on the CALENDAR next day, not two days out, when 9am already passed today (tomorrow-off-by-a-day)", () => {
    // NOW = Tue 22:13 UTC. Tomorrow (Wed) 09:00 UTC is ~10.75h away; the old double-+DAY made it ~34h.
    const s = parseSchedule("tomorrow at 9am check the deploy", NOW, 0)!;
    const d = new Date(s.dueMs);
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCDate()).toBe(new Date(NOW).getUTCDate() + 1); // exactly the next calendar day
    expect(s.dueMs - NOW).toBeLessThan(24 * 3600_000);           // < 1 day out, not ~2
  });
  it("'tomorrow at 09:00' (24h form) also lands on the next calendar day", () => {
    const s = parseSchedule("tomorrow at 09:00 send it", NOW, 0)!;
    const d = new Date(s.dueMs);
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCDate()).toBe(new Date(NOW).getUTCDate() + 1);
  });
  it("'tomorrow at 11pm' when 11pm is still ahead today still means tomorrow (not tonight)", () => {
    // NOW 22:13; 23:00 is ahead today. "tomorrow" must still push to the next day, not fire tonight.
    const s = parseSchedule("tomorrow at 11pm wind down", NOW, 0)!;
    const d = new Date(s.dueMs);
    expect(d.getUTCHours()).toBe(23);
    expect(d.getUTCDate()).toBe(new Date(NOW).getUTCDate() + 1);
  });
  it("a bare number is NOT a schedule (needs tomorrow/am-pm)", () => {
    expect(parseSchedule("get me 5 links about cats", NOW)).toBeNull();
  });
});

function tmpFile() { const d = mkdtempSync(join(tmpdir(), "relay-sched-")); dirs.push(d); return join(d, "sched.json"); }
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("ScheduleStore.lastSaveOk (persist-bool-all-stores)", () => {
  it("reports success after a normal add", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "once", task: "meds", dueMs: NOW + 60 * MIN, offsetMin: 0 }, NOW);
    expect(s.lastSaveOk()).toBe(true);
  });
  it("reports failure when the store file can't be written", () => {
    // A path whose parent is a FILE can't be written -> persist returns false -> lastSaveOk false.
    const { writeFileSync } = require("fs");
    const d = mkdtempSync(join(tmpdir(), "relay-sfail-")); dirs.push(d);
    const asFile = join(d, "afile"); writeFileSync(asFile, "x");
    const s = new ScheduleStore({ file: join(asFile, "cant.json") });
    s.add(1, { kind: "once", task: "meds", dueMs: NOW + 60 * MIN, offsetMin: 0 }, NOW);
    expect(s.lastSaveOk()).toBe(false);
  });
});

describe("ScheduleStore.restampTz (tz-restamp-on-setlocation)", () => {
  it("re-stamps daily/weekly to the new tz + recomputes dueMs; skips interval/once; returns the count", async () => {
    const { nextDailyMs } = await import("../src/lib/schedule.js");
    const s = new ScheduleStore({ file: tmpFile() });
    // Created with the default (UTC=0) offset because no tz was set yet.
    const daily = s.add(1, { kind: "daily", task: "meds", dueMs: NOW, hourMin: "08:00", offsetMin: 0 }, NOW)!;
    const weekly = s.add(1, { kind: "weekly", task: "report", dueMs: NOW, hourMin: "09:00", offsetMin: 0, weekdays: [1] }, NOW)!;
    const interval = s.add(1, { kind: "interval", task: "poll", dueMs: NOW + 5 * MIN, intervalMs: 2 * 60 * MIN }, NOW)!;
    const once = s.add(1, { kind: "once", task: "call", dueMs: NOW + 60 * MIN, offsetMin: 0 }, NOW)!;

    const moved = s.restampTz(1, -300, NOW); // user sets UTC-5
    expect(moved).toBe(2); // daily + weekly only

    const d = s.list(1).find((x) => x.id === daily.id)!;
    expect(d.offsetMin).toBe(-300);
    expect(d.dueMs).toBe(nextDailyMs(NOW, 8, 0, -300)); // 8am at UTC-5, not UTC
    const w = s.list(1).find((x) => x.id === weekly.id)!;
    expect(w.offsetMin).toBe(-300);
    // interval + once untouched.
    expect(s.list(1).find((x) => x.id === interval.id)!.offsetMin).toBeUndefined();
    expect(s.list(1).find((x) => x.id === once.id)!.dueMs).toBe(NOW + 60 * MIN);
  });

  it("restamps a FUTURE clock-time once, preserving its wall-clock hour + day (once-reminder-tz-restamp)", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    // "remind me tomorrow at 8am" set at UTC (offset 0): dueMs is 8am UTC tomorrow.
    const eightAmUtc = s.add(1, { kind: "once", task: "meds", dueMs: NOW + 30 * 60 * MIN, offsetMin: 0, clockTime: true }, NOW)!;
    const before = eightAmUtc.dueMs;
    const moved = s.restampTz(1, -300, NOW); // user sets UTC-5
    expect(moved).toBe(1); // the clock-time once IS restamped now
    const r = s.list(1).find((x) => x.id === eightAmUtc.id)!;
    expect(r.offsetMin).toBe(-300);
    // local = UTC + offset; to hold 8am local as offset goes 0 -> -300, UTC moves +300min LATER.
    expect(r.dueMs).toBe(before + 300 * MIN);
  });

  it("leaves a RELATIVE once (no clockTime) and a PAST clock-time once alone", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    const rel = s.add(1, { kind: "once", task: "in 3h", dueMs: NOW + 3 * 60 * MIN, offsetMin: 0 }, NOW)!; // no clockTime
    const past = s.add(1, { kind: "once", task: "old", dueMs: NOW - 60 * MIN, offsetMin: 0, clockTime: true }, NOW)!;
    const moved = s.restampTz(1, -300, NOW);
    expect(moved).toBe(0);
    expect(s.list(1).find((x) => x.id === rel.id)!.dueMs).toBe(NOW + 3 * 60 * MIN);
    expect(s.list(1).find((x) => x.id === past.id)!.dueMs).toBe(NOW - 60 * MIN);
  });

  it("is a no-op (returns 0) when the offset already matches", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "daily", task: "x", dueMs: NOW, hourMin: "08:00", offsetMin: -300 }, NOW);
    expect(s.restampTz(1, -300, NOW)).toBe(0);
  });

  it("only touches the given chat's schedules", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "daily", task: "a", dueMs: NOW, hourMin: "08:00", offsetMin: 0 }, NOW);
    s.add(2, { kind: "daily", task: "b", dueMs: NOW, hourMin: "08:00", offsetMin: 0 }, NOW);
    expect(s.restampTz(1, 60, NOW)).toBe(1);
    expect(s.list(2)[0]!.offsetMin).toBe(0); // chat 2 untouched
  });
});

describe("ScheduleStore", () => {
  it("add/list/dueNow/complete for a once task", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    const rec = s.add(1, { kind: "once", task: "stretch", dueMs: NOW + 10 * MIN }, NOW)!;
    expect(rec.id).toBeTruthy();
    expect(s.list(1)).toHaveLength(1);
    expect(s.dueNow(NOW)).toHaveLength(0);              // not due yet
    expect(s.dueNow(NOW + 11 * MIN)).toHaveLength(1);   // now due
    s.complete(rec.id, NOW + 11 * MIN);
    expect(s.list(1)).toHaveLength(0);                  // once -> removed
  });

  it("a daily task reschedules to the next day on complete", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    const rec = s.add(1, { kind: "daily", task: "weather", dueMs: NOW + HR, hourMin: "09:00" }, NOW)!;
    s.complete(rec.id, NOW + 2 * HR);   // fired
    const after = s.list(1);
    expect(after).toHaveLength(1);       // still there
    expect(after[0]!.dueMs).toBeGreaterThan(NOW + 2 * HR); // moved forward
  });

  it("a daily reschedules in the chat's stored timezone, not the global default (tz-from-location)", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    // offsetMin=-300 (US-Eastern): "09:00" local == 14:00 UTC. On complete, next dueMs must land at 14:00 UTC.
    const rec = s.add(1, { kind: "daily", task: "weather", dueMs: NOW + HR, hourMin: "09:00", offsetMin: -300 }, NOW)!;
    expect(rec.offsetMin).toBe(-300); // carried onto the stored record
    s.complete(rec.id, NOW + 2 * HR);
    expect(new Date(s.list(1)[0]!.dueMs).getUTCHours()).toBe(14);
  });

  it("an interval task reschedules forward by whole intervals on complete", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    const rec = s.add(1, { kind: "interval", task: "ping", dueMs: NOW, intervalMs: HR }, NOW)!;
    s.complete(rec.id, NOW + 90 * MIN); // fired 1.5h later
    const after = s.list(1)[0]!;
    expect(after).toBeTruthy();
    expect(after.dueMs).toBeGreaterThan(NOW + 90 * MIN); // moved past now, not a backlog burst
    expect((after.dueMs - NOW) % HR).toBe(0);            // still on the hourly grid
  });
  it("a weekly task reschedules to the next matching weekday on complete", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    const rec = s.add(1, { kind: "weekly", task: "report", dueMs: NOW, hourMin: "09:00", weekdays: [1] }, NOW)!;
    s.complete(rec.id, NOW + MIN);
    const after = s.list(1)[0]!;
    expect(after).toBeTruthy();
    expect(after.dueMs).toBeGreaterThan(NOW);
    expect(new Date(after.dueMs).getUTCDay()).toBe(1); // next Monday
  });

  it("quietUntilMs: inside the overnight window -> next end boundary; outside -> 0 (quiet-hours)", () => {
    // NOW = Tue 22:13 UTC. Window 22->7 (offset 0): 22:13 is inside -> defer to Wed 07:00.
    const until = quietUntilMs(NOW, 22, 7, 0);
    expect(until).toBeGreaterThan(NOW);
    const d = new Date(until);
    expect(d.getUTCHours()).toBe(7);
    expect(d.getUTCDate()).toBe(new Date(NOW).getUTCDate() + 1); // tomorrow 7am
    // A daytime window (9->17) at 22:13 UTC -> not inside -> 0 (send now).
    expect(quietUntilMs(NOW, 9, 17, 0)).toBe(0);
    // Disabled when start===end.
    expect(quietUntilMs(NOW, 0, 0, 0)).toBe(0);
  });

  it("deferTo moves a schedule's next fire forward only (quiet-hours)", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    const r = s.add(1, { kind: "daily", task: "x", dueMs: NOW, hourMin: "09:00" }, NOW)!;
    expect(s.deferTo(r.id, NOW + HR)).toBe(true);
    expect(s.list(1)[0]!.dueMs).toBe(NOW + HR);
    expect(s.deferTo(r.id, NOW)).toBe(false); // never earlier
    expect(s.deferTo("nope", NOW + 999)).toBe(false); // unknown id
  });

  it("removeByTask cancels the schedule(s) running a given task, chat-scoped (orphaned-schedule-on-forget)", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "daily", task: "digest:morning", dueMs: NOW, hourMin: "09:00" }, NOW);
    s.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW, hourMin: "09:00" }, NOW);
    s.add(2, { kind: "daily", task: "digest:morning", dueMs: NOW, hourMin: "09:00" }, NOW); // other chat
    expect(s.removeByTask(1, "digest:morning")).toBe(1);
    expect(s.list(1).map((x) => x.task)).toEqual(["alert:btc"]); // only chat 1's digest gone
    expect(s.list(2)).toHaveLength(1);                           // chat 2 untouched
    expect(s.removeByTask(1, "digest:nope")).toBe(0);            // no match -> 0
  });

  it("persists across a reload", () => {
    const file = tmpFile();
    const a = new ScheduleStore({ file });
    a.add(7, { kind: "once", task: "x", dueMs: NOW + MIN }, NOW);
    const b = new ScheduleStore({ file });
    expect(b.list(7)).toHaveLength(1);
  });

  it("remove(id, chatId) scopes to the chat", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    const r = s.add(1, { kind: "once", task: "x", dueMs: NOW + MIN }, NOW)!;
    expect(s.remove(r.id, 999)).toBe(false); // wrong chat
    expect(s.remove(r.id, 1)).toBe(true);
    expect(s.list(1)).toHaveLength(0);
  });

  it("enforces the per-chat cap", () => {
    const s = new ScheduleStore({ file: tmpFile(), maxPerChat: 2 });
    expect(s.add(1, { kind: "once", task: "a", dueMs: NOW + MIN }, NOW)).toBeTruthy();
    expect(s.add(1, { kind: "once", task: "b", dueMs: NOW + MIN }, NOW)).toBeTruthy();
    expect(s.add(1, { kind: "once", task: "c", dueMs: NOW + MIN }, NOW)).toBeNull(); // capped
  });
});

describe("parseSnoozeCommand (snooze-automations)", () => {
  it("parses a timed pause with a duration", () => {
    expect(parseSnoozeCommand("snooze btc 3 days", NOW)).toEqual({ action: "pause", which: "btc", untilMs: NOW + 3 * DAY });
    expect(parseSnoozeCommand("pause btc for 2 hours", NOW)).toEqual({ action: "pause", which: "btc", untilMs: NOW + 2 * HR });
    expect(parseSnoozeCommand("mute my morning digest 1 week", NOW)).toEqual({ action: "pause", which: "morning digest", untilMs: NOW + 7 * DAY });
  });
  it("parses an indefinite pause (no duration -> no untilMs)", () => {
    expect(parseSnoozeCommand("pause btc", NOW)).toEqual({ action: "pause", which: "btc" });
    expect(parseSnoozeCommand("snooze all", NOW)).toEqual({ action: "pause", which: "all" });
  });
  it("parses resume / unpause / unmute", () => {
    expect(parseSnoozeCommand("resume btc", NOW)).toEqual({ action: "resume", which: "btc" });
    expect(parseSnoozeCommand("unpause my morning digest", NOW)).toEqual({ action: "resume", which: "morning digest" });
    expect(parseSnoozeCommand("unmute btc", NOW)).toEqual({ action: "resume", which: "btc" });
  });
  it("returns null for a non-snooze message", () => {
    expect(parseSnoozeCommand("what's the weather", NOW)).toBeNull();
    expect(parseSnoozeCommand("remind me to stretch in 10 min", NOW)).toBeNull();
    expect(parseSnoozeCommand("pause", NOW)).toBeNull(); // no target
  });
  it("a zero/negative duration is rejected, NOT an indefinite pause (snooze-zero-duration-guard)", () => {
    // 'for 0 hours' must not silently freeze btc forever — reject so the caller asks for a positive time.
    expect(parseSnoozeCommand("snooze btc for 0 hours", NOW)).toBeNull();
    expect(parseSnoozeCommand("pause btc 0 days", NOW)).toBeNull();
    // and a positive duration on the same name still parses (the guard is only for <=0).
    expect(parseSnoozeCommand("snooze btc for 2 hours", NOW)).toEqual({ action: "pause", which: "btc", untilMs: NOW + 2 * HR });
  });
});

describe("ScheduleStore pause/resume (snooze-automations)", () => {
  it("pause by task substring sets pausedUntil; the runner skip is now < pausedUntil", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "daily", task: "price of bitcoin", dueMs: NOW + HR, hourMin: "09:00" }, NOW);
    expect(s.pause(1, "bitcoin", NOW + 3 * DAY)).toBe(1);
    expect(s.list(1)[0]!.pausedUntil).toBe(NOW + 3 * DAY);
  });
  it("pause matches an alert:/digest: marker by its name", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW + HR, hourMin: "09:00" }, NOW);
    s.add(1, { kind: "daily", task: "digest:morning brief", dueMs: NOW + HR, hourMin: "07:00" }, NOW);
    expect(s.pause(1, "btc", PAUSE_INDEFINITE)).toBe(1);
    expect(s.pause(1, "morning brief", PAUSE_INDEFINITE)).toBe(1);
    expect(s.list(1).filter((x) => x.pausedUntil !== undefined)).toHaveLength(2);
  });
  it("pause all pauses every schedule for the chat", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "daily", task: "a", dueMs: NOW + HR, hourMin: "09:00" }, NOW);
    s.add(1, { kind: "daily", task: "b", dueMs: NOW + HR, hourMin: "09:00" }, NOW);
    s.add(2, { kind: "daily", task: "c", dueMs: NOW + HR, hourMin: "09:00" }, NOW); // other chat untouched
    expect(s.pause(1, "all", PAUSE_INDEFINITE)).toBe(2);
    expect(s.list(2)[0]!.pausedUntil).toBeUndefined();
  });
  it("an indefinite 'pause all' does NOT freeze a once reminder (pause-all-freezes-once-reminders)", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "daily", task: "weather", dueMs: NOW + HR, hourMin: "09:00" }, NOW);
    s.add(1, { kind: "once", task: "take meds", dueMs: NOW + 3 * HR }, NOW);
    // Only the recurring daily is paused; the one-shot promise stays live.
    expect(s.pause(1, "all", PAUSE_INDEFINITE)).toBe(1);
    const once = s.list(1).find((x) => x.kind === "once")!;
    expect(once.pausedUntil).toBeUndefined(); // NOT frozen forever
    const daily = s.list(1).find((x) => x.kind === "daily")!;
    expect(daily.pausedUntil).toBe(PAUSE_INDEFINITE);
  });
  it("a TIMED snooze of a once reminder IS allowed (it auto-resumes when the window elapses)", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "once", task: "take meds", dueMs: NOW + 3 * HR }, NOW);
    expect(s.pause(1, "all", NOW + DAY)).toBe(1); // timed pause, not indefinite -> once is pausable
    expect(s.list(1)[0]!.pausedUntil).toBe(NOW + DAY);
  });
  it("resume clears the pause + pulls a stale recurring dueMs forward to now", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    const rec = s.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW - HR, hourMin: "09:00" }, NOW)!; // already overdue
    s.pause(1, "btc", NOW + 3 * DAY);
    expect(s.resume(1, "btc", NOW)).toBe(1);
    const after = s.list(1)[0]!;
    expect(after.pausedUntil).toBeUndefined();
    expect(after.dueMs).toBe(NOW); // stale recurring due pulled forward, fires next tick (no backlog storm)
    expect(rec.id).toBeTruthy();
  });
  it("resume matches nothing (count 0) when the name is unknown", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW + HR, hourMin: "09:00" }, NOW);
    expect(s.resume(1, "nonesuch", NOW)).toBe(0);
  });
  it("pause is surgical: a whole-word match wins over an unrelated task that merely contains the word (matchByRef-word-boundary)", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "daily", task: "alert:news", dueMs: NOW + HR, hourMin: "09:00" }, NOW);
    s.add(1, { kind: "once", task: "call about the news story", dueMs: NOW + 2 * HR }, NOW);
    expect(s.pause(1, "news", PAUSE_INDEFINITE)).toBe(1); // only the news watch, not the reminder
    const paused = s.list(1).filter((x) => x.pausedUntil !== undefined);
    expect(paused).toHaveLength(1);
    expect(paused[0]!.task).toBe("alert:news");
  });
  it("an exact label wins over a longer label containing the word", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "daily", task: "digest:news", dueMs: NOW + HR, hourMin: "07:00" }, NOW);
    s.add(1, { kind: "daily", task: "digest:morning news", dueMs: NOW + HR, hourMin: "08:00" }, NOW);
    expect(s.pause(1, "news", PAUSE_INDEFINITE)).toBe(1); // exact "news", not "morning news"
    expect(s.list(1).find((x) => x.task === "digest:news")!.pausedUntil).toBe(PAUSE_INDEFINITE);
    expect(s.list(1).find((x) => x.task === "digest:morning news")!.pausedUntil).toBeUndefined();
  });
  it("still falls back to a substring when nothing matches on a word boundary", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    s.add(1, { kind: "daily", task: "alert:btcusd", dueMs: NOW + HR, hourMin: "09:00" }, NOW);
    expect(s.pause(1, "btc", PAUSE_INDEFINITE)).toBe(1); // no word-boundary hit -> substring fallback
  });

  it("clearExpiredPause clears an elapsed pause, keeps an active one", () => {
    const s = new ScheduleStore({ file: tmpFile() });
    const rec = s.add(1, { kind: "daily", task: "a", dueMs: NOW + HR, hourMin: "09:00" }, NOW)!;
    s.pause(1, "a", NOW + HR);
    expect(s.clearExpiredPause(rec.id, NOW)).toBe(false);          // still active
    expect(s.clearExpiredPause(rec.id, NOW + 2 * HR)).toBe(true);  // elapsed -> cleared
    expect(s.list(1)[0]!.pausedUntil).toBeUndefined();
  });
});
