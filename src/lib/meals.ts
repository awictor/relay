// Meal ideas / cooking recipes (meal-ideas-tool): "what can I make with chicken and rice", "dinner
// ideas", "random meal", "recipe for carbonara" is a top everyday assistant ask — but it fell to a slow
// blog-link web_search, AND the word "recipe" collides with Relay's automation-recipe system. This hits
// the keyless TheMealDB API (no signup) for meal ideas by ingredient, a random meal, or a named dish's
// full recipe. Pure parse + format helpers exported + unit-tested; the fetch is injected.

export interface MealIdea { name: string; category?: string; area?: string; id?: string; }
export interface FullMeal { name: string; category?: string; area?: string; ingredients: string[]; instructions?: string; source?: string; }

const BASE = "https://www.themealdb.com/api/json/v1/1";

/** Build the keyless TheMealDB URLs. Exported for tests. */
export function filterByIngredientUrl(ingredient: string): string {
  return `${BASE}/filter.php?i=${encodeURIComponent(ingredient.trim())}`;
}
export function searchByNameUrl(name: string): string {
  return `${BASE}/search.php?s=${encodeURIComponent(name.trim())}`;
}
export const randomMealUrl = `${BASE}/random.php`;

/** Parse a "meal ideas" request into a plan, or null when it isn't one. Exported for tests.
 *   "what can I make with chicken and rice" -> { kind:"ingredient", ingredient:"chicken" } (primary)
 *   "dinner ideas" / "what should I cook" / "random meal" -> { kind:"random" }
 *   "recipe for carbonara" / "how do I make lasagna" -> { kind:"dish", name:"carbonara" } */
export function parseMealRequest(text: string): { kind: "ingredient"; ingredient: string } | { kind: "dish"; name: string } | { kind: "random" } | null {
  const t = text.trim();
  // A named dish: "recipe for X", "how (do|to) (i)? make X", "how to cook X".
  const dish = t.match(/\b(?:recipe (?:for|of)|how (?:do i|to) (?:make|cook|prepare))\s+(.+?)\s*[?.!]*$/i);
  if (dish) return { kind: "dish", name: dish[1]!.replace(/^(?:a|an|some)\s+/i, "").trim() };
  // Ingredient-based: "what can I make/cook with X", "meal/dinner/recipe(s) with X", "ideas with X".
  const ing = t.match(/\b(?:make|cook|do)\s+with\s+(.+?)\s*[?.!]*$|\b(?:meals?|dinner|lunch|recipes?|dishes?|ideas?)\s+(?:with|using|from)\s+(.+?)\s*[?.!]*$/i);
  if (ing) {
    const raw = (ing[1] ?? ing[2] ?? "").trim();
    // TheMealDB filters by ONE ingredient; take the first salient one ("chicken and rice" -> "chicken").
    const first = raw.split(/\s*(?:,|\band\b|\bor\b|\bwith\b)\s*/i).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return { kind: "ingredient", ingredient: first };
  }
  // Generic "dinner ideas" / "what should I cook" / "random meal" -> a random suggestion.
  if (/\b(?:dinner|lunch|breakfast|meal|something)\s+(?:ideas?|to (?:eat|cook|make))\b|\bwhat should i (?:cook|eat|make)\b|\brandom (?:meal|recipe|dish)\b|\bmeal ideas?\b/i.test(t)) {
    return { kind: "random" };
  }
  return null;
}

/** Parse a filter/search response into meal ideas (name + category/area), capped. Exported. */
export function parseMealIdeas(body: string, limit = 6): MealIdea[] {
  try {
    const obj = JSON.parse(body) as { meals?: Array<{ strMeal?: string; strCategory?: string; strArea?: string; idMeal?: string }> | null };
    return (obj.meals ?? [])
      .filter((m) => m?.strMeal)
      .slice(0, limit)
      .map((m) => ({ name: m.strMeal!.trim(), ...(m.strCategory ? { category: m.strCategory } : {}), ...(m.strArea ? { area: m.strArea } : {}), ...(m.idMeal ? { id: m.idMeal } : {}) }));
  } catch { return []; }
}

/** Parse a lookup/search response's FIRST meal into a full recipe (ingredients + instructions). Exported. */
export function parseFullMeal(body: string): FullMeal | null {
  try {
    const m = (JSON.parse(body) as { meals?: Array<Record<string, string | null>> | null }).meals?.[0];
    if (!m?.strMeal) return null;
    const ingredients: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const ing = (m[`strIngredient${i}`] ?? "").trim();
      const measure = (m[`strMeasure${i}`] ?? "").trim();
      if (ing) ingredients.push(measure ? `${measure} ${ing}` : ing);
    }
    return {
      name: m.strMeal.trim(),
      ...(m.strCategory ? { category: m.strCategory } : {}),
      ...(m.strArea ? { area: m.strArea } : {}),
      ingredients,
      ...(m.strInstructions ? { instructions: m.strInstructions.trim() } : {}),
      ...(m.strSource ? { source: m.strSource.trim() } : {}),
    };
  } catch { return null; }
}

/** Format a list of meal ideas into a short message. */
export function formatMealIdeas(ideas: MealIdea[], ingredient?: string): string {
  if (!ideas.length) return ingredient ? `I couldn't find meal ideas with "${ingredient}".` : "I couldn't pull meal ideas right now.";
  const head = ingredient ? `Meal ideas with ${ingredient}:` : "Meal ideas:";
  const lines = ideas.map((m) => `• ${m.name}${m.area ? ` (${m.area})` : ""}`);
  return `${head}\n${lines.join("\n")}\n\nWant the full recipe for one? Ask "recipe for <name>".`;
}

/** Format a full meal recipe into a phone-friendly message (ingredients + trimmed steps + source). */
export function formatFullMeal(m: FullMeal): string {
  const head = `${m.name}${m.area || m.category ? ` (${[m.area, m.category].filter(Boolean).join(", ")})` : ""}`;
  const ing = m.ingredients.length ? `\n\nIngredients:\n${m.ingredients.map((i) => `• ${i}`).join("\n")}` : "";
  const steps = m.instructions ? `\n\nSteps: ${m.instructions.slice(0, 900)}${m.instructions.length > 900 ? "…" : ""}` : "";
  const src = m.source ? `\n\nSource: ${m.source}` : "";
  return `${head}${ing}${steps}${src}`;
}

/**
 * Answer a meal request. `fetchText` is injected. Returns either a list of ideas (ingredient/random →
 * with the resolved ingredient) or a full recipe (dish), or null on a miss / fetch failure. Exported
 * for the tool dispatch.
 */
export async function getMeals(
  req: { kind: "ingredient"; ingredient: string } | { kind: "dish"; name: string } | { kind: "random" },
  fetchText: (url: string) => Promise<string>,
): Promise<{ ideas: MealIdea[]; ingredient?: string } | { meal: FullMeal } | null> {
  try {
    if (req.kind === "dish") {
      const meal = parseFullMeal(await fetchText(searchByNameUrl(req.name)));
      return meal ? { meal } : null;
    }
    if (req.kind === "random") {
      const meal = parseFullMeal(await fetchText(randomMealUrl));
      // A random pick returns the FULL recipe — more useful than a bare name.
      return meal ? { meal } : null;
    }
    const ideas = parseMealIdeas(await fetchText(filterByIngredientUrl(req.ingredient)));
    return ideas.length ? { ideas, ingredient: req.ingredient } : null;
  } catch { return null; }
}
