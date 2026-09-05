import { describe, it, expect } from "vitest";
import { intToWords, numberToWords, runNumWords } from "../src/lib/numwords.js";

describe("intToWords", () => {
  it("spells whole numbers across scales", () => {
    expect(intToWords(0)).toBe("zero");
    expect(intToWords(7)).toBe("seven");
    expect(intToWords(13)).toBe("thirteen");
    expect(intToWords(42)).toBe("forty-two");
    expect(intToWords(100)).toBe("one hundred");
    expect(intToWords(215)).toBe("two hundred fifteen");
    expect(intToWords(1000)).toBe("one thousand");
    expect(intToWords(1234)).toBe("one thousand two hundred thirty-four");
    expect(intToWords(1_000_000)).toBe("one million");
    expect(intToWords(1_234_567)).toBe("one million two hundred thirty-four thousand five hundred sixty-seven");
  });
  it("null out of range or non-integer", () => {
    expect(intToWords(-1)).toBeNull();
    expect(intToWords(1_000_000_000_000)).toBeNull(); // over a few hundred billion
    expect(intToWords(3.5)).toBeNull();
  });
});

describe("numberToWords", () => {
  it("money/cents form only on explicit cents request", () => {
    expect(numberToWords(1250.5, { cents: true })).toBe("one thousand two hundred fifty and 50/100");
    expect(numberToWords(99.99, { cents: true })).toBe("ninety-nine and 99/100");
    // a bare decimal (pi) is NOT money -> "point ..." not "/100"
    expect(numberToWords(3.14)).toBe("three point one four");
  });
});

describe("runNumWords", () => {
  it("spells a plain number from a words request", () => {
    expect(runNumWords("spell out 1234")).toBe("One thousand two hundred thirty-four.");
    expect(runNumWords("how do you say 42 in words")).toBe("Forty-two.");
    expect(runNumWords("1000 in words")).toBe("One thousand.");
  });
  it("a $ amount gives the check/cents form", () => {
    expect(runNumWords("put $99.99 in words")).toBe("Ninety-nine and 99/100 dollars.");
    expect(runNumWords("write $1,250.50 in words")).toBe("One thousand two hundred fifty and 50/100 dollars.");
  });
  it("strips thousands commas", () => {
    expect(runNumWords("spell out 1,234")).toBe("One thousand two hundred thirty-four.");
  });
  it("declines out-of-range with a clear note", () => {
    expect(runNumWords("spell out 1000000000000")).toMatch(/only spell out whole numbers/i);
  });
  it("null when it isn't a spell-out request (no cue) or has no number", () => {
    expect(runNumWords("what's the weather")).toBeNull();
    expect(runNumWords("1234")).toBeNull();          // bare number, no cue -> not hijacked
    expect(runNumWords("spell out my name")).toBeNull(); // cue but no number
  });
});
