// Unit-price "better buy" comparison (unit-price-compare): "which is cheaper, 500g for $4 or 1.2kg for
// $9?" / "$3.99 for 12oz vs $5.49 for 20oz" has no owner — calculate does raw arithmetic + convert_units
// converts measures, but nothing normalizes mixed units to price-per-unit and names the winner, so the
// agent hand-normalizes (the silently-wrong mental math the prompt forbids). This is a DETERMINISTIC
// per-unit comparator: parse the (qty, unit, price) options, reduce each to a common base via
// units-convert's toBaseAmount, compute price-per-base, declare the cheaper. Pure; unit-tested.

import { toBaseAmount } from "./units-convert.js";

export interface PriceOption { qty: number; unit: string; price: number; base: number; dim: string; perBase: number; }

// Parse one "<qty><unit> for $<price>" / "$<price> for <qty><unit>" / "$<price> / <qty><unit>" option.
// Returns {qty, unit, price} or null. `unit` may be empty (a bare count like "12 for $6").
function parseOption(s: string): { qty: number; unit: string; price: number } | null {
  // Normalize a "6-pack"/"12-pack" hyphen to a space so the qty+unit split reads it (unitprice-hyphen-pack):
  // the grocery/retail phrasing "6-pack $5" otherwise failed the qty regex + fell to the model's mental math.
  const t = s.trim().replace(/[,]/g, "").replace(/(\d)\s*-\s*(pack|pk|ct|count|pc|pcs|piece|pieces)\b/gi, "$1 $2");
  const priceRe = /\$?\s*(\d+(?:\.\d+)?)/;
  // Form A: "<qty><unit> for/at/@ $<price>"  e.g. "500g for $4", "12 oz @ 3.99", "1.2kg at $9"
  let m = t.match(/^(\d+(?:\.\d+)?)\s*([a-z ]*?)\s*(?:for|at|@|=|is|costs?)\s*\$?\s*(\d+(?:\.\d+)?)$/i);
  if (m) return { qty: parseFloat(m[1]!), unit: m[2]!.trim(), price: parseFloat(m[3]!) };
  // Form A2: connector-less "<qty><unit> $<price>"  e.g. "12 rolls $6", "20 oz $3.99", "500g $4". A natural
  // grocery/shelf phrasing that Form A's required connector (for/at/@) missed, so it silently fell to the
  // agent's forbidden mental math (unitprice-spaceless-price). Requires the price to be $-prefixed so a
  // bare "12 rolls 6" (ambiguous — is 6 a price or a second qty?) still needs an explicit connector.
  m = t.match(/^(\d+(?:\.\d+)?)\s*([a-z ]*?)\s+\$\s*(\d+(?:\.\d+)?)$/i);
  if (m) return { qty: parseFloat(m[1]!), unit: m[2]!.trim(), price: parseFloat(m[3]!) };
  // Form B: "$<price> for <qty><unit>"  or  "$<price> / <qty><unit>"  e.g. "$4 for 500g", "$5.49/20oz"
  m = t.match(/^\$?\s*(\d+(?:\.\d+)?)\s*(?:for|per|\/|a)\s*(\d+(?:\.\d+)?)\s*([a-z ]*)$/i);
  if (m) return { qty: parseFloat(m[2]!), unit: m[3]!.trim(), price: parseFloat(m[1]!) };
  // Form C: "$<price> / <unit>" with an implied qty of 1  e.g. "$4/kg", "$0.99 per lb"
  m = t.match(/^\$?\s*(\d+(?:\.\d+)?)\s*(?:\/|per|a)\s*([a-z ]+)$/i);
  if (m) return { qty: 1, unit: m[2]!.trim(), price: parseFloat(m[1]!) };
  return null;
}

/** Parse a free-text "better buy" question into its options (2+), or null if it isn't one. Splits on
 * "or"/"vs"/","/";" and requires each part to parse to qty+unit+price. Exported for tests. */
