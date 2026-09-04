import { describe, it, expect } from "vitest";
import { parseUnitPrice, compareUnitPrice, formatUnitPrice, runUnitPrice } from "../src/lib/unitprice.js";

describe("parseUnitPrice", () => {
  it("parses '<qty><unit> for $<price>' options split on or/vs", () => {
    expect(parseUnitPrice("which is cheaper, 500g for $4 or 1.2kg for $9?")).toEqual([
      { qty: 500, unit: "g", price: 4 }, { qty: 1.2, unit: "kg", price: 9 },
    ]);
    expect(parseUnitPrice("$3.99 for 12oz vs $5.49 for 20oz")).toEqual([
      { qty: 12, unit: "oz", price: 3.99 }, { qty: 20, unit: "oz", price: 5.49 },
    ]);
  });
  it("parses a bare count ('12 for $6 or 30 for $13')", () => {
    expect(parseUnitPrice("better deal: 12 for $6 or 30 for $13")).toEqual([
      { qty: 12, unit: "", price: 6 }, { qty: 30, unit: "", price: 13 },
    ]);
  });
  it("parses the connector-less '<qty><unit> $<price>' shelf phrasing (unitprice-spaceless-price)", () => {
    expect(parseUnitPrice("12 rolls $6 vs 8 rolls $4.50")).toEqual([
      { qty: 12, unit: "rolls", price: 6 }, { qty: 8, unit: "rolls", price: 4.5 },
    ]);
    expect(parseUnitPrice("20 oz $3.99 or 12 oz $2.50")).toEqual([
      { qty: 20, unit: "oz", price: 3.99 }, { qty: 12, unit: "oz", price: 2.5 },
    ]);
    expect(parseUnitPrice("500g $4 vs 1.2kg $9")).toEqual([
      { qty: 500, unit: "g", price: 4 }, { qty: 1.2, unit: "kg", price: 9 },
    ]);
  });
  it("still needs a connector when the price isn't $-marked (a bare '12 rolls 6' is ambiguous)", () => {
    expect(parseUnitPrice("12 rolls 6 vs 8 rolls 4")).toBeNull(); // 6/4 could be a second qty, not a price
  });
  it("parses 'N pack' incl. hyphenated + a 'which is better value' lead (unitprice-hyphen-pack)", () => {
    expect(parseUnitPrice("which is better value 6 pack $5 or 12 pack $9")).toEqual([
      { qty: 6, unit: "pack", price: 5 }, { qty: 12, unit: "pack", price: 9 },
    ]);
    expect(parseUnitPrice("6-pack $5 or 12-pack $9")).toEqual([
      { qty: 6, unit: "pack", price: 5 }, { qty: 12, unit: "pack", price: 9 },
    ]);
  });
  it("null when it isn't a compare (fewer than 2 parseable options)", () => {
    expect(parseUnitPrice("500g for $4")).toBeNull();
    expect(parseUnitPrice("what's the weather or the news")).toBeNull();
  });
  it("the connector-less form picks the right winner end-to-end (unitprice-spaceless-price)", () => {
    const out = runUnitPrice("12 rolls $6 vs 8 rolls $4.50")!;
    expect(out).toMatch(/Better buy/);
    expect(out).toMatch(/✅ \$6\.00 for 12rolls = \$0\.50 each/); // 12-pack cheaper per roll
  });
});

