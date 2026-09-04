// Unit/measure conversion (unit-convert-tool): "180C to F", "5 foot 11 in cm", "2 cups of flour in
// grams", "10 miles in km", "3 lb in kg" is a daily cooking/travel/DIY errand — but the only convert
// tool is currency, so these fell to the model answering from memory (the SYSTEM_PROMPT literally seeds
// "oz in a cup = 8" and warns mental math is silently wrong for anything multi-step). This is a
// DETERMINISTIC converter over fixed factor tables (no network, no LLM), mirroring convert_currency.
// Pure parse + convert helpers exported + unit-tested.

type Dim = "length" | "mass" | "volume" | "temperature" | "data";
interface Unit { dim: Dim; toBase: number; base?: boolean; label: string; }

// Each unit maps to a base (length=meter, mass=gram, volume=milliliter) by a multiply factor. Temperature
// is affine (offset), handled specially below. Keys are normalized (lowercased, singularized) aliases.
const UNITS: Record<string, Unit> = {
  // length (base: meter)
  mm: { dim: "length", toBase: 0.001, label: "mm" }, millimeter: { dim: "length", toBase: 0.001, label: "mm" },
  cm: { dim: "length", toBase: 0.01, label: "cm" }, centimeter: { dim: "length", toBase: 0.01, label: "cm" },
  m: { dim: "length", toBase: 1, base: true, label: "m" }, meter: { dim: "length", toBase: 1, base: true, label: "m" }, metre: { dim: "length", toBase: 1, label: "m" },
  km: { dim: "length", toBase: 1000, label: "km" }, kilometer: { dim: "length", toBase: 1000, label: "km" }, kilometre: { dim: "length", toBase: 1000, label: "km" },
  in: { dim: "length", toBase: 0.0254, label: "in" }, inch: { dim: "length", toBase: 0.0254, label: "in" }, inche: { dim: "length", toBase: 0.0254, label: "in" },
  ft: { dim: "length", toBase: 0.3048, label: "ft" }, foot: { dim: "length", toBase: 0.3048, label: "ft" }, feet: { dim: "length", toBase: 0.3048, label: "ft" },
  yd: { dim: "length", toBase: 0.9144, label: "yd" }, yard: { dim: "length", toBase: 0.9144, label: "yd" },
  mi: { dim: "length", toBase: 1609.344, label: "mi" }, mile: { dim: "length", toBase: 1609.344, label: "mi" },
  // mass (base: gram)
  mg: { dim: "mass", toBase: 0.001, label: "mg" }, milligram: { dim: "mass", toBase: 0.001, label: "mg" },
  g: { dim: "mass", toBase: 1, base: true, label: "g" }, gram: { dim: "mass", toBase: 1, base: true, label: "g" }, gramme: { dim: "mass", toBase: 1, label: "g" },
  kg: { dim: "mass", toBase: 1000, label: "kg" }, kilogram: { dim: "mass", toBase: 1000, label: "kg" }, kilo: { dim: "mass", toBase: 1000, label: "kg" },
  oz: { dim: "mass", toBase: 28.3495, label: "oz" }, ounce: { dim: "mass", toBase: 28.3495, label: "oz" },
  lb: { dim: "mass", toBase: 453.592, label: "lb" }, lbs: { dim: "mass", toBase: 453.592, label: "lb" }, pound: { dim: "mass", toBase: 453.592, label: "lb" },
  st: { dim: "mass", toBase: 6350.29, label: "st" }, stone: { dim: "mass", toBase: 6350.29, label: "st" },
  // volume (base: milliliter)
  ml: { dim: "volume", toBase: 1, base: true, label: "ml" }, milliliter: { dim: "volume", toBase: 1, base: true, label: "ml" }, millilitre: { dim: "volume", toBase: 1, label: "ml" },
  l: { dim: "volume", toBase: 1000, label: "L" }, liter: { dim: "volume", toBase: 1000, label: "L" }, litre: { dim: "volume", toBase: 1000, label: "L" },
  tsp: { dim: "volume", toBase: 4.92892, label: "tsp" }, teaspoon: { dim: "volume", toBase: 4.92892, label: "tsp" },
  tbsp: { dim: "volume", toBase: 14.7868, label: "tbsp" }, tablespoon: { dim: "volume", toBase: 14.7868, label: "tbsp" },
  cup: { dim: "volume", toBase: 236.588, label: "cup" }, cups: { dim: "volume", toBase: 236.588, label: "cup" },
  "fl oz": { dim: "volume", toBase: 29.5735, label: "fl oz" }, floz: { dim: "volume", toBase: 29.5735, label: "fl oz" },
  pint: { dim: "volume", toBase: 473.176, label: "pt" }, pt: { dim: "volume", toBase: 473.176, label: "pt" },
  quart: { dim: "volume", toBase: 946.353, label: "qt" }, qt: { dim: "volume", toBase: 946.353, label: "qt" },
  gal: { dim: "volume", toBase: 3785.41, label: "gal" }, gallon: { dim: "volume", toBase: 3785.41, label: "gal" },
  // digital storage (base: byte). Binary factors (1 KB = 1024 B) — the convention people mean by "how
  // many GB is 500 MB" (data-unit-convert). "b"/"bit" deliberately omitted: "MB" vs "Mb" (bytes vs bits)
  // is a common confusion, and every alias here is BYTES, so a bare token can't silently mean bits.
  byte: { dim: "data", toBase: 1, base: true, label: "B" }, bytes: { dim: "data", toBase: 1, base: true, label: "B" },
  kb: { dim: "data", toBase: 1024, label: "KB" }, kilobyte: { dim: "data", toBase: 1024, label: "KB" }, kilobytes: { dim: "data", toBase: 1024, label: "KB" },
  mb: { dim: "data", toBase: 1024 ** 2, label: "MB" }, megabyte: { dim: "data", toBase: 1024 ** 2, label: "MB" }, megabytes: { dim: "data", toBase: 1024 ** 2, label: "MB" },
  gb: { dim: "data", toBase: 1024 ** 3, label: "GB" }, gigabyte: { dim: "data", toBase: 1024 ** 3, label: "GB" }, gigabytes: { dim: "data", toBase: 1024 ** 3, label: "GB" },
  tb: { dim: "data", toBase: 1024 ** 4, label: "TB" }, terabyte: { dim: "data", toBase: 1024 ** 4, label: "TB" }, terabytes: { dim: "data", toBase: 1024 ** 4, label: "TB" },
  pb: { dim: "data", toBase: 1024 ** 5, label: "PB" }, petabyte: { dim: "data", toBase: 1024 ** 5, label: "PB" },
};
// Temperature units (affine). Handled outside the factor table.
const TEMP = new Set(["c", "celsius", "centigrade", "f", "fahrenheit", "k", "kelvin"]);

