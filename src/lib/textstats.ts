// Text utilities (text-stats): "word count of <text>", "how many characters", "reverse this", "is X a
// palindrome" are quick everyday asks with no tool — and an LLM miscounts long text + reverses fiddly
// char-by-char. This does them deterministically. Pure; no key. Exported for the tool.

export type TextOp = "words" | "chars" | "reverse" | "palindrome";

/** Count words: runs of non-whitespace. 0 for empty/whitespace-only. Exported. */
export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Character count. `withSpaces=false` excludes ALL whitespace. Code-point aware (emoji count as 1). */
export function charCount(s: string, withSpaces = true): number {
  const str = withSpaces ? s : s.replace(/\s+/g, "");
  return [...str].length; // spread = code points, so a 👍 or é is one char
}

/** Reverse a string by CODE POINT (so emoji/combined chars don't get mangled). Exported. */
export function reverseText(s: string): string {
  return [...s].reverse().join("");
}

/** Is the text a palindrome, ignoring case + non-alphanumerics ("A man, a plan..." style)? Empty -> false
 * (nothing to check). Exported. */
export function isPalindrome(s: string): boolean {
  const norm = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (!norm) return false;
  return norm === [...norm].reverse().join("");
}

/** Classify the request + extract its payload. The op word comes BEFORE the text ("word count of X",
 * "reverse this: X", "is X a palindrome"). Returns {op, text} or null when it isn't a text-stats ask.
 * Exported. */
export function parseTextStats(request: string): { op: TextOp; text: string } | null {
  const r = request.trim();
  const lower = r.toLowerCase();
  // palindrome: "is <X> a palindrome" / "palindrome check <X>"
  let m = r.match(/\bis\s+(.+?)\s+a\s+palindrome\b/i) || r.match(/\bpalindrome(?:\s*check)?[:\s]+(.+)$/i);
  if (m && /palindrome/i.test(lower)) return { op: "palindrome", text: m[1]!.trim().replace(/^["'`]|["'`]$/g, "") };
  // reverse: "reverse <X>" / "reverse this: X"
  m = r.match(/\breverse(?:\s+(?:this|the text|string))?[:\s]+(.+)$/i);
  if (m) return { op: "reverse", text: m[1]!.trim().replace(/^["'`]|["'`]$/g, "") };
  // char count: "how many characters in X" / "character count of X" / "char count: X"
  m = r.match(/\b(?:how many characters?(?:\s+(?:are\s+)?in)?|characters?\s+count(?:\s+of)?|char\s*count)[:\s]+(.+)$/i);
  if (m && /character|char/i.test(lower)) return { op: "chars", text: m[1]!.trim().replace(/^["'`]|["'`]$/g, "") };
  // word count: "how many words in X" / "word count of X"
  m = r.match(/\b(?:how many words?(?:\s+(?:are\s+)?in)?|words?\s+count(?:\s+of)?|word\s*count)[:\s]+(.+)$/i);
  if (m && /\bword/i.test(lower)) return { op: "words", text: m[1]!.trim().replace(/^["'`]|["'`]$/g, "") };
  return null;
}

/** Run a parsed text-stats op into a formatted answer. Exported for the tool. */
export function runTextStats(request: string): string | null {
  const p = parseTextStats(request);
  if (!p) return null;
  const { op, text } = p;
  if (!text) return null;
  switch (op) {
    case "words": { const n = wordCount(text); return `That's ${n} word${n === 1 ? "" : "s"}.`; }
    case "chars": { const withSp = charCount(text, true); const noSp = charCount(text, false); return `That's ${withSp} character${withSp === 1 ? "" : "s"} (${noSp} without spaces).`; }
    case "reverse": return `Reversed: ${reverseText(text)}`;
    case "palindrome": return isPalindrome(text) ? `Yes — "${text}" is a palindrome.` : `No — "${text}" isn't a palindrome.`;
  }
}
