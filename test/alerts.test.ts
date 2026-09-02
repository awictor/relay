import { describe, it, expect, afterEach } from "vitest";
import { parseAlertCommand, changed, firstNumber, extractValue, conditionHolds, AlertStore } from "../src/lib/alerts.js";
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
  it("parses a 'below N' predicate (strips it from the task)", () => {
    expect(parseAlertCommand("watch btc: price of bitcoin below 50000")).toEqual({ name: "btc", task: "price of bitcoin", condition: { op: "below", operand: 50000 } });
    expect(parseAlertCommand("alert me btc: bitcoin price drops below $50,000")).toEqual({ name: "btc", task: "bitcoin price", condition: { op: "below", operand: 50000 } });
  });
  it("parses an 'above N' predicate", () => {
    expect(parseAlertCommand("watch eth: ethereum price above 4000")).toEqual({ name: "eth", task: "ethereum price", condition: { op: "above", operand: 4000 } });
    expect(parseAlertCommand("watch t: temp hits 30")).toEqual({ name: "t", task: "temp", condition: { op: "above", operand: 30 } });
  });
  it("parses a 'back in stock' predicate", () => {
    expect(parseAlertCommand("watch ps5: the PS5 on bestbuy back in stock")).toEqual({ name: "ps5", task: "the PS5 on bestbuy", condition: { op: "in_stock" } });
  });
});

describe("conditionHolds", () => {
  it("below/above compare the extracted value", () => {
    expect(conditionHolds({ op: "below", operand: 50000 }, "BTC is $48,000")).toBe(true);
    expect(conditionHolds({ op: "below", operand: 50000 }, "BTC is $52,000")).toBe(false);
    expect(conditionHolds({ op: "above", operand: 4000 }, "ETH at $4,200")).toBe(true);
  });
  it("in_stock reads stock language", () => {
    expect(conditionHolds({ op: "in_stock" }, "In stock — add to cart")).toBe(true);
    expect(conditionHolds({ op: "in_stock" }, "Sold out")).toBe(false);
  });
  it("null when the value can't be assessed", () => {
    expect(conditionHolds({ op: "below", operand: 50000 }, "no price here")).toBeNull();
    expect(conditionHolds({ op: "in_stock" }, "some page text")).toBeNull();
  });
});

describe("firstNumber", () => {
  it("pulls a number through $ and commas", () => {
    expect(firstNumber("$65,000.50")).toBe(65000.5);
    expect(firstNumber("about 21C")).toBe(21);
    expect(firstNumber("no digits")).toBeNull();
  });
});

describe("extractValue (salient value, not first number)", () => {
  it("prefers a currency-tagged amount over an incidental date/count", () => {
    expect(extractValue("As of 3pm, Bitcoin is $65,000.50 today")).toBe(65000.5);
    expect(extractValue("At 9am the price is 65000 USD")).toBe(65000);
  });
  it("prefers a decimal over an integer date/time", () => {
    expect(extractValue("On the 1st, the rate was 1.085")).toBe(1.085);
  });
  it("falls back to the largest-magnitude number", () => {
    expect(extractValue("3 sources say about 65000")).toBe(65000);
  });
  it("null when there's no number", () => {
    expect(extractValue("out of stock")).toBeNull();
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
  // The core fix: wording drifts run-to-run but the tracked value is identical -> NO false ping.
  it("does NOT fire when prose changed but the salient value is the same", () => {
    expect(changed("Bitcoin is $65,000 as of 3pm.", "BTC sits at $65,000 right now.")).toBe(false);
    expect(changed("The price today is $65,000.", "Currently: $65,000 (updated).")).toBe(false);
  });
  it("DOES fire on a real value move even when wording also changed (no threshold)", () => {
    expect(changed("Bitcoin is $65,000 as of 3pm.", "BTC now $66,120 this evening.")).toBe(true);
  });
  it("ignores an incidental date/count difference when the value is unchanged", () => {
    // first-number would grab the date and false-fire; extractValue tracks the price.
    expect(changed("On the 1st: $500.", "On the 2nd: $500.")).toBe(false);
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
