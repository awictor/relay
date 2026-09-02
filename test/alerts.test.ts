import { describe, it, expect, afterEach } from "vitest";
import { parseAlertCommand, parseAlertEdit, changed, normalizeForCompare, firstNumber, extractValue, conditionHolds, AlertStore } from "../src/lib/alerts.js";
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
  it("ignores a percentage change and tracks the price (extractvalue-percentage-guard)", () => {
    expect(extractValue("BTC up 2.5% at 68000")).toBe(68000);
    expect(extractValue("Down 1.2% to 48,500 today")).toBe(48500);
    expect(extractValue("gained 3% — now $71,200")).toBe(71200); // currency still wins outright
  });
  it("still uses a percent when it's the only number", () => {
    expect(extractValue("interest rate is 4.5%")).toBe(4.5);
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
  // nonnumeric-alert-drift: a NON-numeric watch (e.g. "top HN story") must not fire on phrasing drift.
  it("does NOT fire on pure prose drift of a non-numeric answer", () => {
    expect(changed("As of 3pm, the top story is Apple buys OpenAI.", "Right now the top story is Apple buys OpenAI!")).toBe(false);
    expect(changed("Currently: Sunny and warm", "Today it's sunny and warm.")).toBe(false);
  });
  it("DOES fire when the non-numeric content actually changes", () => {
    expect(changed("The top story is Apple buys OpenAI.", "The top story is Google buys Anthropic.")).toBe(true);
    expect(changed("In stock", "Sold out")).toBe(true);
  });
});

describe("normalizeForCompare", () => {
  it("strips lead-ins, timestamps, punctuation, case, and whitespace", () => {
    expect(normalizeForCompare("As of 3pm, the top story is X.")).toBe(normalizeForCompare("Right now the top story is X!"));
    expect(normalizeForCompare("Sunny   and warm")).toBe("sunny and warm");
  });
  it("keeps genuinely different content distinct", () => {
    expect(normalizeForCompare("Apple wins")).not.toBe(normalizeForCompare("Google wins"));
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
  it("updateTrigger retunes in place, preserving task + lastValue, clearing the other trigger", () => {
    const s = new AlertStore({ file: tmpFile() });
    s.add(1, { name: "btc", task: "price of bitcoin", threshold: 1000 }, NOW);
    s.setLast(1, "btc", "$65k");
    const r = s.updateTrigger(1, "btc", { condition: { op: "below", operand: 45000 } })!;
    expect(r.condition).toEqual({ op: "below", operand: 45000 });
    expect(r.threshold).toBeUndefined();       // mutually exclusive -> cleared
    expect(r.task).toBe("price of bitcoin");   // task preserved
    expect(r.lastValue).toBeUndefined();       // baseline reset so the NEW trigger evaluates fresh (alert-edit-check-now)
    expect(s.updateTrigger(1, "nope", { threshold: 5 })).toBeNull(); // unknown name
  });
});

describe("parseAlertEdit (conversational retune, product-loop)", () => {
  it("parses below/above/in-stock/by edits", () => {
    expect(parseAlertEdit("change btc to below 45000")).toEqual({ name: "btc", condition: { op: "below", operand: 45000 } });
    expect(parseAlertEdit("make btc fire above 70000")).toEqual({ name: "btc", condition: { op: "above", operand: 70000 } });
    expect(parseAlertEdit("update sneakers to back in stock")).toEqual({ name: "sneakers", condition: { op: "in_stock" } });
    expect(parseAlertEdit("set btc to by 500")).toEqual({ name: "btc", threshold: 500 });
    expect(parseAlertEdit("change btc under $200")).toEqual({ name: "btc", condition: { op: "below", operand: 200 } });
  });
  it("returns null for a non-edit / clauseless message", () => {
    expect(parseAlertEdit("change my flight to Tuesday")).toBeNull(); // no trigger clause
    expect(parseAlertEdit("what's the price of btc")).toBeNull();
    expect(parseAlertEdit("watch btc: price of bitcoin below 50000")).toBeNull(); // a define, not an edit
  });
});