/** Normalize a unit token: lowercase, strip a trailing plural s (except known -s aliases), map symbols. */
export function normalizeUnit(raw: string): string {
  let u = String(raw ?? "").toLowerCase().trim().replace(/\.$/, "");
  u = u.replace(/^°/, "").replace(/degrees?\s+/, "");
  const TEMP_ALIAS: Record<string, string> = { "°c": "c", celsius: "c", centigrade: "c", "°f": "f", fahrenheit: "f", kelvin: "k" };
  const alias = TEMP_ALIAS[u];
  if (alias) return alias;
  if (u in UNITS || TEMP.has(u)) return u;
  // singularize ("inches"->"inche"? no — try dropping trailing s)
  if (u.endsWith("s") && (u.slice(0, -1) in UNITS)) return u.slice(0, -1);
  return u;
}

/** Reduce an amount+unit to its base quantity + dimension (length=m, mass=g, volume=ml), for cross-size
 * comparison like unit pricing (unit-price-compare). Returns null for an unknown or temperature unit
 * (no meaningful "per unit" price). A bare "oz"/"ounce" is MASS here (a package weight); "fl oz" is
 * volume. `count`/"ct"/"pack"/"each" map to a dimensionless COUNT dim so "12 for $6" compares per-item.
 * Exported for the unit-price tool. */
export function toBaseAmount(amount: number, unit: string): { base: number; dim: string } | null {
  if (!Number.isFinite(amount)) return null;
  const u = normalizeUnit(unit);
  if (/^(ct|count|counts|pack|packs|pk|each|ea|item|items|unit|units|piece|pieces|roll|rolls|ct\.)$/.test(u) || u === "") {
    return { base: amount, dim: "count" }; // dimensionless per-item
  }
  const uu = UNITS[u];
  if (!uu) return null; // unknown or temperature -> no unit price
  return { base: amount * uu.toBase, dim: uu.dim };
}

const cToBase = (v: number, u: string) => u === "f" ? (v - 32) * 5 / 9 : u === "k" ? v - 273.15 : v; // -> Celsius
const cFromBase = (c: number, u: string) => u === "f" ? c * 9 / 5 + 32 : u === "k" ? c + 273.15 : c;

/** Convert `amount` from unit `from` to unit `to`, or null if the units are unknown or different
 * dimensions (can't convert kg to miles). Exported for tests. */
