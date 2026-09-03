// Follow-feed subscriptions (follow-feed-subscriptions): "follow this blog / r/programming / HN AI /
// this YouTube channel" and get pinged ONLY when a new item is published — the biggest retention lever
// and structurally distinct from alerts (value crossings) + digests (scheduled recipe re-runs). Neither
// pushes newly-published content. This resolves a "follow" target to a KEYLESS feed URL + parser (RSS/
// Atom, Reddit .json, Hacker News Algolia, YouTube channel Atom), so the check fetches DIRECTLY instead
// of driving a flaky logged-out browser. It rides the EXISTING feed-watch machinery in alerts.ts /
// alert-runner.ts (seen-set + new-item keying + scheduler cadence) — this module only adds the source
// resolution + parsing. Pure helpers; the network fetch is injected (guarded GET in prod, fake in tests).

export type FeedKind = "rss" | "reddit" | "hn" | "youtube";
export interface FeedSource { kind: FeedKind; url: string; label: string; }

/** Resolve a "follow" target (a URL, subreddit, HN topic, or YouTube channel) to a keyless feed source,
 * or null if we can't map it (caller falls back to an agent-driven feed watch). Exported for tests. */
export function resolveFeedSource(target: string): FeedSource | null {
  const t = String(target ?? "").trim();
  if (!t) return null;

  // Reddit: "r/programming", "reddit.com/r/x", "/r/x". Uses the .rss (Atom) endpoint, not /new.json —
  // Reddit's JSON API 403s from datacenter IPs, while the RSS feed is served more permissively; parsed
  // as Atom by parseXmlTitles. Still best-effort (a fetch failure stays silent, never a false "new").
  const reddit = t.match(/(?:^|reddit\.com\/|\/)r\/([a-z0-9_]+)\b/i);
  if (reddit) {
    const sub = reddit[1]!;
    return { kind: "rss", url: `https://www.reddit.com/r/${sub}/new/.rss?limit=15`, label: `r/${sub}` };
  }

  // Hacker News topic: "HN AI", "hacker news about rust", "hn: startups"
  const hn = t.match(/^(?:hn|hacker\s*news)\b[\s:]*(.*)$/i);
  if (hn) {
    const q = hn[1]!.replace(/^(?:about|on|for)\s+/i, "").trim();
    // Algolia HN search by date (keyless). No query -> front page (story tag).
    const url = q
      ? `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=15`
      : `https://hn.algolia.com/api/v1/search_by_date?tags=front_page&hitsPerPage=15`;
    return { kind: "hn", url, label: q ? `HN: ${q}` : "Hacker News" };
  }

  // YouTube channel: a channel URL with /channel/UC... (the keyless Atom feed keys off the channel id).
  const yt = t.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  if (yt) {
    return { kind: "youtube", url: `https://www.youtube.com/feeds/videos.xml?channel_id=${yt[1]}`, label: "YouTube channel" };
  }

  // A bare/explicit URL -> treat as an RSS/Atom feed (many blogs expose /feed or /rss; we fetch as-is
  // and parse whatever XML comes back). Require an http(s) URL so a random phrase isn't treated as one.
  if (/^https?:\/\/\S+$/i.test(t)) {
    return { kind: "rss", url: t, label: hostLabel(t) };
  }
  return null;
}

function hostLabel(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "feed"; }
}

/** Parse a feed response body into a list of item strings (title, newest-ish first as the source
 * returns them), by kind. Returns [] on any parse failure. Exported for tests. */
export function parseFeed(kind: FeedKind, body: string): string[] {
  try {
    if (kind === "reddit") {
      const obj = JSON.parse(body) as { data?: { children?: Array<{ data?: { title?: string } }> } };
      return (obj.data?.children ?? []).map((c) => c.data?.title?.trim()).filter((s): s is string => !!s);
    }
    if (kind === "hn") {
      const obj = JSON.parse(body) as { hits?: Array<{ title?: string; story_title?: string }> };
      return (obj.hits ?? []).map((h) => (h.title || h.story_title || "").trim()).filter(Boolean);
    }
    // rss / youtube: XML. Pull <title> out of each <item> (RSS) or <entry> (Atom); drop the channel
    // title (the first <title> before any item/entry). No XML lib — a tolerant regex is enough for a
    // title list, and a parse miss just yields [] (caller stays silent, no false "new").
    return parseXmlTitles(body);
  } catch { return []; }
}

/** Pull item/entry titles out of an RSS or Atom document, skipping the channel/feed-level title. */
export function parseXmlTitles(xml: string): string[] {
  const out: string[] = [];
  // Match each <item>...</item> (RSS) or <entry>...</entry> (Atom) block, then its first <title>.
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const m = block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) continue;
    const title = decodeXml(stripCdata(m[1]!)).trim();
    if (title) out.push(title);
  }
  return out;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'").replace(/&#0*38;|&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ""; } });
}

/** Fetch + parse a feed source into item strings. `fetchText` is injected. Returns [] on any failure
 * (the caller then stays silent — never a false "new item"). Exported for the alert-runner. */
export async function fetchFeedItems(
  src: FeedSource,
  fetchText: (url: string) => Promise<string>,
): Promise<string[]> {
  try {
    return parseFeed(src.kind, await fetchText(src.url));
  } catch { return []; }
}

/**
 * Parse a "follow X" command into { name, target }, or null. Handles:
 *   "follow r/programming", "follow https://blog.example.com/feed",
 *   "follow HN about rust", "follow this channel https://youtube.com/channel/UC..."
 *   optional name: "follow rust news: r/rust" (name before the colon).
 * Exported for tests.
 */
export function parseFollowCommand(text: string): { name: string; target: string } | null {
  const m = text.trim().match(/^\s*(?:follow|subscribe\s+to)\s+(.+?)\s*$/i);
  if (!m) return null;
  let rest = m[1]!.trim();
  // Optional explicit name: "follow <name>: <target>". Only when the part after the colon looks like a
  // target (a URL, r/x, or HN/youtube cue) so "follow HN: rust" keeps HN as the source, not the name.
  const named = rest.match(/^([^:]{1,40}):\s*(\S.*)$/);
  if (named && /(?:^https?:\/\/|\br\/|\byoutube\.com|\bhn\b|hacker\s*news)/i.test(named[2]!)) {
    return { name: normalizeFollowName(named[1]!.trim()), target: named[2]!.trim() };
  }
  const src = resolveFeedSource(rest);
  const name = src ? src.label : rest;
  return { name: normalizeFollowName(name), target: rest };
}

/** A short, store-safe name for a follow subscription (lowercased, trimmed, capped). */
export function normalizeFollowName(raw: string): string {
  return String(raw ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40) || "feed";
}
