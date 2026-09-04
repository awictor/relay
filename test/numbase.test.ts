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
  });
});

describe("parseSourceNumber", () => {
  it("parses prefixed + plain sources", () => {
    expect(parseSourceNumber("0xFF to decimal")).toEqual({ value: 255, base: 16 });
    expect(parseSourceNumber("0b1010 in hex")).toEqual({ value: 10, base: 2 });
    expect(parseSourceNumber("0o52 to decimal")).toEqual({ value: 42, base: 8 });
    expect(parseSourceNumber("255 in binary")).toEqual({ value: 255, base: 10 });
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
