import { describe, it, expect } from "vitest";
import { normalizeUnit, convertUnit, parseUnitConvert, runConvert } from "../src/lib/units-convert.js";

describe("convertUnit — temperature (affine)", () => {
  it("C <-> F <-> K", () => {
    expect(convertUnit(180, "C", "F")!.value).toBeCloseTo(356, 5);
    expect(convertUnit(32, "F", "C")!.value).toBeCloseTo(0, 5);
    expect(convertUnit(100, "C", "K")!.value).toBeCloseTo(373.15, 2);
    expect(convertUnit(0, "K", "C")!.value).toBeCloseTo(-273.15, 2);
  });
});

describe("convertUnit — length/mass/volume (factor)", () => {
  it("length", () => {
    expect(convertUnit(10, "miles", "km")!.value).toBeCloseTo(16.09344, 4);
    expect(convertUnit(100, "cm", "m")!.value).toBeCloseTo(1, 6);
    expect(convertUnit(12, "in", "ft")!.value).toBeCloseTo(1, 6);
  });
  it("mass", () => {
    expect(convertUnit(3, "lb", "kg")!.value).toBeCloseTo(1.360776, 4);
    expect(convertUnit(1, "kg", "g")!.value).toBeCloseTo(1000, 3);
    expect(convertUnit(16, "oz", "lb")!.value).toBeCloseTo(1, 3);
  });
  it("volume (cooking)", () => {
    expect(convertUnit(1, "cup", "ml")!.value).toBeCloseTo(236.588, 2);
    expect(convertUnit(3, "tsp", "tbsp")!.value).toBeCloseTo(1, 2);
    expect(convertUnit(1, "l", "ml")!.value).toBeCloseTo(1000, 3);
  });
  it("returns null for unknown units or cross-dimension conversion", () => {
    expect(convertUnit(1, "kg", "miles")).toBeNull(); // mass -> length
    expect(convertUnit(1, "florbs", "km")).toBeNull(); // unknown
  });
});

describe("normalizeUnit", () => {
  it("maps aliases, symbols, plurals", () => {
    expect(normalizeUnit("°C")).toBe("c");
    expect(normalizeUnit("Fahrenheit")).toBe("f");
    expect(normalizeUnit("miles")).toBe("mile");        // singular alias (maps to km-family in UNITS)
    expect(normalizeUnit("kilograms")).toBe("kilogram"); // drops the plural s to a known UNITS key
    expect(convertUnit(1, "kilograms", "g")!.value).toBeCloseTo(1000, 3); // and it converts
  });
});

describe("parseUnitConvert", () => {
  it("parses '<amount><unit> to <unit>' incl. no-space temp", () => {
    expect(parseUnitConvert("180C to F")).toEqual({ amount: 180, from: "C", to: "F" });
    expect(parseUnitConvert("convert 10 miles to km")).toEqual({ amount: 10, from: "miles", to: "km" });
    expect(parseUnitConvert("3 lb in kg")).toEqual({ amount: 3, from: "lb", to: "kg" });
  });
  it("ignores an 'of <thing>' clause (cooking)", () => {
    expect(parseUnitConvert("2 cups of flour in grams")).toEqual({ amount: 2, from: "cups", to: "grams" });
  });
  it("sums a compound feet+inches height into inches", () => {
    expect(parseUnitConvert("5 ft 11 in in cm")).toEqual({ amount: 71, from: "in", to: "cm" });
  });
  it("returns null for a non-conversion", () => {
    expect(parseUnitConvert("what's the weather")).toBeNull();
  });
});

describe("runConvert (parse + convert + format)", () => {
  it("formats a full request", () => {
    expect(runConvert("180C to F")).toMatch(/180 °C = 356 °F/);
    expect(runConvert("2 cups of flour in grams")).toBeNull(); // cups->grams is volume->mass, can't
    expect(runConvert("2 cups in ml")).toMatch(/= 473\.2 ml/);
    expect(runConvert("5 ft 11 in in cm")).toMatch(/= 180\.3 cm/);
  });
  it("null on unknown / cross-type / non-conversion", () => {
    expect(runConvert("3 kg to miles")).toBeNull();
    expect(runConvert("hello there")).toBeNull();
  });
});
