// Quick factual lookups (wikipedia-fast-fact): "who is the CEO of OpenAI", "how tall is Everest",
// "what is a Roth IRA" — the single most common text-a-bot first errand — used to wait 10-30s on
// web_search -> scrape -> summarize (and sometimes grab the wrong page). This hits the KEYLESS Wikipedia
// APIs (no signup): a full-text search to resolve the best page title, then the REST summary endpoint for
// a one-paragraph extract + description + a citation URL. Pure parse/format helpers exported + unit-
// tested; the network fetch is injected (guarded GET in prod, a fake in tests). Mirrors dictionary/scores.

export interface WikiFact {
  title: string;
  description?: string; // the short "Earth's highest mountain" tagline
  extract: string;      // the lead-paragraph summary (trimmed)
  url?: string;         // the article URL, for a citation
}

// Full-text search -> the best-matching article title. Full-text (list=search) not opensearch, because
// opensearch only prefix-matches a title ("ceo of openai" -> nothing) while search ranks by content
// ("ceo of openai" -> "OpenAI"). Exported for tests.
export function searchUrl(query: string): string {
  return `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query.trim())}&srlimit=1&format=json&origin=*`;
}
// REST summary for a resolved title. Exported for tests.
export function summaryUrl(title: string): string {
  return `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.trim().replace(/\s/g, "_"))}`;
}

/** Parse the search response -> the top result's title, or null (no match / bad shape). Exported. */
export function parseSearchTitle(body: string): string | null {
  try {
    const j = JSON.parse(body) as { query?: { search?: Array<{ title?: string }> } };
    const t = j.query?.search?.[0]?.title;
    return t && t.trim() ? t.trim() : null;
  } catch { return null; }
}

/** Parse a REST summary response -> a WikiFact, or null. Returns null for a DISAMBIGUATION page (type
 * "disambiguation" — "Mercury" could be the planet/element/god, so a single extract would mislead; the
 * caller then asks the user to be specific) and for an empty/missing extract. Exported. */
export function parseSummary(body: string): WikiFact | null {
  let j: {
    type?: string;
    title?: string;
    description?: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  };
  try { j = JSON.parse(body); } catch { return null; }
  if (j.type === "disambiguation") return null; // ambiguous term — don't pick one meaning silently
  const extract = String(j.extract ?? "").trim();
  const title = String(j.title ?? "").trim();
  if (!extract || !title) return null;
  return {
    title,
    ...(j.description && j.description.trim() ? { description: j.description.trim() } : {}),
    extract: clip(extract),
    ...(j.content_urls?.desktop?.page ? { url: j.content_urls.desktop.page } : {}),
  };
}

// Keep the extract phone-sized — the lead paragraph can be several sentences; cap to the first ~600
// chars at a sentence boundary so it reads as a text, not an essay.
const MAX_EXTRACT = 600;
function clip(s: string): string {
  if (s.length <= MAX_EXTRACT) return s;
  const cut = s.slice(0, MAX_EXTRACT);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (lastStop >= MAX_EXTRACT * 0.5 ? cut.slice(0, lastStop + 1) : cut.trimEnd() + "…");
}

/** Format a WikiFact into a short cited message. */
export function formatFact(f: WikiFact): string {
  const head = f.description ? `${f.title} — ${f.description}` : f.title;
  const cite = f.url ? `\n\n(${f.url})` : "";
  return `${head}\n\n${f.extract}${cite}`;
}

/**
 * Look up a quick fact. `fetchText` is injected. Resolves the query to a title via full-text search,
 * then fetches that title's summary. Returns null when there's no match, the page is a disambiguation,
 * or a fetch fails — the caller falls back to web_search. `disambiguation` is set when the resolved page
 * was a disambiguation so the caller can ask the user to narrow it. Never throws.
 */
export async function getFact(
  query: string,
  fetchText: (url: string) => Promise<string>,
): Promise<{ fact: WikiFact | null; disambiguation?: boolean }> {
  const q = String(query ?? "").trim();
  if (!q) return { fact: null };
  try {
    const title = parseSearchTitle(await fetchText(searchUrl(q)));
    if (!title) return { fact: null };
    const body = await fetchText(summaryUrl(title));
    const fact = parseSummary(body);
    if (fact) return { fact };
    // parseSummary returned null — distinguish a disambiguation page (worth telling the user to narrow)
    // from a plain miss, by peeking at the type.
    let disambiguation = false;
    try { disambiguation = (JSON.parse(body) as { type?: string }).type === "disambiguation"; } catch { /* ignore */ }
    return { fact: null, ...(disambiguation ? { disambiguation } : {}) };
  } catch { return { fact: null }; }
}
