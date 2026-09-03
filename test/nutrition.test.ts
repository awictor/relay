import { describe, it, expect } from "vitest";
import { nutritionUrl, parseNutrition, formatNutrition, getNutrition } from "../src/lib/nutrition.js";

const body = (over: Record<string, unknown> = {}) => JSON.stringify({
  foods: [{
    description: "Banana, raw",
    foodNutrients: [
      { nutrientName: "Energy", unitName: "KJ", value: 371 },
      { nutrientName: "Energy", unitName: "KCAL", value: 89 },
      { nutrientName: "Protein", unitName: "G", value: 1.09 },
      { nutrientName: "Carbohydrate, by difference", unitName: "G", value: 22.8 },
      { nutrientName: "Total lipid (fat)", unitName: "G", value: 0.33 },
    ],
    ...over,
  }],
});

describe("nutritionUrl", () => {
  it("hits USDA search, restricts to whole-food datasets, injects the key", () => {
    const u = nutritionUrl("banana", "TESTKEY");
    expect(u).toContain("api.nal.usda.gov/fdc/v1/foods/search");
    expect(u).toContain("query=banana");
    expect(u).toContain("api_key=TESTKEY");
    expect(u).toMatch(/dataType=Foundation/);
  });
});

describe("parseNutrition", () => {
  it("takes the KCAL energy row (not KJ) + the macros", () => {
    const n = parseNutrition(body())!;
    expect(n).toMatchObject({ food: "Banana, raw", kcal: 89, proteinG: 1.09, carbG: 22.8, fatG: 0.33 });
  });
  it("falls back to a non-KJ energy row when there's no KCAL row", () => {
    const n = parseNutrition(JSON.stringify({ foods: [{ description: "X", foodNutrients: [{ nutrientName: "Energy", unitName: "", value: 200 }] }] }))!;
    expect(n.kcal).toBe(200);
  });
  it("never lands a KJ value in kcal", () => {
    const n = parseNutrition(JSON.stringify({ foods: [{ description: "X", foodNutrients: [{ nutrientName: "Energy", unitName: "KJ", value: 999 }, { nutrientName: "Protein", unitName: "G", value: 5 }] }] }))!;
    expect(n.kcal).toBeUndefined();
    expect(n.proteinG).toBe(5);
  });
  it("null on no match, bad json, or a description with no nutrients", () => {
    expect(parseNutrition(JSON.stringify({ foods: [] }))).toBeNull();
    expect(parseNutrition("nope")).toBeNull();
    expect(parseNutrition(JSON.stringify({ foods: [{ description: "Empty", foodNutrients: [] }] }))).toBeNull();
  });
});

describe("formatNutrition", () => {
  it("shows the matched food, per-100g macros, and a source/per-100g note", () => {
    const out = formatNutrition(parseNutrition(body())!);
    expect(out).toMatch(/Banana, raw \(per 100g\)/);
    expect(out).toMatch(/89 kcal/);
    expect(out).toMatch(/1\.1g protein/);
    expect(out).toMatch(/per 100 grams/);
    expect(out).toMatch(/USDA/);
  });
});

describe("getNutrition (injected fetch)", () => {
  it("resolves the food's macros", async () => {
    let seen = "";
    const n = await getNutrition("banana", async (u) => { seen = u; return body(); });
    expect(seen).toContain("query=banana");
    expect(n!.kcal).toBe(89);
  });
  it("null on a fetch throw (never throws)", async () => {
    expect(await getNutrition("x", async () => { throw new Error("net"); })).toBeNull();
  });
  it("null on empty query", async () => {
    expect(await getNutrition("  ", async () => body())).toBeNull();
  });
});
