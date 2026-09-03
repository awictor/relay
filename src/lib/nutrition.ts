// Nutrition lookup (nutrition-lookup): "calories in a banana", "carbs in a Big Mac", "protein in
// chicken breast" is a daily errand Relay answered by web_search guesswork or invented figures (worse
// than "not sure"). This hits the KEYLESS USDA FoodData Central search (the public DEMO_KEY works with
// no signup; set USDA_API_KEY for a higher rate limit) for the closest food + its per-100g macros.
// Pure parse/format helpers exported + unit-tested; the network fetch is injected. Mirrors dictionary.ts.

export interface Nutrition {
  food: string;        // the matched food's description (so a wrong match is visible)
  kcal?: number;       // per 100 g
  proteinG?: number;
  carbG?: number;
  fatG?: number;
}

// DEMO_KEY is USDA's public rate-limited key (no signup needed to try). A deploy can set USDA_API_KEY
// for a real quota. Read at call time so a test/env can override.
function usdaKey(): string {
  return process.env.USDA_API_KEY || "DEMO_KEY";
}

/** The keyless USDA FoodData Central search URL for a food query. Restricts to the whole-food /
 * generic datasets (Foundation, SR Legacy, Survey/FNDDS) so a plain "banana" doesn't return a random
 * branded product; page_size 1 = the top match. Exported for tests. */
export function nutritionUrl(query: string, key = usdaKey()): string {
  const q = encodeURIComponent(query.trim());
  const types = encodeURIComponent("Foundation,SR Legacy,Survey (FNDDS)");
  return `https://api.nal.usda.gov/fdc/v1/foods/search?query=${q}&pageSize=1&dataType=${types}&api_key=${encodeURIComponent(key)}`;
}

/** Parse a USDA search response into the top food's per-100g macros, or null (no match / bad shape).
 * USDA returns nutrients as a flat list keyed by name + unit; pick energy(kcal)/protein/carb/fat.
 * Values are per 100 g/ml (the USDA search default basis). Exported. */
export function parseNutrition(body: string): Nutrition | null {
  let obj: { foods?: Array<{ description?: string; foodNutrients?: Array<{ nutrientName?: string; unitName?: string; value?: number }> }> };
  try { obj = JSON.parse(body); } catch { return null; }
  const f = obj.foods?.[0];
  if (!f || !f.description) return null;
  const out: Nutrition = { food: String(f.description) };
  for (const n of f.foodNutrients ?? []) {
    const name = String(n.nutrientName ?? "").toLowerCase();
    const unit = String(n.unitName ?? "").toUpperCase();
    const v = typeof n.value === "number" ? n.value : undefined;
    if (v === undefined) continue;
    // Energy comes in both KCAL and KJ rows. Prefer KCAL; only fall back to a non-KJ energy row when we
    // have no kcal yet (never let a KJ value land in kcal).
    if (name.includes("energy")) { if (unit === "KCAL") out.kcal = v; else if (out.kcal === undefined && unit !== "KJ") out.kcal = v; }
    else if (name === "protein") out.proteinG = v;
    else if (name.startsWith("carbohydrate")) out.carbG = v;
    else if (name === "total lipid (fat)") out.fatG = v;
  }
  // Need at least one macro to be useful; a description with no nutrients is a non-answer.
  if (out.kcal === undefined && out.proteinG === undefined && out.carbG === undefined && out.fatG === undefined) return null;
  return out;
}

/** Format a Nutrition into a short, honest message: the MATCHED food (so a mismatch is visible),
 * per-100g macros, and a note the numbers are per 100 g (portion varies). */
export function formatNutrition(n: Nutrition): string {
  const parts: string[] = [];
  if (n.kcal !== undefined) parts.push(`${Math.round(n.kcal)} kcal`);
  if (n.proteinG !== undefined) parts.push(`${round1(n.proteinG)}g protein`);
  if (n.carbG !== undefined) parts.push(`${round1(n.carbG)}g carbs`);
  if (n.fatG !== undefined) parts.push(`${round1(n.fatG)}g fat`);
  return `${n.food} (per 100g): ${parts.join(", ")}.\nNumbers are per 100 grams — a real portion may differ. Source: USDA FoodData Central.`;
}
function round1(n: number): string { return Number.isInteger(n) ? String(n) : n.toFixed(1); }

/**
 * Look up a food's nutrition. `fetchText` is injected (guarded GET in prod, a fake in tests). Returns
 * the closest match's per-100g macros, or null on no match / fetch failure — the caller then says it's
 * not sure / falls back rather than inventing numbers. Never throws.
 */
export async function getNutrition(
  query: string,
  fetchText: (url: string) => Promise<string>,
): Promise<Nutrition | null> {
  const q = String(query ?? "").trim();
  if (!q) return null;
  try {
    return parseNutrition(await fetchText(nutritionUrl(q)));
  } catch { return null; }
}
