import { describe, it, expect, afterEach } from "vitest";
import { parseLogCommand, parseLogQuery, sumSeries, LogStore, logsWeeklySummary, isLogRecapMember, parseLogRecapToggle, logRecapProactiveText } from "../src/lib/logs.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-logs-")); dirs.push(d); return join(d, "l.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("parseLogCommand", () => {
  it("parses 'log <tag> <value> [unit]' + 'track'", () => {
    expect(parseLogCommand("log weight 182")).toEqual({ tag: "weight", value: 182 });
    expect(parseLogCommand("log my weight 182 lbs")).toEqual({ tag: "weight", value: 182, unit: "lbs" });
    expect(parseLogCommand("track mood 7")).toEqual({ tag: "mood", value: 7 });
  });
  it("parses the value-first form 'log 3 coffees' / 'track 2000 steps' (quick-log-value-first)", () => {
    // tag is singularized so the WRITE ("log 3 coffees") + READ ("how much coffee") converge (quick-log-tag-plural)
    expect(parseLogCommand("log 3 coffees")).toEqual({ tag: "coffee", value: 3 });
    expect(parseLogCommand("track 2000 steps")).toEqual({ tag: "step", value: 2000 });
    expect(parseLogCommand("record 5 miles")).toEqual({ tag: "mile", value: 5 });
    // tag-first still wins when a word (not a number) follows the verb
    expect(parseLogCommand("log weight 182")).toEqual({ tag: "weight", value: 182 });
  });
  it("parses a money form 'spent $X on <thing>' -> tag=thing, unit=$", () => {
    expect(parseLogCommand("spent $14 on lunch")).toEqual({ tag: "lunch", value: 14, unit: "$" });
    expect(parseLogCommand("paid 9 for parking")).toEqual({ tag: "parking", value: 9, unit: "$" });
  });
  it("parses amounts with thousands commas + a leading 'I' (quick-log-thousands-comma)", () => {
    expect(parseLogCommand("I spent $1,250 on rent")).toEqual({ tag: "rent", value: 1250, unit: "$" });
    expect(parseLogCommand("spent $1,250.50 on rent")).toEqual({ tag: "rent", value: 1250.5, unit: "$" });
    expect(parseLogCommand("i paid 30 for gas")).toEqual({ tag: "gas", value: 30, unit: "$" });
    expect(parseLogCommand("log salary 5,000")).toEqual({ tag: "salary", value: 5000 });
    expect(parseLogCommand("log steps 10,000")).toEqual({ tag: "step", value: 10000 }); // singularized (quick-log-tag-plural)
  });
  it("null when it isn't a log command", () => {
    expect(parseLogCommand("what's the weather")).toBeNull();
    expect(parseLogCommand("log in to my account")).toBeNull(); // no number
    expect(parseLogCommand("independent 5 on x")).toBeNull();   // 'i' prefix needs a word boundary, not 'independent'
  });
});

describe("parseLogQuery", () => {
  it("parses a spend SUM query with a window", () => {
    expect(parseLogQuery("how much did I spend on food this week", NOW)).toEqual({ tag: "food", mode: "sum", sinceMs: NOW - 7 * DAY });
    expect(parseLogQuery("how much have i spent on lunch", NOW)).toEqual({ tag: "lunch", mode: "sum" });
  });
  it("parses a trend query with a window", () => {
    expect(parseLogQuery("show my weight this month", NOW)).toEqual({ tag: "weight", mode: "trend", sinceMs: NOW - 30 * DAY });
    expect(parseLogQuery("my mood trend", NOW)).toEqual({ tag: "mood", mode: "trend" });
  });
  it("parses a non-spend COUNT sum ('how much coffee', 'how many steps') — the read side of value-first logging (quick-log-count-query)", () => {
    expect(parseLogQuery("how much coffee this week", NOW)).toEqual({ tag: "coffee", mode: "sum", sinceMs: NOW - 7 * DAY });
    expect(parseLogQuery("how many coffees have I had", NOW)).toEqual({ tag: "coffee", mode: "sum" }); // plural converges
    expect(parseLogQuery("how many steps today", NOW)).toEqual({ tag: "step", mode: "sum", sinceMs: NOW - DAY });
  });
  it("write + read tags converge via singularization (quick-log-tag-plural)", () => {
    // "log 3 coffees" stores tag "coffee"; "how much coffee" reads tag "coffee" — same series.
    expect(parseLogCommand("log 3 coffees")!.tag).toBe(parseLogQuery("how much coffee this week", NOW)!.tag);
  });
  it("null when it isn't a log query", () => {
    expect(parseLogQuery("what's the weather", NOW)).toBeNull();
  });
});

