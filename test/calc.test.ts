import { describe, it, expect } from "vitest";
import { calc, normalizeExpr, formatResult } from "../src/lib/calc.js";

describe("calc — basic arithmetic + precedence", () => {
  it("respects operator precedence + parens", () => {
    expect(calc("2 + 3 * 4")).toBe(14);
    expect(calc("(2 + 3) * 4")).toBe(20);
    expect(calc("2 ^ 3 ^ 2")).toBe(512); // right-assoc
    expect(calc("10 / 4")).toBe(2.5);
    expect(calc("17 mod 5")).toBe(2); // "%" is reserved for percentages; modulo is the word "mod"
    // A bare "%" BETWEEN two operands is modulo too (calc-modulo-and-variadic): it's only a percentage
    // when it TRAILS a number ("20% of", "50 - 20%").
    expect(calc("17 % 5")).toBe(2);
    expect(calc("17 % (2 + 3)")).toBe(2);
    expect(calc("50 * 20%")).toBe(10); // trailing % still a percentage, not modulo
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
  it("percent-first discount 'X% off Y' (calc-pct-off-first)", () => {
    // The common phrasing "20% off 50" (percent first, no minus sign) — a top shopping-math ask.
    expect(calc("20% off 50")).toBe(40);
    expect(calc("15% off 80")).toBe(68);
    expect(calc("20% off $50")).toBe(40);   // $ stripped in normalizeExpr
    // still distinct from "% of": "20% of 50" is the part, not the remainder
    expect(calc("20% of 50")).toBe(10);
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
  it("min/max fold 3+ args (calc-modulo-and-variadic)", () => {
    expect(calc("max(1, 2, 3)")).toBe(3);
    expect(calc("min(5, 2, 8, 1)")).toBe(1);
    expect(calc("max(1, 2, 3) + min(4, 5)")).toBe(7); // variadic + nested binary
  });
  it("wrong arity for a fixed-arity fn is a friendly error, not silent residue", () => {
    expect(() => calc("sqrt(4, 9)")).toThrow(/1 argument/i);
    expect(() => calc("loanpayment(1000, 5)")).toThrow(/3 argument/i);
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

describe("natural phrasing: tip idiom, scientific notation, factorial (calc-natural-phrasing)", () => {
  it("'X% tip on Y' gives the tip AMOUNT (Y*X/100), not an 'I don't know tip' error", () => {
    expect(calc("20% tip on 47")).toBeCloseTo(9.4, 6);
    expect(calc("20% tip on $47")).toBeCloseTo(9.4, 6);   // $ stripped
    expect(calc("15% tip on 120")).toBeCloseTo(18, 6);
    expect(calc("18% gratuity on 200")).toBeCloseTo(36, 6);
  });
  it("scientific notation is a number, not an unknown 'e'", () => {
    expect(calc("1e3 + 1")).toBe(1001);
    expect(calc("6.02e23")).toBeCloseTo(6.02e23, -18);
    expect(calc("2.5e-4")).toBeCloseTo(0.00025, 9);
    expect(() => calc("e")).toThrow(/don't know/);        // bare 'e' still errors (no digits follow)
    expect(() => calc("e + 1")).toThrow();
  });
  it("trailing '!' is factorial, with whole-number + overflow guards", () => {
    expect(calc("5!")).toBe(120);
    expect(calc("0!")).toBe(1);
    expect(calc("10!")).toBe(3628800);
    expect(calc("5! + 1")).toBe(121);
    expect(() => calc("3.5!")).toThrow(/whole number/);
    expect(() => calc("171!")).toThrow(/too big/);
  });
  it("regressions: existing percent/mod/currency idioms unchanged", () => {
    expect(calc("20% of 50")).toBe(10);
    expect(calc("50 - 20%")).toBe(40);
    expect(calc("5 mod 2")).toBe(1);
    expect(calc("1,000 + 1")).toBe(1001);
  });
  it("percent CHANGE from A to B (calc-percent-change)", () => {
    expect(calc("50 to 75 percent change")).toBe(50);
    expect(calc("what percent increase from 50 to 75")).toBe(50);
    expect(calc("% change 100 to 90")).toBe(-10);
    expect(calc("percent decrease from 200 to 150")).toBe(-25);
    // "20% off 80" (final price) still works via the existing off-idiom, not the change path.
    expect(calc("20% off 80")).toBe(64);
    // a bare "A to B" with no percent/change cue is NOT hijacked (stays an error, not a silent number).
    expect(() => calc("50 to 75")).toThrow();
    // percent change off zero is undefined -> errors rather than dividing by zero.
    expect(() => calc("0 to 50 percent change")).toThrow();
  });
});
