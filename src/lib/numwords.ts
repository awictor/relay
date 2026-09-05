// Number-to-words (number-to-words): "spell out 1234", "write 1,250.50 in words", "how do you say 42 in
// words" — a check-writing / form-filling everyday ask with no home. calc.ts computes; nothing spells a
// number out. This converts a non-negative number (0..999,999,999,999 = up to hundreds of billions) to
// English words, with a cents form for a money amount ("$1,250.50" -> "... and 50/100"). Pure; no key.
// Exported for the tool + unit-tested.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", " thousand", " million", " billion"]; // index i -> 1000^i

/** Words for a whole number 0..999 (no scale suffix). */
function under1000(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? "-" + ONES[n % 10]! : "");
  const h = Math.floor(n / 100), rest = n % 100;
  return ONES[h]! + " hundred" + (rest ? " " + under1000(rest) : "");
}

/** A non-negative integer (0..999,999,999,999) to English words, or null out of range / non-integer.
 * Exported for tests. */
export function intToWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999_999) return null;
  if (n === 0) return "zero";
  const groups: number[] = []; // least-significant group of 3 first
  let v = n;
  while (v > 0) { groups.push(v % 1000); v = Math.floor(v / 1000); }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue;
    parts.push(under1000(groups[i]!) + SCALES[i]!);
  }
  return parts.join(" ");
}

/** Spell a number out. A whole number -> plain words. A decimal with exactly 2 places reads as a money/
 * cents form ("one thousand two hundred fifty and 50/100") — the check-writing convention. Other decimals
 * read as "<int> point <digit words>". Returns null when out of range / not a number. Exported for tests. */
export function numberToWords(value: number, opts: { cents?: boolean } = {}): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const whole = Math.floor(value);
  const words = intToWords(whole);
  if (words === null) return null;
  // Money/cents form ("... and NN/100") ONLY on an explicit money request (opts.cents) — a bare 2-decimal
  // like "3.14" is NOT money (that's pi -> "point one four"), so it must NOT default to the cents form.
  if (opts.cents && value !== whole) {
    const cents = Math.round((value - whole) * 100);
    return `${words} and ${String(cents).padStart(2, "0")}/100`;
  }
  // A longer/odd fraction reads digit-by-digit after "point".
  if (value !== whole) {
    const frac = String(value).split(".")[1] ?? "";
    const digits = frac.split("").map((d) => ONES[Number(d)]!).join(" ");
    return `${words} point ${digits}`;
  }
  return words;
}

/** Parse a free-text "spell out N" / "N in words" request into the words, or null if it isn't one.
 * Handles "spell out 1234", "write 1,250.50 in words", "how do you say 42 in words", "1000 in words",
 * "put $99.99 in words". A "$" (or the 2-decimal shape) triggers the cents/check form. Exported for the tool. */
export function runNumWords(text: string): string | null {
  const t = text.trim();
  // Must read like a number-in-words ask (a cue word), so a bare "1234" isn't hijacked from calc/others.
  if (!/\b(?:in\s+words|spell(?:ed)?\s+out|spell\s+it|write\s+(?:it\s+)?(?:out|in\s+words)|say\s+.*\bin\s+words|number\s+to\s+words|words?\s+for)\b/i.test(t)
      && !/\bspell\s+out\b/i.test(t)) return null;
  // Pull the number (allow $ + thousands commas + a decimal).
  const m = t.match(/\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/);
  if (!m) return null;
  const hasDollar = /\$/.test(t);
  const numStr = m[1]!.replace(/,/g, "");
  const value = parseFloat(numStr);
  const words = numberToWords(value, { cents: hasDollar && numStr.includes(".") });
  if (words === null) return `I can only spell out whole numbers up to a few hundred billion.`;
  // Capitalize the first letter for a check-style reply.
  const cap = words.charAt(0).toUpperCase() + words.slice(1);
  return hasDollar ? `${cap} dollars.` : `${cap}.`;
}
