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

/** The chunk of `full` after `alreadyShown`, trimmed to `max` chars, or null if there's nothing more.
 * Used to page out the tail a prior trim() dropped. Falls back to a tail slice if the shown text
 * isn't a clean prefix (e.g. it ended with an "…" ellipsis marker). */
export function nextChunk(full: string, alreadyShown: string, max = 1200): string | null {
  const shownCore = alreadyShown.replace(/[\s…]+$/, "");
  let rest: string;
  if (full.startsWith(shownCore)) rest = full.slice(shownCore.length);
  else rest = full.length > shownCore.length ? full.slice(shownCore.length) : "";
  rest = rest.replace(/^[\s…]+/, "");
  if (!rest) return null;
  return rest.length > max ? rest.slice(0, max - 1).trimEnd() + "…" : rest;
}
