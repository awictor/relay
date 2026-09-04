// Number-base conversion (number-base-convert): "255 in binary", "0xFF to decimal", "convert 42 to octal",
// "0b1010 in hex" is a common dev/learning ask with no home — calc.ts is base-10 arithmetic (chokes on
// "0xFF"/"in binary"), and encode_decode does hex of TEXT, not integer bases. This parses an integer in
// dec/hex/bin/oct + a target base and converts exactly. Pure; no key, no network. Exported for the tool.

export interface BaseResult { value: number; from: number; to: number; out: string; }

const BASE_WORDS: Record<string, number> = {
  binary: 2, bin: 2, base2: 2, "base 2": 2,
  octal: 8, oct: 8, base8: 8, "base 8": 8,
  decimal: 10, dec: 10, denary: 10, base10: 10, "base 10": 10,
  hex: 16, hexadecimal: 16, base16: 16, "base 16": 16,
};

/** Parse a target base name/number from text -> 2/8/10/16, or null. Exported. */
export function parseTargetBase(text: string): number | null {
  const t = text.toLowerCase();
  // Prefer the base named AFTER a "to"/"in"/"into"/"as" — that's the TARGET, even when another base word
  // appears earlier as the SOURCE ("1010 binary TO decimal": target is decimal, not the leading binary)
  // (numbase-adjacent-source-base). Fall back to a first-match scan when there's no directional cue.
  const after = t.match(/\b(?:to|in|into|as)\s+(.*)$/);
  const scan = (s: string): number | null => {
    let best: { base: number; idx: number } | null = null;
    for (const [word, base] of Object.entries(BASE_WORDS)) {
      const mm = s.match(new RegExp(`\\b${word.replace(" ", "\\s+")}\\b`));
      if (mm && (best === null || mm.index! < best.idx)) best = { base, idx: mm.index! };
    }
    const bm = s.match(/\bbase\s*(\d{1,2})\b/);
    if (bm && [2, 8, 10, 16].includes(+bm[1]!) && (best === null || bm.index! < best.idx)) best = { base: +bm[1]!, idx: bm.index! };
    return best ? best.base : null;
  };
  if (after) { const b = scan(after[1]!); if (b !== null) return b; }
  return scan(t);
}

/** Parse the source integer + its base from a token: 0x-prefixed hex, 0b binary, 0o/0-prefixed octal, or
 * plain decimal. Returns { value, base } or null. Exported. */
export function parseSourceNumber(text: string): { value: number; base: number } | null {
  const t = text.toLowerCase();
  let m = t.match(/\b0x([0-9a-f]+)\b/);
  if (m) return { value: parseInt(m[1]!, 16), base: 16 };
  m = t.match(/\b0b([01]+)\b/);
  if (m) return { value: parseInt(m[1]!, 2), base: 2 };
  m = t.match(/\b0o([0-7]+)\b/);
  if (m) return { value: parseInt(m[1]!, 8), base: 8 };
  // A base word IMMEDIATELY AFTER the number ("1010 binary to decimal", "FF hex to dec", "52 octal") names
  // its SOURCE base — the number is IN that base, not decimal (numbase-adjacent-source-base). This must be
  // checked BEFORE the plain-decimal fallback, or "1010 binary" was read as decimal-1010 and converted the
  // wrong way. A base word after "in"/"to" ("255 in binary") is the TARGET and is NOT adjacent, so it's
  // excluded by requiring the word to directly follow the digits (optional whitespace only).
  const adj = t.match(/\b([0-9a-f]+)\s*(hex(?:adecimal)?|binary|bin|octal|oct)\b/);
  if (adj && !/\b(?:in|to|into|as)\s+$/.test(t.slice(0, adj.index))) {
    const word = adj[2]!;
    const base = word.startsWith("hex") ? 16 : word.startsWith("bin") ? 2 : 8;
    const digits = adj[1]!;
    if (new RegExp(`^[0-${base === 2 ? 1 : base === 8 ? 7 : "9a-f"}]+$`, "i").test(digits)) {
      return { value: parseInt(digits, base), base };
    }
  }
  // "FF in hex" / "1010 in binary" — a bare token whose SOURCE base is named alongside it.
  const srcHex = /\bhex(?:adecimal)?\b/.test(t), srcBin = /\bbinary\b|\bbin\b/.test(t), srcOct = /\boctal\b|\boct\b/.test(t);
  // A plain decimal integer (the common "255 in binary" case — 255 is decimal).
  m = t.match(/(?:^|[^0-9a-fx])(\d+)\b/);
  if (m) return { value: parseInt(m[1]!, 10), base: 10 };
  // A bare hex-ish token only when hex is explicitly named ("FF in decimal").
  if (srcHex) { const h = t.match(/\b([0-9a-f]+)\b/); if (h) return { value: parseInt(h[1]!, 16), base: 16 }; }
  if (srcBin) { const bb = t.match(/\b([01]+)\b/); if (bb) return { value: parseInt(bb[1]!, 2), base: 2 }; }
  if (srcOct) { const o = t.match(/\b([0-7]+)\b/); if (o) return { value: parseInt(o[1]!, 8), base: 8 }; }
  return null;
}

/** Render an integer in a base with the conventional prefix (0x/0b/0o; none for decimal). Exported. */
export function renderBase(value: number, base: number): string {
  const digits = value.toString(base);
  if (base === 16) return "0x" + digits.toUpperCase();
  if (base === 2) return "0b" + digits;
  if (base === 8) return "0o" + digits;
  return digits;
}

/**
 * Convert a free-text number-base request ("255 in binary", "0xFF to decimal") into a result, or null
 * when a source number or target base can't be read, or the value isn't a non-negative integer. Exported.
 */
export function runNumberBase(text: string): BaseResult | null {
  const to = parseTargetBase(text);
  if (to === null) return null;
  const src = parseSourceNumber(text);
  if (!src || !Number.isFinite(src.value) || src.value < 0 || !Number.isInteger(src.value)) return null;
  return { value: src.value, from: src.base, to, out: renderBase(src.value, to) };
}

const BASE_NAME: Record<number, string> = { 2: "binary", 8: "octal", 10: "decimal", 16: "hex" };

/** Format a base conversion into a short line. Exported. */
export function formatNumberBase(r: BaseResult): string {
  return `${renderBase(r.value, r.from)} (${BASE_NAME[r.from]}) = ${r.out} (${BASE_NAME[r.to]}).`;
}
