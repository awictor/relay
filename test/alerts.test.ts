import { describe, it, expect, afterEach } from "vitest";
import { parseAlertCommand, parseAlertEdit, changed, normalizeForCompare, firstNumber, extractValue, conditionHolds, extractListItems, feedItemKey, parseTrendRequest, summarizeSeries, AlertStore } from "../src/lib/alerts.js";
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
  it("does NOT confirm in_stock from a cross-sell product's Buy CTA (in-stock-cta-scoping)", () => {
    // Watched item is sold out; a RELATED product below it has an "Add to cart" button.
    expect(conditionHolds({ op: "in_stock" }, "This item is currently unavailable. You may also like: Acme X — Add to cart")).toBe(false);
    // No out-of-stock line, but the only purchase CTA belongs to a "Recommended" cross-sell block ->
    // can't confirm the watched item is in stock (hold, don't false-fire a rush-buy ping).
    expect(conditionHolds({ op: "in_stock" }, "Recommended for you: Widget Pro — Buy now")).toBeNull();
  });
  it("a CTA WITHOUT cross-sell framing still confirms in_stock (real product page)", () => {
    expect(conditionHolds({ op: "in_stock" }, "PS5 Console. Add to cart. Free shipping.")).toBe(true);
  });
  it("a strong 'in stock' statement confirms even alongside a recommendations block", () => {
    expect(conditionHolds({ op: "in_stock" }, "PS5 is in stock! Recommended: extra controller — add to cart")).toBe(true);
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
  it("scales magnitude suffixes on currency values (extractvalue-magnitude-suffix)", () => {
    expect(extractValue("BTC is trading at $60k right now")).toBe(60_000);
    expect(extractValue("Bitcoin sits around $1.2M")).toBe(1_200_000);
    expect(extractValue("market cap is $1.3bn")).toBe(1.3e9);
    expect(extractValue("about 65k USD")).toBe(65_000);
    expect(extractValue("valued at $2.5 trillion")).toBe(2.5e12);
    // Regression: a "below 50000" watch must NOT read "$60k" as 60 (it's 60000, above 50000).
    expect(conditionHolds({ op: "below", operand: 50_000 }, "BTC is $60k")).toBe(false);
  });
  it("does NOT treat a bare 'm'/'t' in prose as millions/trillions (untagged branch)", () => {
    expect(extractValue("posted 3m ago, score is 4200")).toBe(4200); // "3m" = 3 min, not 3 million
    expect(extractValue("the reading is 500 units")).toBe(500);
  });

  it("with a hint, picks the number nearest the watched entity, not the largest (extractvalue-largest-magnitude)", () => {
    // "S&P 500 below 5000" watch: reply mentions the bigger Dow number too. Must track the S&P (5900).
    expect(extractValue("The S&P 500 is at 5,900 while the Dow sits at 42,000", "S&P 500 index")).toBe(5900);
    // Same reply, a Dow watch -> track the Dow.
    expect(extractValue("The S&P 500 is at 5,900 while the Dow sits at 42,000", "Dow Jones")).toBe(42_000);
    // Currency-tagged multi-number: hint steers to the watched one.
    expect(extractValue("Nvidia $180, Apple $230", "Apple stock price")).toBe(230);
  });

  it("no hint (or unmatched hint) keeps the largest-magnitude fallback (no regression)", () => {
    expect(extractValue("The S&P 500 is at 5,900 while the Dow sits at 42,000")).toBe(42_000); // largest
    expect(extractValue("S&P 5900, Dow 42000", "gold spot")).toBe(42_000); // hint entity absent -> largest
  });

  it("a below-alert on the S&P fires correctly despite a larger Dow number in the reply (conditionHolds hint)", () => {
    // Without the hint this compared 42,000 and never fired; with it, 5,900 < 6000 -> true.
    expect(conditionHolds({ op: "below", operand: 6000 }, "S&P 500 at 5,900, Dow at 42,000", "S&P 500")).toBe(true);
    expect(conditionHolds({ op: "below", operand: 6000 }, "S&P 500 at 5,900, Dow at 42,000", "Dow")).toBe(false); // Dow 42k not below 6k
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

  it("re-defining an alert's TRIGGER via add() resets the baseline so the new trigger fires (watch-redefine-baseline-reset)", () => {
    const s = new AlertStore({ file: tmpFile() });
    s.add(1, { name: "btc", task: "price of bitcoin", threshold: 1000 }, NOW);
    s.setLast(1, "btc", "$65,000");
    // Re-define as a below-45000 predicate (a real trigger change). Stale $65k must NOT linger, or
    // prevHolds computes from it and an already-below value is suppressed.
    const r = s.add(1, { name: "btc", task: "price of bitcoin", condition: { op: "below", operand: 45000 } }, NOW)!;
    expect(r.condition).toEqual({ op: "below", operand: 45000 });
    expect(r.threshold).toBeUndefined();
    expect(r.lastValue).toBeUndefined(); // baseline cleared -> new predicate edge-evaluates fresh
  });

  it("a no-op re-define (same trigger) PRESERVES the baseline (no needless re-fire)", () => {
    const s = new AlertStore({ file: tmpFile() });
    s.add(1, { name: "btc", task: "price of bitcoin", threshold: 1000 }, NOW);
    s.setLast(1, "btc", "$65,000");
    const r = s.add(1, { name: "btc", task: "price of bitcoin", threshold: 1000 }, NOW)!; // identical
    expect(r.lastValue).toBe("$65,000"); // unchanged trigger -> baseline kept, cumulative drift intact
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

describe("feed-watch (new-item-feed-watch)", () => {
  it("parses a feed watch from a trailing 'for new X' or a leading 'new'", () => {
    expect(parseAlertCommand("watch jobs: remote react roles for new listings")).toEqual({ name: "jobs", task: "remote react roles", feed: true });
    expect(parseAlertCommand("watch ps5: new PS5 restocks")).toEqual({ name: "ps5", task: "new PS5 restocks", feed: true });
  });
  it("a price/stock trigger wins over the feed cue (no false feed)", () => {
    expect(parseAlertCommand("watch btc: new bitcoin price below 50000")).toEqual({ name: "btc", task: "new bitcoin price", condition: { op: "below", operand: 50000 } });
    expect(parseAlertCommand("watch ps5: the PS5 back in stock")).toEqual({ name: "ps5", task: "the PS5", condition: { op: "in_stock" } });
  });
  it("extractListItems strips bullets/numbers + drops lead-ins", () => {
    const reply = "Here are the latest jobs:\n• Senior React dev — Acme\n2. Frontend eng — Beta\n- Staff eng — Gamma\n";
    expect(extractListItems(reply)).toEqual(["Senior React dev — Acme", "Frontend eng — Beta", "Staff eng — Gamma"]);
  });
  it("feedItemKey is stable across phrasing/case/punctuation drift", () => {
    expect(feedItemKey("• Senior React Dev — Acme!")).toBe(feedItemKey("senior react dev acme"));
  });
  it("store records + caps the seen-set, dropping oldest", () => {
    const s = new AlertStore({ file: tmpFile() });
    s.add(1, { name: "jobs", task: "roles", feed: true }, NOW);
    const keys = Array.from({ length: 250 }, (_, i) => `k${i}`);
    s.recordSeen(1, "jobs", keys);
    const a = s.get(1, "jobs")!;
    expect(a.seen).toHaveLength(200);         // capped
    expect(a.seen![0]).toBe("k50");            // oldest 50 dropped
    expect(a.seen![199]).toBe("k249");
  });
  it("switching an alert to/from feed resets its baseline", () => {
    const s = new AlertStore({ file: tmpFile() });
    s.add(1, { name: "x", task: "t" }, NOW);
    s.setLast(1, "x", "old value");
    s.recordSeen(1, "x", ["a"]); // (no-op-ish; it's not feed yet, but seed seen)
    s.add(1, { name: "x", task: "t", feed: true }, NOW); // flip to feed
    const a = s.get(1, "x")!;
    expect(a.feed).toBe(true);
    expect(a.lastValue).toBeUndefined();
    expect(a.seen).toBeUndefined();
  });
});

describe("trigger-to-action (trigger-to-action-alerts)", () => {
  it("parses a trailing 'then run <recipe>' / 'then <recipe>'", () => {
    expect(parseAlertCommand("watch jobs: new remote react roles then run summarize-jobs")).toEqual({ name: "jobs", task: "new remote react roles", feed: true, then: "summarize-jobs" });
    expect(parseAlertCommand("watch btc: bitcoin price below 50000 then buy-alert")).toEqual({ name: "btc", task: "bitcoin price", condition: { op: "below", operand: 50000 }, then: "buy-alert" });
    expect(parseAlertCommand("watch hn: top story then run digest-it")).toEqual({ name: "hn", task: "top story", then: "digest-it" });
  });
  it("no 'then' clause -> no then field", () => {
    expect(parseAlertCommand("watch btc: price of bitcoin")).toEqual({ name: "btc", task: "price of bitcoin", threshold: undefined });
  });
  it("carries a 'then' recipe through a WATCHLIST (watchlist-then-dropped)", () => {
    const r = parseAlertCommand("watch mk: btc price; eth price then run summary")!;
    expect(r.members?.map((m) => m.task)).toEqual(["btc price", "eth price"]); // then-clause stripped off the last member
    expect(r.then).toBe("summary");
  });
  it("store persists + updates the then field", () => {
    const s = new AlertStore({ file: tmpFile() });
    s.add(1, { name: "jobs", task: "roles", feed: true, then: "sum" }, NOW);
    expect(s.get(1, "jobs")!.then).toBe("sum");
    s.add(1, { name: "jobs", task: "roles", feed: true }, NOW); // re-state without then -> cleared
    expect(s.get(1, "jobs")!.then).toBeUndefined();
  });
});

describe("watch time series (watch-time-series)", () => {
  const NOW2 = 1_700_000_000_000;
  const DAY = 86_400_000;
  it("parseTrendRequest extracts name + lookback window", () => {
    expect(parseTrendRequest("how has btc moved this week", NOW2)).toEqual({ name: "btc", sinceMs: NOW2 - 7 * DAY });
    expect(parseTrendRequest("btc trend", NOW2)).toEqual({ name: "btc" });
    expect(parseTrendRequest("history of eth", NOW2)).toEqual({ name: "eth" });
    expect(parseTrendRequest("how is gold doing today", NOW2)).toEqual({ name: "gold", sinceMs: NOW2 - DAY });
    expect(parseTrendRequest("show me the aqi trend", NOW2)).toEqual({ name: "aqi" });
  });
  it("parseTrendRequest null for a non-trend message", () => {
    expect(parseTrendRequest("weather in Paris", NOW2)).toBeNull();
    expect(parseTrendRequest("what's the price of btc", NOW2)).toBeNull();
  });
  it("summarizeSeries renders first→last, delta, min/max; null under 2 points", () => {
    const pts = [{ t: NOW2 - 2 * DAY, v: 100 }, { t: NOW2 - DAY, v: 90 }, { t: NOW2, v: 120 }];
    const s = summarizeSeries(pts, NOW2)!;
    expect(s).toMatch(/100 → 120/);
    expect(s).toMatch(/↑20/);
    expect(s).toMatch(/Low 90, high 120/);
    expect(summarizeSeries([{ t: NOW2, v: 1 }], NOW2)).toBeNull();
  });
  it("summarizeSeries respects the sinceMs window", () => {
    const pts = [{ t: NOW2 - 10 * DAY, v: 500 }, { t: NOW2 - DAY, v: 100 }, { t: NOW2, v: 110 }];
    const s = summarizeSeries(pts, NOW2, NOW2 - 7 * DAY)!; // drops the 10-day-old 500
    expect(s).toMatch(/100 → 110/);
    expect(s).not.toMatch(/500/);
  });
  it("store records points, caps, and only for a found alert", () => {
    const s = new AlertStore({ file: tmpFile() });
    s.add(1, { name: "btc", task: "price" }, NOW);
    for (let i = 0; i < 410; i++) s.recordPoint(1, "btc", i, NOW + i);
    const series = s.seriesOf(1, "btc");
    expect(series).toHaveLength(400);          // capped
    expect(series[0]!.v).toBe(10);              // oldest 10 dropped
    s.recordPoint(1, "nope", 5, NOW);           // unknown alert -> no throw, no store
    expect(s.seriesOf(1, "nope")).toEqual([]);
  });
});

describe("watchlists", () => {
  it("parses a semicolon-separated task into members", () => {
    const p = parseAlertCommand("watch markets: btc price; eth price; gold price")!;
    expect(p.name).toBe("markets");
    expect(p.members!.map((m) => m.task)).toEqual(["btc price", "eth price", "gold price"]);
    expect(p.members!.map((m) => m.label)).toEqual(["btc price", "eth price", "gold price"]);
    expect(p.threshold).toBeUndefined();
    expect(p.condition).toBeUndefined();
  });
  it("disambiguates members that derive the same label (watchlist-member-label-collision)", () => {
    const p = parseAlertCommand("watch tesla: news on tesla model 3; news on tesla model y")!;
    // Both reduce to "news on tesla model" (first 4 words) -> second gets a numeric suffix so labels
    // are unique (setMemberLasts keys on label, so a collision would update the wrong member).
    expect(p.members!.map((m) => m.label)).toEqual(["news on tesla model", "news on tesla model (2)"]);
    expect(new Set(p.members!.map((m) => m.label)).size).toBe(2); // unique
  });
  it("a single task (no semicolon) is NOT a watchlist", () => {
    expect(parseAlertCommand("watch btc: price of bitcoin")!.members).toBeUndefined();
  });
  it("caps members", () => {
    const tasks = Array.from({ length: 12 }, (_, i) => `item ${i}`).join("; ");
    expect(parseAlertCommand(`watch big: ${tasks}`)!.members).toHaveLength(8);
  });
  it("store persists members + setMemberLasts records per-member value, replace preserves last by label", () => {
    const s = new AlertStore({ file: tmpFile() });
    s.add(1, { name: "mk", task: "a; b", members: [{ label: "a", task: "a" }, { label: "b", task: "b" }] }, NOW);
    s.setMemberLasts(1, "mk", [{ label: "a", value: "$1" }, { label: "b", value: "$2" }]);
    expect(s.get(1, "mk")!.members!.find((m) => m.label === "a")!.last).toBe("$1");
    // re-state (same labels) preserves each member's last
    s.add(1, { name: "mk", task: "a; b", members: [{ label: "a", task: "a" }, { label: "b", task: "b" }] }, NOW);
    expect(s.get(1, "mk")!.members!.find((m) => m.label === "a")!.last).toBe("$1");
  });
});
