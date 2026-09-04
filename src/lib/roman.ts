// Roman numeral conversion (roman-numerals): "42 in roman numerals", "MMXXIV to a number" is a common
// learning/quiz ask with no home — calc.ts chokes on "MMXXIV" and get_fact is overkill. This converts
// both directions for standard Roman numerals (1..3999). Pure; no key. Exported for the tool.

const PAIRS: Array<[number, string]> = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
  [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

/** Integer (1..3999) -> Roman numeral, or null out of range / non-integer. Exported. */
export function toRoman(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 3999) return null;
  let out = "";
  let v = n;
  for (const [val, sym] of PAIRS) { while (v >= val) { out += sym; v -= val; } }
  return out;
}

// Canonical single/double-char values, longest-first, for parsing.
const VAL: Record<string, number> = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };

/** Roman numeral -> integer, or null if it isn't a well-formed standard numeral. Validates by round-trip
 * (parse, then re-encode and compare) so malformed input ("IIII", "IC", "VV") is rejected, not silently
 * mis-summed. Case-insensitive. Exported. */
export function fromRoman(s: string): number | null {
  const r = String(s ?? "").trim().toUpperCase();
  if (!r || !/^[MDCLXVI]+$/.test(r)) return null;
  let total = 0;
  for (let i = 0; i < r.length; i++) {
    const cur = VAL[r[i]!]!;
    const next = i + 1 < r.length ? VAL[r[i + 1]!]! : 0;
    total += cur < next ? -cur : cur;
  }
  if (total < 1 || total > 3999) return null;
  // Reject non-canonical forms (e.g. "IIII" -> 4 but canonical is "IV") by requiring a round-trip.
  return toRoman(total) === r ? total : null;
}

/** Parse a free-text request into a formatted conversion line, or null if it isn't a roman-numeral ask.
 * Handles "<int> in roman numerals" and "<ROMAN> to a number" (either direction). Exported for the tool. */
export function runRoman(text: string): string | null {
  const t = text.trim();
  // A Roman token present -> decode to a number.
  const rm = t.toUpperCase().match(/\b([MDCLXVI]{1,15})\b/);
  const wantsRoman = /\broman\b/i.test(t);
  // Integer present -> encode (when the ask mentions roman, or there's no roman token to decode).
  const im = t.match(/\b(\d{1,4})\b/);
  if (im && (wantsRoman || !rm)) {
    const n = Number(im[1]);
    const roman = toRoman(n);
    return roman ? `${n} in Roman numerals is ${roman}.` : `Roman numerals only cover 1–3999, so I can't write ${n}.`;
  }
  if (rm) {
    const n = fromRoman(rm[1]!);
    return n !== null ? `${rm[1]!.toUpperCase()} is ${n}.` : `"${rm[1]}" isn't a valid Roman numeral.`;
  }
  return null;
}
