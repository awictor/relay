// Detect a numbered result list in a reply so we can attach one-tap "pick" buttons (inline-result-picker).
// A multi-option answer (cheapest flights, new listings, restock sizes) arrives as a numbered/bulleted
// text block; the user then has to retype to drill into one. This finds those list items so the handler
// can offer a pick button per line and, on tap, resend that one line (with its link if present). Pure +
// offline-testable. Conservative: only fires on a genuine 2+ item enumerated list, so a prose answer
// with an incidental "1." never sprouts buttons.

export interface ResultItem {
  index: number; // 0-based, matches the pick button's payload
  text: string;  // the item's line, cleaned of its leading marker
}

// A line that opens a list item: "1.", "1)", "2 -", "•", "-", "*" (optionally indented). Captures the
// numeric marker (if any) so we only treat a run of items as a LIST when it's genuinely enumerated.
const NUM_MARKER = /^\s*(\d{1,2})[.)]\s+(.*\S.*)$/;      // "1. foo" / "12) bar"
const BULLET_MARKER = /^\s*[•*\-]\s+(.*\S.*)$/;          // "• foo" / "- bar" / "* baz"

/**
 * Parse a reply into its list items, or [] when it isn't a pickable list. Rules (conservative):
 *  - a NUMBERED list must have >=2 items whose markers ascend from 1 (1,2,3…) — an incidental "Step 1:"
 *    in prose won't match (no ascending run), and a numbered list that doesn't start at 1 is skipped.
 *  - a BULLETED list must have >=2 bullet lines.
 *  - numbered wins over bulleted when both appear (numbered is the stronger "these are options" signal).
 *  - each item's text is trimmed + capped so a button-resend stays short; empty items are dropped.
 * Returns items in document order with 0-based indices.
 */
export function parseResultList(reply: string): ResultItem[] {
  const lines = reply.split(/\r?\n/);
  // Numbered pass: collect lines with a numeric marker, in order, and require them to form an ascending
  // 1,2,3… run (allowing prose lines in between to be ignored — a list is often interleaved with blanks).
  const numbered: Array<{ n: number; text: string }> = [];
  for (const line of lines) {
    const m = line.match(NUM_MARKER);
    if (m) numbered.push({ n: Number(m[1]), text: m[2]!.trim() });
  }
  if (numbered.length >= 2 && numbered[0]!.n === 1) {
    // Take the leading ascending run (1,2,3,…); stop at the first gap/reset so a later "1." in a
    // different section can't glue on.
    const run: ResultItem[] = [];
    let expect = 1;
    for (const item of numbered) {
      if (item.n !== expect) break;
      run.push({ index: run.length, text: clip(item.text) });
      expect++;
    }
    if (run.length >= 2) return run;
  }
  // Bulleted pass.
  const bullets: ResultItem[] = [];
  for (const line of lines) {
    const m = line.match(BULLET_MARKER);
    if (m) bullets.push({ index: bullets.length, text: clip(m[1]!.trim()) });
  }
  if (bullets.length >= 2) return bullets;
  return [];
}

// A pickable item's text is one line for a button-resend; cap it so a giant paragraph-as-item doesn't
// blow up the resend (the full reply is still in the chat above).
const MAX_ITEM = 500;
function clip(s: string): string {
  return s.length > MAX_ITEM ? s.slice(0, MAX_ITEM - 1).trimEnd() + "…" : s;
}

// Pull the first URL out of an item's text (so a pick can surface "Open: <link>"). Null when none.
const URL_RE = /https?:\/\/[^\s)>\]]+/i;
export function firstUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0] : null;
}
