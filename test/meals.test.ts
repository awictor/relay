import { describe, it, expect } from "vitest";
import { parseMealRequest, parseMealIdeas, parseFullMeal, formatMealIdeas, formatFullMeal, getMeals, filterByIngredientUrl, searchByNameUrl } from "../src/lib/meals.js";

const ideasBody = (names: string[]) => JSON.stringify({ meals: names.map((n, i) => ({ strMeal: n, strArea: "Test", idMeal: String(i) })) });
const fullBody = (name: string) => JSON.stringify({ meals: [{
  strMeal: name, strCategory: "Chicken", strArea: "Jamaican",
  strInstructions: "Season. Brown. Simmer.", strSource: "https://ex.com/r",
  strIngredient1: "Chicken", strMeasure1: "1 whole", strIngredient2: "Onion", strMeasure2: "1", strIngredient3: "", strMeasure3: "",
}] });

describe("parseMealRequest", () => {
  it("ingredient: takes the first salient ingredient", () => {
    expect(parseMealRequest("what can I make with chicken and rice")).toEqual({ kind: "ingredient", ingredient: "chicken" });
    expect(parseMealRequest("dinner ideas with salmon")).toEqual({ kind: "ingredient", ingredient: "salmon" });
  });
  it("ingredient: 'something/anything with X' (meal-something-with-ingredient)", () => {
    expect(parseMealRequest("something with rice and beans")).toEqual({ kind: "ingredient", ingredient: "rice" });
    expect(parseMealRequest("anything with tofu")).toEqual({ kind: "ingredient", ingredient: "tofu" });
  });
  it("dish: 'recipe for X' / 'how do I make X'", () => {
    expect(parseMealRequest("recipe for carbonara")).toEqual({ kind: "dish", name: "carbonara" });
    expect(parseMealRequest("how do I make lasagna")).toEqual({ kind: "dish", name: "lasagna" });
  });
  it("random: generic ideas", () => {
    expect(parseMealRequest("dinner ideas")).toEqual({ kind: "random" });
    expect(parseMealRequest("what should I cook")).toEqual({ kind: "random" });
    expect(parseMealRequest("random meal")).toEqual({ kind: "random" });
    expect(parseMealRequest("what's for dinner")).toEqual({ kind: "random" });
    expect(parseMealRequest("what's good for lunch")).toEqual({ kind: "random" });
  });
  it("returns null for a non-food message", () => {
    expect(parseMealRequest("what's the weather")).toBeNull();
    expect(parseMealRequest("run my morning recipe")).toBeNull(); // automation-recipe, not food
  });
});

describe("parseMealIdeas / parseFullMeal", () => {
  it("parses idea list capped", () => {
    const ideas = parseMealIdeas(ideasBody(["A", "B", "C", "D", "E", "F", "G", "H"]));
    expect(ideas).toHaveLength(6);
    expect(ideas[0]).toMatchObject({ name: "A", area: "Test" });
  });
  it("parses a full meal's ingredients (with measures) + instructions, skipping blanks", () => {
    const m = parseFullMeal(fullBody("Brown Stew Chicken"))!;
    expect(m.name).toBe("Brown Stew Chicken");
    expect(m.ingredients).toEqual(["1 whole Chicken", "1 Onion"]); // blank 3rd dropped
    expect(m.instructions).toMatch(/Season/);
    expect(m.source).toBe("https://ex.com/r");
  });
  it("returns [] / null on malformed or empty", () => {
    expect(parseMealIdeas("not json")).toEqual([]);
    expect(parseMealIdeas(JSON.stringify({ meals: null }))).toEqual([]);
    expect(parseFullMeal(JSON.stringify({ meals: null }))).toBeNull();
  });
});

describe("format helpers", () => {
  it("formatMealIdeas lists + prompts for a full recipe", () => {
    const out = formatMealIdeas([{ name: "Stew", area: "Jamaican" }], "chicken");
    expect(out).toMatch(/Meal ideas with chicken:/);
    expect(out).toMatch(/• Stew \(Jamaican\)/);
    expect(out).toMatch(/recipe for <name>/);
  });
  it("formatFullMeal shows ingredients + steps + source", () => {
    const out = formatFullMeal({ name: "Stew", area: "Jamaican", category: "Chicken", ingredients: ["1 Chicken"], instructions: "Cook it.", source: "https://ex.com" });
    expect(out).toMatch(/Stew \(Jamaican, Chicken\)/);
    expect(out).toMatch(/Ingredients:\n• 1 Chicken/);
    expect(out).toMatch(/Steps: Cook it\./);
    expect(out).toMatch(/Source: https:\/\/ex\.com/);
  });
});

describe("getMeals", () => {
  it("ingredient -> ideas list", async () => {
    let seen = "";
    const r = await getMeals({ kind: "ingredient", ingredient: "chicken" }, async (u) => { seen = u; return ideasBody(["Stew", "Curry"]); });
    expect(seen).toBe(filterByIngredientUrl("chicken"));
    expect("ideas" in r! && r.ideas).toHaveLength(2);
  });
  it("dish -> full recipe via search", async () => {
    let seen = "";
    const r = await getMeals({ kind: "dish", name: "carbonara" }, async (u) => { seen = u; return fullBody("Carbonara"); });
    expect(seen).toBe(searchByNameUrl("carbonara"));
    expect("meal" in r! && r.meal.name).toBe("Carbonara");
  });
  it("null on a miss / fetch throw", async () => {
    expect(await getMeals({ kind: "ingredient", ingredient: "xyz" }, async () => JSON.stringify({ meals: null }))).toBeNull();
    expect(await getMeals({ kind: "random" }, async () => { throw new Error("net"); })).toBeNull();
  });
});
