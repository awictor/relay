// BMI calculator (bmi-tool): "what's my BMI at 5'10 and 160 lb?" / "BMI for 70 kg 1.75 m" is a common
// everyday health ask with no home — calc.ts is arithmetic-only (chokes on "bmi ..."), and guessing the
// 703-imperial vs metric formula in prose is error-prone. This parses height + weight in either unit
// system and computes BMI exactly + the WHO category. Pure; no key, no network. Exported for the tool.

export interface BmiResult { bmi: number; category: string; heightM: number; weightKg: number; }

// WHO adult BMI categories.
function category(bmi: number): string {
  if (bmi < 18.5) return "underweight";
  if (bmi < 25) return "a healthy weight";
  if (bmi < 30) return "overweight";
  return "obese";
}

/** Parse a HEIGHT from free text into meters, or null. Accepts: 5'10", 5 ft 10 in, 5'10, 70 in, 175 cm,
 * 1.75 m. A bare number is ambiguous, so a unit (or the '/" feet-inches form) is required. Exported. */
export function parseHeightM(text: string): number | null {
  const t = text.toLowerCase();
  // feet+inches: 5'10", 5 ft 10 in, 5 foot 10, 5'10. Inches are only captured when they're 0-11 AND either
  // followed by an inches unit OR the feet used the ' mark (so "6 foot 200 lb" doesn't read 200 as inches;
  // "6 foot" -> 6.0 ft, and the 200 lb is a weight, not a height). A stray large trailing number is ignored.
  let m = t.match(/(\d+(?:\.\d+)?)\s*'\s*(\d{1,2}(?:\.\d+)?)?\s*"?/);         // 5'10 / 5'10"
  if (!m) m = t.match(/(\d+(?:\.\d+)?)\s*(?:ft|foot|feet)\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|in|inch|inches)\b/); // 5 ft 10 in
  if (!m) m = t.match(/(\d+(?:\.\d+)?)\s*(?:ft|foot|feet)\b/);               // 6 foot (no inches)
  if (m) {
    const ft = parseFloat(m[1]!);
    const rawInch = m[2] ? parseFloat(m[2]!) : 0;
    const inch = Number.isFinite(rawInch) && rawInch < 12 ? rawInch : 0;     // 0-11 only; ignore a bad grab
    if (Number.isFinite(ft)) return (ft * 12 + inch) * 0.0254;
  }
  // metric: 175 cm / 1.75 m
  m = t.match(/(\d+(?:\.\d+)?)\s*cm\b/);
  if (m) return parseFloat(m[1]!) / 100;
  m = t.match(/(\d+(?:\.\d+)?)\s*m(?:eters?|etres?)?\b/);
  if (m) { const v = parseFloat(m[1]!); if (v > 0 && v < 3) return v; } // sanity: 1.75 m, not 175
  // bare inches: "70 in"
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:in|inch|inches)\b/);
  if (m) return parseFloat(m[1]!) * 0.0254;
  return null;
}

/** Parse a WEIGHT from free text into kilograms, or null. Accepts: 160 lb/lbs/pounds, 70 kg/kilos,
 * 11 st (stone) + optional lb. A unit is required (a bare number is ambiguous). Exported. */
export function parseWeightKg(text: string): number | null {
  const t = text.toLowerCase();
  // stone (+ optional pounds): "11 st 4", "11 stone"
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:st|stone)\s*(\d+(?:\.\d+)?)?\s*(?:lb|lbs|pounds?)?/);
  if (m && /\b(?:st|stone)\b/.test(t)) {
    const st = parseFloat(m[1]!); const lb = m[2] ? parseFloat(m[2]!) : 0;
    if (Number.isFinite(st)) return (st * 14 + lb) * 0.453592;
  }
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilos?|kilograms?)\b/);
  if (m) return parseFloat(m[1]!);
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:lb|lbs|pounds?)\b/);
  if (m) return parseFloat(m[1]!) * 0.453592;
  return null;
}

/** Compute BMI from a free-text request naming a height + a weight (either unit system), or null when
 * either can't be parsed. Rounds BMI to 1 dp. Exported for the tool. */
export function runBmi(text: string): BmiResult | null {
  const heightM = parseHeightM(text);
  const weightKg = parseWeightKg(text);
  if (heightM === null || weightKg === null || heightM <= 0 || weightKg <= 0) return null;
  const bmi = Math.round((weightKg / (heightM * heightM)) * 10) / 10;
  if (!Number.isFinite(bmi) || bmi <= 0 || bmi > 500) return null; // guard nonsense inputs
  return { bmi, category: category(bmi), heightM, weightKg };
}

/** Format a BMI result into a short line. Exported. */
export function formatBmi(r: BmiResult): string {
  return `Your BMI is ${r.bmi} — ${r.category} (BMI is a rough screen, not a diagnosis; it doesn't account for muscle or build).`;
}