describe("LogStore", () => {
  it("appends points per tag, reads them back, persists, tracks unit", () => {
    const f = tmp();
    const s = new LogStore({ file: f });
    s.add(1, "weight", 182, NOW);
    s.add(1, "weight", 181, NOW + DAY);
    expect(s.seriesOf(1, "weight")).toEqual([{ t: NOW, v: 182 }, { t: NOW + DAY, v: 181 }]);
    s.add(1, "lunch", 14, NOW, "$");
    expect(s.unitOf(1, "lunch")).toBe("$");
    expect(s.tags(1).sort()).toEqual(["lunch", "weight"]);
    // survives a reload
    expect(new LogStore({ file: f }).seriesOf(1, "weight")).toHaveLength(2);
  });
  it("is per-chat", () => {
    const s = new LogStore({ file: tmp() });
    s.add(1, "weight", 182, NOW);
    expect(s.seriesOf(2, "weight")).toEqual([]);
  });
});

describe("sumSeries", () => {
  it("sums values, windowed", () => {
    const pts = [{ t: NOW - 10 * DAY, v: 20 }, { t: NOW - 2 * DAY, v: 14 }, { t: NOW, v: 9 }];
    expect(sumSeries(pts)).toEqual({ total: 43, count: 3 });
    expect(sumSeries(pts, NOW - 7 * DAY)).toEqual({ total: 23, count: 2 }); // last 7 days
  });
});

describe("logsWeeklySummary (logs-weekly-summary)", () => {
  it("recaps each tag: $ sums, a metric trends, a bare count shows its value", () => {
    const series = [
      { tag: "weight", points: [{ t: NOW - 6 * DAY, v: 182 }, { t: NOW - 1 * DAY, v: 180 }] },
      { tag: "food", unit: "$", points: [{ t: NOW - 5 * DAY, v: 14 }, { t: NOW - 2 * DAY, v: 22 }, { t: NOW - 1 * DAY, v: 9 }] },
      { tag: "coffees", points: [{ t: NOW - 3 * DAY, v: 2 }] },
    ];
    const out = logsWeeklySummary(series, NOW)!;
    expect(out).toMatch(/this week you logged:/);
    expect(out).toMatch(/weight 182→180 ↓2/);
    expect(out).toMatch(/spent \$45 on food \(3x\)/);
    expect(out).toMatch(/coffees 2/);
  });
  it("excludes points outside the window; null when nothing logged this week", () => {
    expect(logsWeeklySummary([{ tag: "old", points: [{ t: NOW - 30 * DAY, v: 5 }] }], NOW)).toBeNull();
  });
  it("isLogRecapMember matches the reserved names, not an arbitrary tag", () => {
    expect(isLogRecapMember("my logs")).toBe(true);
    expect(isLogRecapMember("Trackers")).toBe(true);
    expect(isLogRecapMember("weather")).toBe(false);
  });
});

describe("logRecapProactiveText (log-recap-empty-guidance)", () => {
  const withData = [{ tag: "weight", points: [{ t: NOW - 2 * DAY, v: 182 }, { t: NOW - 1 * DAY, v: 180 }] }];
  it("returns the recap when something was logged this week", () => {
    const r = logRecapProactiveText(withData, false, NOW)!;
    expect(r.text).toMatch(/Your week in numbers/);
    expect(r.nudgedEmpty).toBeUndefined();
  });
  it("nudges a NEVER-logged subscriber once (empty store, not yet nudged)", () => {
    const r = logRecapProactiveText([], false, NOW)!;
    expect(r.text).toMatch(/haven't logged anything yet/i);
    expect(r.text).toMatch(/log weight 182/);
    expect(r.nudgedEmpty).toBe(true);
  });
  it("stays silent for a never-logged subscriber already nudged (no weekly repeat)", () => {
    expect(logRecapProactiveText([], true, NOW)).toBeNull();
  });
  it("stays silent for a logged-before user having a quiet week (not empty store)", () => {
    const stale = [{ tag: "weight", points: [{ t: NOW - 30 * DAY, v: 200 }] }]; // logged before, nothing recent
    expect(logRecapProactiveText(stale, false, NOW)).toBeNull();
  });
});

describe("parseLogRecapToggle (logs-recap-nudge-or-standalone)", () => {
  it("parses ON phrasings", () => {
    expect(parseLogRecapToggle("recap my logs weekly")).toEqual({ on: true });
    expect(parseLogRecapToggle("weekly log recap")).toEqual({ on: true });
    expect(parseLogRecapToggle("send me my stats weekly")).toEqual({ on: true });
    expect(parseLogRecapToggle("weekly logs recap")).toEqual({ on: true });
  });
  it("parses OFF phrasings", () => {
    expect(parseLogRecapToggle("stop log recaps")).toEqual({ on: false });
    expect(parseLogRecapToggle("turn off weekly logs")).toEqual({ on: false });
    expect(parseLogRecapToggle("stop recapping my logs")).toEqual({ on: false });
  });
  it("does NOT hijack a real log command or query", () => {
    expect(parseLogRecapToggle("log weight 182")).toBeNull();
    expect(parseLogRecapToggle("show my weight this month")).toBeNull();
    expect(parseLogRecapToggle("how much did I spend on food")).toBeNull();
  });
});
