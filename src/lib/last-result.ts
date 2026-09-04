// Follow-up on the last answer (last-result-drilldown): a reply is often trimmed to phone size or
// summarizes away the URLs, so "more"/"full" and "send the link" are natural next asks. The handler
// caches the last full reply per chat; these pure helpers detect the follow-up + extract what to send.

/** True if the WHOLE message is a "show me the rest" ask ("more", "full", "continue", "rest", "go on"). */
export function isMoreRequest(text: string): boolean {
  return /^\s*(?:more|the rest|rest|full|full text|continue|go on|keep going|and\?|\.\.\.)\s*[?.!]*\s*$/i.test(text);
}

/** True if the WHOLE message asks for the source link(s) of the last answer. */
export function isLinkRequest(text: string): boolean {
  return /^\s*(?:links?|the links?|send (?:me )?(?:the )?links?|source|sources|url|urls|the url|open the source)\s*[?.!]*\s*$/i.test(text);
}

// Word forms for the small ordinals/cardinals a user says instead of a digit ("open the third one").
const WORD_NUM: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, last: -1,
};

/** Parse a "pick item N from the last list" ask into a 1-based index, or null if the message isn't one
 * (open-nth-result). Matches "open/show/pick/resend the 2nd", "#3", "number 1", "the third one",
 * "open 2", "the last one" (-1 -> caller maps to the final item). Whole-message only + requires an
 * open/show/pick/resend/give/send verb OR a leading #/ordinal so a real task ("3 day forecast",
 * "open example.com") isn't hijacked. */
export function parsePickIndex(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/[?.!]+$/, "").trim();
  // "#3" / "# 3"
  let m = t.match(/^#\s*(\d{1,2})$/);
  if (m) return Number(m[1]);
  // a verb + optional "the"/"result"/"option"/"item"/"one" + a digit or number-word (+ optional "one")
  m = t.match(/^(?:open|show|pick|resend|give me|send me|see|view|read|get)\s+(?:me\s+)?(?:the\s+)?(?:(\d{1,2})(?:st|nd|rd|th)?|([a-z]+))(?:\s+(?:one|result|item|option|link))?$/);
  if (m) {
    if (m[1]) return Number(m[1]);
    const w = WORD_NUM[m[2]!];
    return w ?? null;
  }
  // "number 3" / "option 2" / "result 1" / "item 4" (no leading verb needed — these name a list slot)
  m = t.match(/^(?:number|no\.?|option|result|item)\s+(\d{1,2})$/);
  if (m) return Number(m[1]);
  // "the 2nd" / "the second (one)" / "the last one"
  m = t.match(/^the\s+(?:(\d{1,2})(?:st|nd|rd|th)|([a-z]+))(?:\s+one)?$/);
  if (m) {
    if (m[1]) return Number(m[1]);
    const w = WORD_NUM[m[2]!];
    return w ?? null;
  }
  return null;
}

/** Extract up to `limit` http(s) URLs from text, de-duplicated, in order of appearance. */
export function extractLinks(text: string, limit = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/gi)) {
    const url = m[0].replace(/[.,;:]+$/, ""); // trim trailing sentence punctuation
    if (!seen.has(url)) { seen.add(url); out.push(url); if (out.length >= limit) break; }
  }
  return out;
}

/** How many chars of `full` a `shown` reply actually delivered — the common-prefix length, ignoring
 * a trailing "…"/whitespace the trim added. Used to seed the paging offset from the first reply. */
export function deliveredLen(full: string, shown: string): number {
  const core = shown.replace(/[\s…]+$/, "");
  let i = 0;
  while (i < core.length && i < full.length && core[i] === full[i]) i++;
  return i;
}

/** Page out `full` from character offset `sent`, up to `max` chars. Returns the chunk text + the new
 * offset, or null when nothing remains. OFFSET-based (not prefix-matching the shown text) so repeated
 * "more" pages don't garble at the boundary — the earlier version compared against a `shown` string
 * that carried "…" trim markers absent from `full`, so startsWith failed after page 1. */
export function chunkFrom(full: string, sent: number, max = 1200): { text: string; nextOffset: number } | null {
  const rest = full.slice(sent).replace(/^\s+/, "");
  const start = full.length - full.slice(sent).replace(/^\s+/, "").length; // offset after skipping leading ws
  if (!rest) return null;
  if (rest.length <= max) return { text: rest, nextOffset: full.length };
  const text = rest.slice(0, max - 1).trimEnd() + "…";
  return { text, nextOffset: start + (text.length - 1) }; // -1 for the appended ellipsis
}
