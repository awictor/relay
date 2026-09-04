import { describe, it, expect } from "vitest";
import { parseTargetBase, parseSourceNumber, renderBase, runNumberBase, formatNumberBase } from "../src/lib/numbase.js";

describe("parseTargetBase", () => {
  it("reads base words + 'base N'", () => {
    expect(parseTargetBase("255 in binary")).toBe(2);
    expect(parseTargetBase("to hex")).toBe(16);
    expect(parseTargetBase("in octal")).toBe(8);
    expect(parseTargetBase("to decimal")).toBe(10);
    expect(parseTargetBase("base 2")).toBe(2);
    expect(parseTargetBase("no base named")).toBeNull();
    // The TARGET is the base after "to"/"in", even when a SOURCE base word leads (numbase-adjacent-source-base).
    expect(parseTargetBase("1010 binary to decimal")).toBe(10);
    expect(parseTargetBase("FF hex to binary")).toBe(2);
  });
});

describe("parseSourceNumber", () => {
  it("parses prefixed + plain sources", () => {
    expect(parseSourceNumber("0xFF to decimal")).toEqual({ value: 255, base: 16 });
    expect(parseSourceNumber("0b1010 in hex")).toEqual({ value: 10, base: 2 });
    expect(parseSourceNumber("0o52 to decimal")).toEqual({ value: 42, base: 8 });
    expect(parseSourceNumber("255 in binary")).toEqual({ value: 255, base: 10 });
    // A base word ADJACENT after the number is the SOURCE base (numbase-adjacent-source-base): "1010
    // binary" is binary-1010 (=10), not decimal-1010. Previously mis-read as decimal.
    expect(parseSourceNumber("1010 binary to decimal")).toEqual({ value: 10, base: 2 });
    expect(parseSourceNumber("FF hex to decimal")).toEqual({ value: 255, base: 16 });
    expect(parseSourceNumber("52 octal in decimal")).toEqual({ value: 42, base: 8 });
  });
});

describe("renderBase", () => {
  it("prefixes hex/bin/oct, plain decimal", () => {
    expect(renderBase(255, 16)).toBe("0xFF");
    expect(renderBase(10, 2)).toBe("0b1010");
    expect(renderBase(42, 8)).toBe("0o52");
    expect(renderBase(255, 10)).toBe("255");
  });
});

describe("runNumberBase", () => {
  it("converts across bases", () => {
    expect(runNumberBase("255 in binary")).toMatchObject({ out: "0b11111111", from: 10, to: 2 });
    expect(runNumberBase("0xFF to decimal")).toMatchObject({ out: "255", from: 16, to: 10 });
    expect(runNumberBase("convert 42 to hex")).toMatchObject({ out: "0x2A" });
    // Worded source base + directional target (numbase-adjacent-source-base): 1010₂ = 10₁₀.
    expect(runNumberBase("1010 binary to decimal")).toMatchObject({ out: "10", from: 2, to: 10 });
    expect(runNumberBase("FF hex to binary")).toMatchObject({ from: 16, to: 2 });
  });
  it("null when no target base or no number or negatives", () => {
    expect(runNumberBase("just 5")).toBeNull();           // no target base
    expect(runNumberBase("in binary please")).toBeNull(); // no number
    expect(runNumberBase("hello world")).toBeNull();
  });
  it("formatNumberBase shows both sides with base names", () => {
    expect(formatNumberBase(runNumberBase("255 in binary")!)).toMatch(/255 \(decimal\) = 0b11111111 \(binary\)/);
  });
});
