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
