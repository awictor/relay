import { describe, it, expect } from "vitest";
import { calc, normalizeExpr, formatResult } from "../src/lib/calc.js";

describe("calc — basic arithmetic + precedence", () => {
  it("respects operator precedence + parens", () => {
    expect(calc("2 + 3 * 4")).toBe(14);
    expect(calc("(2 + 3) * 4")).toBe(20);
    expect(calc("2 ^ 3 ^ 2")).toBe(512); // right-assoc
    expect(calc("10 / 4")).toBe(2.5);
    expect(calc("17 mod 5")).toBe(2); // "%" is reserved for percentages; modulo is the word "mod"
  });
  it("handles unary minus", () => {
    expect(calc("-5 + 3")).toBe(-2);
    expect(calc("3 * -2")).toBe(-6);
    expect(calc("-(4 + 1)")).toBe(-5);
  });
});

describe("calc — money + words + symbols", () => {
  it("strips $ and thousands commas", () => {
    expect(calc("$1,000 + $250")).toBe(1250);
  });
  it("understands word operators", () => {
    expect(calc("5 times 4 plus 2")).toBe(22);
    expect(calc("100 divided by 8")).toBe(12.5);
  });
});

describe("calc — percentages", () => {
  it("'X% of Y'", () => {
    expect(calc("20% of 47")).toBeCloseTo(9.4, 5);
    expect(calc("15% of 200")).toBe(30);
  });
  it("bare percent -> /100", () => {
    expect(calc("50 * 20%")).toBe(10);
  });
  it("'Y + X%' adds, 'Y - X% off' subtracts", () => {
    expect(calc("50 + 20%")).toBe(60);
    expect(calc("50 - 20%")).toBe(40);
    expect(calc("80 - 25% off")).toBe(60);
  });
});

describe("calc — the bill-split + loan cases the audit flagged", () => {
  it("splits a bill with tip", () => {
    // $127.50 three ways after 20% tip
    expect(calc("(127.50 * 1.2) / 3")).toBeCloseTo(51, 5);
  });
  it("loanpayment(principal, annualRatePct, years) -> monthly payment", () => {
    // $30k at 6% for 5 years ~= $579.98/mo
    expect(calc("loanpayment(30000, 6, 5)")).toBeCloseTo(579.98, 1);
  });
  it("zero-rate loan is straight division", () => {
    expect(calc("loanpayment(1200, 0, 1)")).toBe(100);
  });
  it("functions: sqrt/round/min/max", () => {
    expect(calc("sqrt(144)")).toBe(12);
    expect(calc("round(2.7)")).toBe(3);
    expect(calc("max(3, 9)")).toBe(9);
    expect(calc("min(3, 9)")).toBe(3);
  });
});

describe("calc — errors (friendly, never eval)", () => {
  it("throws on divide-by-zero + malformed + unknown name", () => {
    expect(() => calc("5 / 0")).toThrow(/divide by zero/i);
    expect(() => calc("2 +")).toThrow();
    expect(() => calc("frobnicate(2)")).toThrow(/don't know/i);
    expect(() => calc("(2 + 3")).toThrow(/parenthes/i);
    expect(() => calc("")).toThrow();
  });
  it("does NOT execute code (no eval) — a JS expression is rejected as unknown tokens", () => {
    expect(() => calc("process.exit(1)")).toThrow();
    expect(() => calc("1;2")).toThrow();
  });
});

describe("normalizeExpr / formatResult", () => {
  it("normalizeExpr strips currency + collapses words", () => {
    expect(normalizeExpr("$1,234 times 2")).toBe("1234 * 2");
  });
  it("formatResult: integers plain, decimals to 2dp", () => {
    expect(formatResult(1250)).toBe("1,250");
    expect(formatResult(51)).toBe("51");
    expect(formatResult(579.976)).toBe("579.98");
  });
});
