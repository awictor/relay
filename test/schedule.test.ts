import { describe, it, expect, afterEach } from "vitest";
import { parseSchedule, parseScheduleFor, splitScheduleCommand, ScheduleStore } from "../src/lib/schedule.js";
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
});

describe("parseSchedule — absolute", () => {
  it("tomorrow at 9am -> once, >= ~1 day out", () => {
    const s = parseSchedule("tomorrow at 9am check the deploy", NOW)!;
    expect(s.kind).toBe("once");
    expect(s.dueMs - NOW).toBeGreaterThan(0);
    expect(s.task).toMatch(/deploy/);
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
