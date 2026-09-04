import { describe, it, expect } from "vitest";
import { toRoman, fromRoman, runRoman } from "../src/lib/roman.js";

describe("toRoman", () => {
  it("encodes standard values", () => {
    expect(toRoman(42)).toBe("XLII");
    expect(toRoman(2024)).toBe("MMXXIV");
    expect(toRoman(4)).toBe("IV");
    expect(toRoman(1988)).toBe("MCMLXXXVIII");
    expect(toRoman(3999)).toBe("MMMCMXCIX");
  });
  it("rejects out-of-range / non-integer", () => {
    expect(toRoman(0)).toBeNull();
    expect(toRoman(4000)).toBeNull();
    expect(toRoman(4.5)).toBeNull();
  });
});

describe("fromRoman", () => {
  it("decodes valid numerals (case-insensitive)", () => {
    expect(fromRoman("XLII")).toBe(42);
    expect(fromRoman("mmxxiv")).toBe(2024);
    expect(fromRoman("IV")).toBe(4);
  });
  it("rejects malformed / non-canonical", () => {
    expect(fromRoman("IIII")).toBeNull(); // canonical is IV
    expect(fromRoman("VV")).toBeNull();
    expect(fromRoman("IC")).toBeNull();
    expect(fromRoman("hello")).toBeNull();
    expect(fromRoman("")).toBeNull();
  });
});

describe("runRoman", () => {
  it("both directions from free text", () => {
    expect(runRoman("42 in roman numerals")).toMatch(/42 in Roman numerals is XLII/);
    expect(runRoman("MMXXIV to a number")).toMatch(/MMXXIV is 2024/);
    expect(runRoman("what number is MCMLXXXVIII")).toMatch(/is 1988/);
  });
  it("honest errors for out-of-range + invalid + non-requests", () => {
    expect(runRoman("4000 in roman numerals")).toMatch(/only cover 1.3999/);
    expect(runRoman("IIII to a number")).toMatch(/isn't a valid Roman numeral/);
    expect(runRoman("what's the weather")).toBeNull();
  });
});
