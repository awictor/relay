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
  it("volume<->mass via ingredient density — the advertised 'cups of flour in grams' (unit-convert-density)", () => {
    // 2 cups = 473.176 ml; flour 0.53 g/ml -> ~251 g. Approximate, flagged.
    expect(runConvert("2 cups of flour in grams")).toMatch(/251 g.*approx/);
    expect(runConvert("1 cup of sugar in grams")).toMatch(/201 g/);
    expect(runConvert("250 g of butter in cups")).toMatch(/cup/);
    // an unknown ingredient must NOT guess a density -> null (falls to the agent).
    expect(runConvert("2 cups of unobtanium in grams")).toBeNull();
    // no ingredient named -> water default, flagged.
    expect(runConvert("1 cup in grams")).toMatch(/assuming water/);
    // same-dimension conversions are unaffected by the density path.
    expect(runConvert("1 cup in ml")).toMatch(/236\.6 ml/);
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
  it("captures an 'of <ingredient>' clause (cooking density — unit-convert-density)", () => {
    expect(parseUnitConvert("2 cups of flour in grams")).toEqual({ amount: 2, from: "cups", to: "grams", of: "flour" });
    expect(parseUnitConvert("10 miles in km")).toEqual({ amount: 10, from: "miles", to: "km" }); // no 'of' -> no field
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
    expect(runConvert("2 cups of flour in grams")).toMatch(/251 g/); // now resolves via flour density
    expect(runConvert("2 cups in ml")).toMatch(/= 473\.2 ml/);
    expect(runConvert("5 ft 11 in in cm")).toMatch(/= 180\.3 cm/);
    expect(runConvert("convert 100 kg to lbs please")).toMatch(/100 kg = 220\.5 lb/); // trailing 'please' no longer breaks it
  });
  it("null on unknown / cross-type / non-conversion", () => {
    expect(runConvert("3 kg to miles")).toBeNull();
    expect(runConvert("hello there")).toBeNull();
  });
});

describe("convertUnit — speed (units-speed-convert)", () => {
  it("converts across mph / km/h / m/s / knots / ft/s exactly", () => {
    expect(convertUnit(100, "km/h", "mph")!.value).toBeCloseTo(62.1371, 3);
    expect(convertUnit(60, "mph", "km/h")!.value).toBeCloseTo(96.5606, 3);
    expect(convertUnit(30, "m/s", "km/h")!.value).toBeCloseTo(108, 6);
    expect(convertUnit(60, "mph", "ft/s")!.value).toBeCloseTo(88, 4);   // the classic 60mph = 88ft/s
    expect(convertUnit(50, "knots", "mph")!.value).toBeCloseTo(57.539, 2);
    expect(convertUnit(100, "km/h", "knots")!.value).toBeCloseTo(53.9957, 3);
  });
  it("normalizes the spoken/slashed spellings to a km/h-equivalent speed unit", () => {
    // The spelled-out / "per" forms collapse to the canonical "km/h" key; "kph"/"kmh" are their own
    // aliases in the table (same factor + "km/h" label), so they stay themselves — either way every
    // one is a speed unit that converts to mph.
    for (const a of ["km/h", "km per hour", "kilometers per hour", "kmph"]) expect(normalizeUnit(a)).toBe("km/h");
    for (const a of ["kph", "kmh", "km/h", "kmph"]) expect(convertUnit(100, a, "mph")!.value).toBeCloseTo(62.1371, 2);
    for (const a of ["mph", "mi/h", "miles per hour", "mi/hr"]) expect(normalizeUnit(a)).toBe("mph");
    expect(normalizeUnit("m/s")).toBe("m/s");
    expect(normalizeUnit("meters per second")).toBe("m/s");
    expect(normalizeUnit("feet per second")).toBe("ft/s");
    for (const a of ["knot", "knots", "kn", "kt"]) expect(convertUnit(50, a, "mph")!.value).toBeCloseTo(57.539, 2); // all are speed
  });
  it("speed can't cross into a length/other dim", () => {
    expect(convertUnit(100, "km/h", "km")).toBeNull();   // speed vs length
    expect(convertUnit(100, "km/h", "kg")).toBeNull();
  });
});

describe("runConvert — speed end-to-end (units-speed-convert)", () => {
  it("answers the everyday speed errands instead of returning null", () => {
    expect(runConvert("100 km/h to mph")).toMatch(/100 km\/h = 62\.14 mph/);
    expect(runConvert("100 kph to mph")).toMatch(/62\.14 mph/);
    expect(runConvert("60 mph to kph")).toMatch(/60 mph = 96\.56 km\/h/);
    expect(runConvert("100 kilometers per hour to mph")).toMatch(/62\.14 mph/);
    expect(runConvert("50 knots to mph")).toMatch(/57\.54 mph/);
    expect(runConvert("30 m/s to km/h")).toMatch(/= 108 km\/h/);
    expect(runConvert("convert 120 kph to mph please")).toMatch(/74\.56 mph/);
  });
});
