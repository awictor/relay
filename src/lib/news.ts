// On-demand news headlines (get-news-tool): "what's the news", "top headlines", "news about the election"
// is a top first errand AND the /start message advertises "every morning: weather + top news" — but
// there was no news source, so it fell to a slow web_search + scrape of a paywalled/JS front page. This
// hits a keyless RSS headline feed (Google News, no signup) for the top stories, optionally about a
// topic, reusing feeds.ts's XML parser. Mirrors get_scores/get_weather. Pure helpers; fetch injected.
import { parseXmlItems } from "./feeds.js";

/** Build a keyless Google News RSS URL: the general top-stories feed, or a topic search when `topic` is
 * given ("news about X"). Google News RSS needs no key + returns clean <item><title> headlines.
 * Exported for tests. */
export function newsUrl(topic?: string): string {
  const t = String(topic ?? "").trim();
  const base = "https://news.google.com/rss";
  const tail = "hl=en-US&gl=US&ceid=US:en";
  return t
    ? `${base}/search?q=${encodeURIComponent(t)}&${tail}`
    : `${base}?${tail}`;
}

// A Google News headline is "Story title - Publisher"; strip the trailing " - Publisher" so the line
// reads cleanly. Conservative: only strips a final " - <short source>" (no digits-heavy tail), leaving
// hyphenated titles intact.
function cleanHeadline(title: string): string {
  return title.replace(/\s+-\s+[^-]{2,40}$/, "").trim() || title.trim();
}

/** Parse a news RSS body into a list of headline strings (top-first), capped, or [] on failure.
 * Exported for tests. */
export function parseHeadlines(body: string, limit = 8): string[] {
  const items = parseXmlItems(body);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const h = cleanHeadline(it.title);
    const k = h.toLowerCase();
    if (!h || seen.has(k)) continue;
    seen.add(k);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/** Format headlines into a short message. `topic` labels a topic feed. */
export function formatNews(headlines: string[], topic?: string): string {
  const t = String(topic ?? "").trim();
  if (!headlines.length) return t ? `I couldn't find news about "${t}" right now.` : "I couldn't pull the headlines right now.";
  const head = t ? `Top news about "${t}":` : "Top headlines:";
  return `${head}\n${headlines.map((h) => `• ${h}`).join("\n")}`;
}

/**
 * Fetch the top news headlines (optionally about a topic). `fetchText` is injected. Returns the
 * headlines + the topic echoed, or null on a fetch failure / empty parse — the caller falls back to
 * web_search. Exported for the agent dispatch.
 */
export async function getNews(
  topic: string | undefined,
  fetchText: (url: string) => Promise<string>,
): Promise<{ topic?: string; headlines: string[] } | null> {
  const t = String(topic ?? "").trim();
  try {
    const headlines = parseHeadlines(await fetchText(newsUrl(t)));
    if (!headlines.length) return null;
    return { ...(t ? { topic: t } : {}), headlines };
  } catch { return null; }
}
