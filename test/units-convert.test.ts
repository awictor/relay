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
  it("treats bare oz as FLUID ounce when converting against a volume unit (units-cup-to-oz-crosstype)", () => {
    // 1 cup = 8 fl oz (US) — the canonical kitchen conversion, not a cross-type reject.
    expect(convertUnit(1, "cup", "oz")!.value).toBeCloseTo(8, 1);
    expect(convertUnit(8, "oz", "cups")!.value).toBeCloseTo(1, 1);
    // oz stays MASS when both sides are mass.
    expect(convertUnit(16, "oz", "lb")!.value).toBeCloseTo(1, 3);
  });
  it("returns null for unknown units or a genuine cross-dimension conversion", () => {
    expect(convertUnit(1, "kg", "miles")).toBeNull(); // mass -> length
    expect(convertUnit(1, "cup", "kg")).toBeNull();   // volume -> mass (not oz) still can't
    expect(convertUnit(1, "florbs", "km")).toBeNull(); // unknown
    expect(convertUnit(5, "MB", "miles")).toBeNull();  // data -> length
  });
  it("data storage (binary factors: 1 KB = 1024 B) (data-unit-convert)", () => {
    expect(convertUnit(500, "MB", "GB")!.value).toBeCloseTo(0.48828, 4);
    expect(convertUnit(2, "GB", "MB")!.value).toBeCloseTo(2048, 3);
    expect(convertUnit(1024, "KB", "MB")!.value).toBeCloseTo(1, 6);
    expect(convertUnit(1, "GB", "bytes")!.value).toBe(1024 ** 3);
    expect(convertUnit(1.5, "TB", "GB")!.value).toBeCloseTo(1536, 3);
    expect(runConvert("500 MB in GB")).toMatch(/0\.488 GB/);
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
  it("strips a trailing 'please'/'thanks'/punctuation so it isn't glued to the target unit (unit-convert-trailing-please)", () => {
    // "to lbs please" used to parse to="lbs please" -> unknown unit -> conversion failed.
    expect(parseUnitConvert("convert 100 kg to lbs please")).toEqual({ amount: 100, from: "kg", to: "lbs" });
    expect(parseUnitConvert("10 miles in km thanks")).toEqual({ amount: 10, from: "miles", to: "km" });
    expect(parseUnitConvert("convert 5km to miles pls")).toEqual({ amount: 5, from: "km", to: "miles" });
    expect(parseUnitConvert("180C to F?")).toEqual({ amount: 180, from: "C", to: "F" });
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
    expect(runConvert("convert 100 kg to lbs please")).toMatch(/100 kg = 220\.5 lb/); // trailing 'please' no longer breaks it
  });
  it("null on unknown / cross-type / non-conversion", () => {
    expect(runConvert("3 kg to miles")).toBeNull();
    expect(runConvert("hello there")).toBeNull();
  });
});
