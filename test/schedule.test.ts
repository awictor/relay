import { describe, it, expect, afterEach } from "vitest";
import { parseSchedule, parseScheduleFor, splitScheduleCommand, ScheduleStore, quietUntilMs } from "../src/lib/schedule.js";
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
    // Info-fetch reminders stay on the agent path (a fetch cue present).
    expect(parseSchedule("remind me to check the weather at 8am", NOW)!.reminderOnly).toBeUndefined();
    expect(parseSchedule("remind me to get me the top HN story in 1 hour", NOW)!.reminderOnly).toBeUndefined();
    // A non-reminder schedule ("in 2 hours check the news") is never reminder-only.
    expect(parseSchedule("in 2 hours check the news", NOW)!.reminderOnly).toBeUndefined();
  });
});

describe("parseSchedule — 24-hour clock (DEV-0189)", () => {
  it("'at HH:MM' 24h time parses to a once-task (the am/pm branch couldn't)", () => {
    const a = parseSchedule("remind me to call the vet at 14:30", NOW)!;
    expect(a).not.toBeNull();
    expect(a.kind).toBe("once");
    expect(a.task).toBe("call the vet");
    // due is the next 14:30 in the configured zone (default UTC) — assert host-independently.
    const d = new Date(a.dueMs);
    expect(d.getUTCHours()).toBe(14);
    expect(d.getUTCMinutes()).toBe(30);
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
