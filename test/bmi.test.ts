import { describe, it, expect } from "vitest";
import { parseHeightM, parseWeightKg, runBmi, formatBmi } from "../src/lib/bmi.js";

describe("parseHeightM", () => {
  it("parses imperial + metric heights", () => {
    expect(parseHeightM("5'10\"")).toBeCloseTo(1.778, 3);
    expect(parseHeightM("5 ft 10 in")).toBeCloseTo(1.778, 3);
    expect(parseHeightM("6 foot")).toBeCloseTo(1.8288, 3);
    expect(parseHeightM("175 cm")).toBeCloseTo(1.75, 3);
    expect(parseHeightM("1.75 m")).toBeCloseTo(1.75, 3);
    expect(parseHeightM("70 in")).toBeCloseTo(1.778, 3);
  });
  it("does NOT grab a trailing weight as inches ('6 foot 200 lb')", () => {
    expect(parseHeightM("6 foot 200 lb")).toBeCloseTo(1.8288, 3); // 6.0 ft, not 6ft200in
  });
  it("returns null with no parseable height", () => {
    expect(parseHeightM("just 25")).toBeNull();
  });
});

describe("parseWeightKg", () => {
  it("parses lb / kg / stone", () => {
    expect(parseWeightKg("160 lb")).toBeCloseTo(72.575, 2);
    expect(parseWeightKg("70 kg")).toBeCloseTo(70, 5);
    expect(parseWeightKg("11 st 4 lb")).toBeCloseTo(71.668, 2);
  });
  it("returns null with no unit", () => {
    expect(parseWeightKg("160")).toBeNull();
  });
});

describe("runBmi", () => {
  it("computes BMI + WHO category across unit systems", () => {
    expect(runBmi("5'10 160lb")).toMatchObject({ bmi: 23, category: "a healthy weight" });
    expect(runBmi("70kg 1.75m")).toMatchObject({ bmi: 22.9, category: "a healthy weight" });
    expect(runBmi("6 foot 200 lb")).toMatchObject({ bmi: 27.1, category: "overweight" });
    expect(runBmi("5'10 110 lb")!.category).toBe("underweight"); // ~15.8
    expect(runBmi("5'5 200 lb")!.category).toBe("obese");        // ~33.3
  });
  it("returns null when height or weight is missing / nonsense", () => {
    expect(runBmi("just a number 25")).toBeNull();
    expect(runBmi("5'10")).toBeNull();       // no weight
    expect(runBmi("160 lb")).toBeNull();     // no height
  });
  it("formatBmi carries the number, category, and a not-a-diagnosis caveat", () => {
    const s = formatBmi(runBmi("70kg 1.75m")!);
    expect(s).toMatch(/22\.9/);
    expect(s).toMatch(/healthy weight/);
    expect(s).toMatch(/not a diagnosis/i);
  });
});