export function convertUnit(amount: number, from: string, to: string): { value: number; fromLabel: string; toLabel: string } | null {
  const f = normalizeUnit(from), t = normalizeUnit(to);
  if (!Number.isFinite(amount)) return null;
  if (TEMP.has(f) && TEMP.has(t)) {
    const value = cFromBase(cToBase(amount, f), t);
    const lbl = (u: string) => u === "f" ? "°F" : u === "k" ? "K" : "°C";
    return { value, fromLabel: lbl(f), toLabel: lbl(t) };
  }
  let uf = UNITS[f], ut = UNITS[t];
  // Cooking "oz" is ambiguous: bare "oz"/"ounce" maps to MASS, but "1 cup to oz" / "8 oz to cups" means
  // FLUID ounces (units-cup-to-oz-crosstype — the canonical kitchen conversion the tool exists for). When
  // exactly one side is volume and the other is a bare oz (mass), reinterpret that oz as fluid ounce.
  const FL_OZ = UNITS["fl oz"]!;
  const isBareOz = (u: string) => u === "oz" || u === "ounce";
  if (uf && ut) {
    if (uf.dim === "volume" && ut.dim === "mass" && isBareOz(t)) ut = FL_OZ;
    else if (ut.dim === "volume" && uf.dim === "mass" && isBareOz(f)) uf = FL_OZ;
  }
  if (!uf || !ut || uf.dim !== ut.dim) return null; // unknown, or a genuine cross-dimension (kg->miles)
  return { value: (amount * uf.toBase) / ut.toBase, fromLabel: uf.label, toLabel: ut.label };
}

/** Parse a "convert" request into { amount, from, to } or null. Handles:
 *   "180C to F", "convert 10 miles to km", "5 ft 11 in in cm", "2 cups of flour in grams", "3 lb in kg".
 * A compound imperial length ("5 ft 11 in") is summed. "of <thing>" is ignored. Exported for tests. */
export function parseUnitConvert(text: string): { amount: number; from: string; to: string } | null {
  // Strip a leading "convert" + a trailing politeness/punctuation ("... to lbs please" / "... in cm?"):
  // otherwise the trailing word became part of the target unit ("lbs please") and the conversion failed
  // on an unknown unit (unit-convert-trailing-please).
  const t = text.trim().replace(/^convert\s+/i, "").replace(/\s+(?:please|thanks|thx|pls)\s*$/i, "").replace(/[?.!]+$/g, "").trim();
  // Compound feet+inches: "5 ft 11 in" / "5'11\"" / "5 foot 11" -> total inches.
  const compound = t.match(/(\d+(?:\.\d+)?)\s*(?:ft|foot|feet|')\s*(\d+(?:\.\d+)?)\s*(?:in|inch(?:es)?|")?\s+(?:in|into|to)\s+([a-z]+)/i);
  if (compound) {
    const totalIn = parseFloat(compound[1]!) * 12 + parseFloat(compound[2]!);
    return { amount: totalIn, from: "in", to: compound[3]!.trim() };
  }
  // Standard: "<amount> <from> [of X] (to|in|into) <to>". Temp allows a °/no-space form ("180C to F").
  const m = t.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([a-z][a-z ]*?)\s+(?:of\s+[a-z ]+\s+)?(?:in ?to|into|to|in)\s+°?\s*([a-z][a-z ]*?)\s*$/i);
  if (!m) return null;
  const amount = parseFloat(m[1]!);
  const from = m[2]!.trim(), to = m[3]!.trim();
  if (!from || !to) return null;
  return { amount, from, to };
}

/** Format a conversion result: trims to a sensible precision, keeps integers clean. Exported. */
export function formatConvert(amount: number, from: string, to: string, r: { value: number; fromLabel: string; toLabel: string }): string {
  const fmt = (n: number) => {
    const abs = Math.abs(n);
    const dp = abs !== 0 && abs < 1 ? 4 : abs < 100 ? 2 : abs < 10000 ? 1 : 0;
    return Number(n.toFixed(dp)).toLocaleString("en-US");
  };
  return `${fmt(amount)} ${r.fromLabel} = ${fmt(r.value)} ${r.toLabel}`;
}

/** One-shot: parse + convert a free-text request into a formatted line, or null. Exported for the tool. */
export function runConvert(text: string): string | null {
  const p = parseUnitConvert(text);
  if (!p) return null;
  const r = convertUnit(p.amount, p.from, p.to);
  if (!r) return null;
  return formatConvert(p.amount, p.from, p.to, r);
}
