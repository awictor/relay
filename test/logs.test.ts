import { describe, it, expect, afterEach } from "vitest";
import { parseLogCommand, parseLogQuery, sumSeries, LogStore } from "../src/lib/logs.js";
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
    expect(parseLogCommand("log 3 coffees")).toEqual({ tag: "coffees", value: 3 });
    expect(parseLogCommand("track 2000 steps")).toEqual({ tag: "steps", value: 2000 });
    expect(parseLogCommand("record 5 miles")).toEqual({ tag: "miles", value: 5 });
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
    expect(parseLogCommand("log steps 10,000")).toEqual({ tag: "steps", value: 10000 });
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