export function parseUnitPrice(text: string): Array<{ qty: number; unit: string; price: number }> | null {
  // Strip thousands-separator commas (a comma BETWEEN digits) FIRST (unitprice-thousands-comma): otherwise
  // the "," option separator below splits "$1,299 for 3" into "$1" + "299 for 3" — both unparseable — so
  // a bulk/electronics compare with a 4-digit price silently fell to the model's mental math.
  const t = text.trim().replace(/[?.!]+$/, "").replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "")
    .replace(/^\s*(which(?:'s| is)?\s+(?:cheaper|(?:the\s+)?better (?:buy|deal|value)|(?:the\s+)?best (?:buy|deal|value))|better (?:buy|deal|value)|best (?:buy|deal|value)|cheaper|compare)\b[:,]?\s*/i, "");
  const parts = t.split(/\s+(?:or|vs\.?|versus)\s+|\s*[;,]\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const opts = parts.map(parseOption);
  if (opts.some((o) => o === null)) return null;
  return opts as Array<{ qty: number; unit: string; price: number }>;
}

/** Compare parsed options by price-per-base-unit. Returns the enriched options (in input order) + the
 * index of the cheapest, or null if any unit is unknown or they mix dimensions (can't compare g vs ml).
 * Exported for tests. */
export function compareUnitPrice(raw: Array<{ qty: number; unit: string; price: number }>): { options: PriceOption[]; cheapest: number } | null {
  const options: PriceOption[] = [];
  for (const o of raw) {
    if (!(o.price > 0) || !(o.qty > 0)) return null;
    const b = toBaseAmount(o.qty, o.unit);
    if (!b || b.base <= 0) return null;
    options.push({ ...o, base: b.base, dim: b.dim, perBase: o.price / b.base });
  }
  // All options must share a dimension (comparing $/g to $/ml is meaningless).
  if (new Set(options.map((o) => o.dim)).size !== 1) return null;
  let cheapest = 0;
  for (let i = 1; i < options.length; i++) if (options[i]!.perBase < options[cheapest]!.perBase) cheapest = i;
  return { options, cheapest };
}

// Human per-unit label for a dimension's base (g->per 100g, ml->per 100ml/L, m->per m, count->each).
function perUnitLabel(dim: string): { factor: number; label: string } {
  if (dim === "mass") return { factor: 100, label: "per 100g" };
  if (dim === "volume") return { factor: 100, label: "per 100ml" };
  if (dim === "length") return { factor: 1, label: "per m" };
  return { factor: 1, label: "each" }; // count
}

/** Format a "better buy" answer: names the cheaper option + shows each option's normalized per-unit price.
 * Exported for tests. */
export function formatUnitPrice(r: { options: PriceOption[]; cheapest: number }): string {
  const { options, cheapest } = r;
  const { factor, label } = perUnitLabel(options[0]!.dim);
  const line = (o: PriceOption, i: number) => {
    const per = (o.perBase * factor).toFixed(2);
    const opt = `$${o.price.toFixed(2)} for ${o.qty}${o.unit ? o.unit : ""}`.replace(/\s+$/, "");
    return `${i === cheapest ? "✅ " : "• "}${opt} = $${per} ${label}`;
  };
  const win = options[cheapest]!;
  const others = options.filter((_, i) => i !== cheapest);
  // Cheapest of the OTHERS (the runner-up), so a 3+ way compare still reports a savings vs the next-best,
  // not just the 2-way case (unitprice-three-way-and-percent-savings).
  const runnerUp = others.reduce<PriceOption | null>((best, o) => (best === null || o.perBase < best.perBase ? o : best), null);
  // A dead TIE (every option is the same price per unit) has no better buy — saying "0% cheaper" + ✅-ing
  // an arbitrary one misleads. Report the tie honestly instead.
  const allTied = options.every((o) => Math.abs(o.perBase - win.perBase) < 1e-9);
  if (allTied) {
    const per = (win.perBase * factor).toFixed(2);
    return `Same price either way — both work out to $${per} ${label}:\n${options.map((o, i) => "• " + line(o, i).slice(2)).join("\n")}`;
  }
  const pct = runnerUp && runnerUp.perBase > 0 ? Math.round((1 - win.perBase / runnerUp.perBase) * 100) : 0;
  // "X% cheaper" vs the runner-up; name it as "than the next-best" only when there are 3+ so it's clear
  // what the comparison is against.
  const cheaperBy = pct > 0 ? ` (${pct}% cheaper${others.length > 1 ? " than the next-best" : ""})` : "";
  return `Better buy${cheaperBy}:\n${options.map(line).join("\n")}`;
}

/** One-shot: parse + compare + format a "better buy" question, or null if it isn't one / can't compare.
 * Exported for the tool dispatch. */
export function runUnitPrice(text: string): string | null {
  const parsed = parseUnitPrice(text);
  if (!parsed) return null;
  const cmp = compareUnitPrice(parsed);
  if (!cmp) return null;
  return formatUnitPrice(cmp);
}
