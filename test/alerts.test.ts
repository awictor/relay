import { describe, it, expect, afterEach } from "vitest";
import { parseAlertCommand, changed, firstNumber, AlertStore } from "../src/lib/alerts.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
function tmpFile() { const d = mkdtempSync(join(tmpdir(), "relay-alert-")); dirs.push(d); return join(d, "a.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("parseAlertCommand", () => {
  it("parses 'alert me <name>: <task>' and 'watch <name>: <task>'", () => {
    expect(parseAlertCommand("alert me btc: price of bitcoin")).toEqual({ name: "btc", task: "price of bitcoin", threshold: undefined });
    expect(parseAlertCommand("watch page: check example.com")).toEqual({ name: "page", task: "check example.com", threshold: undefined });
  });
  it("extracts a numeric threshold from a trailing 'by <n>'", () => {
    expect(parseAlertCommand("alert me btc: price of bitcoin when it changes by 1000")).toEqual({ name: "btc", task: "price of bitcoin", threshold: 1000 });
    expect(parseAlertCommand("watch t: temp in NYC by 5")).toEqual({ name: "t", task: "temp in NYC", threshold: 5 });
  });
  it("null without the colon form", () => {
    expect(parseAlertCommand("what's the price")).toBeNull();
    expect(parseAlertCommand("alert me btc:")).toBeNull();
  });
});

describe("firstNumber", () => {
  it("pulls a number through $ and commas", () => {
    expect(firstNumber("$65,000.50")).toBe(65000.5);
    expect(firstNumber("about 21C")).toBe(21);
    expect(firstNumber("no digits")).toBeNull();
  });
});

describe("changed", () => {
  it("text: any non-trivial diff, ignoring surrounding whitespace", () => {
    expect(changed("sunny", "sunny")).toBe(false);
    expect(changed(" sunny ", "sunny")).toBe(false);
    expect(changed("sunny", "rainy")).toBe(true);
  });
  it("with threshold + numeric both sides: only when delta >= threshold", () => {
    expect(changed("$65,000", "$65,200", 1000)).toBe(false); // moved 200 < 1000
    expect(changed("$65,000", "$66,500", 1000)).toBe(true);  // moved 1500 >= 1000
  });
  it("threshold but non-numeric -> falls back to text-diff", () => {
    expect(changed("up", "down", 10)).toBe(true);
  });
});

describe("AlertStore", () => {
  it("add/get/list/setLast/remove; update-in-place cap-exempt", () => {
    const s = new AlertStore({ file: tmpFile(), maxPerChat: 1 });
    s.add(1, { name: "btc", task: "price" }, NOW);
    expect(s.add(1, { name: "eth", task: "price" }, NOW)).toBeNull(); // capped
    s.setLast(1, "btc", "$65k");
    expect(s.get(1, "BTC")!.lastValue).toBe("$65k"); // case-insensitive
    expect(s.add(1, { name: "btc", task: "new price" }, NOW)).toBeTruthy(); // update exempt
    expect(s.remove(1, "btc")).toBe(true);
  });
  it("persists lastValue across reload", () => {
    const file = tmpFile();
    const a = new AlertStore({ file });
    a.add(7, { name: "x", task: "t" }, NOW);
    a.setLast(7, "x", "v1");
    expect(new AlertStore({ file }).get(7, "x")!.lastValue).toBe("v1");
  });
});