describe("compareUnitPrice", () => {
  it("normalizes mixed units + picks the cheapest per base", () => {
    // 500g @ $4 = $0.008/g ; 1.2kg @ $9 = $0.0075/g -> the kg is cheaper.
    const r = compareUnitPrice([{ qty: 500, unit: "g", price: 4 }, { qty: 1.2, unit: "kg", price: 9 }])!;
    expect(r.cheapest).toBe(1);
    expect(r.options[1]!.perBase).toBeLessThan(r.options[0]!.perBase);
  });
  it("null when options mix dimensions (weight vs volume)", () => {
    expect(compareUnitPrice([{ qty: 500, unit: "g", price: 4 }, { qty: 1, unit: "L", price: 9 }])).toBeNull();
  });
  it("null on a bad price/qty, or a MIX of a real measure + an unknown noun (can't compare)", () => {
    expect(compareUnitPrice([{ qty: 0, unit: "g", price: 4 }, { qty: 1, unit: "kg", price: 9 }])).toBeNull();
    expect(compareUnitPrice([{ qty: 5, unit: "blorp", price: 4 }, { qty: 1, unit: "kg", price: 9 }])).toBeNull();
  });
  it("a same named-count noun on both sides compares per-item (unitprice-named-count)", () => {
    // "eggs" isn't a measurement unit, but both sides count eggs -> compare per-egg.
    const r = compareUnitPrice([{ qty: 12, unit: "eggs", price: 3 }, { qty: 18, unit: "eggs", price: 4 }])!;
    expect(r.options.every((o) => o.dim === "count")).toBe(true);
    expect(r.cheapest).toBe(1); // 4/18 = 0.22 < 3/12 = 0.25
  });
  it("a named count on one side + a bare count on the other still compares (2nd drops the noun)", () => {
    const r = compareUnitPrice([{ qty: 12, unit: "eggs", price: 3 }, { qty: 18, unit: "", price: 4 }])!;
    expect(r.cheapest).toBe(1);
  });
  it("TWO different unknown nouns refuse (not the same thing)", () => {
    expect(compareUnitPrice([{ qty: 12, unit: "eggs", price: 3 }, { qty: 18, unit: "rolls", price: 4 }])).toBeNull();
  });
});

describe("runUnitPrice", () => {
  it("names the better buy with normalized per-unit prices", () => {
    const out = runUnitPrice("which is cheaper, 500g for $4 or 1.2kg for $9?")!;
    expect(out).toMatch(/Better buy/);
    expect(out).toMatch(/✅ \$9\.00 for 1\.2kg = \$0\.75 per 100g/); // cheaper one flagged
    expect(out).toMatch(/• \$4\.00 for 500g = \$0\.80 per 100g/);
  });
  it("count options compare per-item", () => {
    const out = runUnitPrice("12 for $6 or 30 for $13")!;
    expect(out).toMatch(/= \$0\.50 each/);   // 12/$6
    expect(out).toMatch(/✅.*= \$0\.43 each/); // 30/$13 cheaper
  });
  it("handles thousands-separated prices and quantities (unitprice-thousands-comma)", () => {
    // $1,299/3 = $433 each ; $1,499/4 = $374.75 each -> the 4-pack is cheaper.
    const out = runUnitPrice("$1,299 for 3 vs $1,499 for 4")!;
    expect(out).toMatch(/Better buy/);
    expect(out).toMatch(/✅ \$1499\.00 for 4 = \$374\.75 each/);
    // A comma in the QUANTITY too.
    expect(runUnitPrice("1,200g for $4 or 1.2kg for $9")).not.toBeNull();
  });
  it("a 3-way compare picks the cheapest + reports savings vs the next-best (unitprice-three-way-and-percent-savings)", () => {
    const out = runUnitPrice("12oz $3 or 20oz $4 or 32oz $5")!;
    expect(out).toMatch(/Better buy \(\d+% cheaper than the next-best\)/); // % is vs runner-up, not silent
    expect((out.match(/✅/g) || []).length).toBe(1);          // exactly one winner
    expect(out).toMatch(/✅ \$5\.00 for 32oz/);                // biggest pack cheapest per unit
  });
  it("a dead tie reports 'same price' with no false winner (unitprice-three-way-and-percent-savings)", () => {
    const out = runUnitPrice("2 for $10 or 2 for $10")!;
    expect(out).toMatch(/[Ss]ame price/);
    expect(out).not.toMatch(/0% cheaper/);      // never the misleading 0%
    expect((out.match(/✅/g) || []).length).toBe(0); // no arbitrary winner
  });
  it("a 2-way compare keeps the plain '% cheaper' (no 'than the next-best')", () => {
    const out = runUnitPrice("500g for $4 or 1kg for $9")!;
    expect(out).toMatch(/Better buy \(\d+% cheaper\):/);
    expect(out).not.toMatch(/next-best/);
  });
  it("null for a non-compare request (falls through to the agent)", () => {
    expect(runUnitPrice("what's the price of bitcoin")).toBeNull();
  });
});
