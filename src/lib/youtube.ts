// YouTube transcript fetch (video-transcript-summary): a user pastes a video link and asks to
// summarize it, but a scrape hits YouTube's JS-only shell and comes back empty. This module fetches
// the video's caption track (the free, key-less path: watch page -> ytInitialPlayerResponse
// captionTracks -> timedtext XML/JSON3 -> plain text) so the agent can summarize what was SAID.
// Pure parsers are exported + unit-tested; the network orchestration takes an injectable fetch.

/** Extract an 11-char YouTube video id from any common URL shape, or null.
 *   youtube.com/watch?v=ID   youtu.be/ID   youtube.com/shorts/ID   /embed/ID   /live/ID
 * Also accepts a bare 11-char id. Query/extra path after the id is ignored. */
export function parseYouTubeId(url: string): string | null {
  const s = url.trim();
  // Bare id.
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/[?&]v=([A-Za-z0-9_-]{11})\b/))) return m[1]!;
  if ((m = s.match(/youtu\.be\/([A-Za-z0-9_-]{11})\b/i))) return m[1]!;
  if ((m = s.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})\b/i))) return m[1]!;
  return null;
}

/** True if a URL points at a YouTube video (so the agent's transcript tool should handle it). */
export function isYouTubeUrl(url: string): boolean {
  return /(?:^|\/\/|\.)(?:youtube\.com|youtu\.be)\b/i.test(url) && parseYouTubeId(url) !== null;
}

/** Pull the FIRST caption track baseUrl out of a watch page's ytInitialPlayerResponse JSON blob.
 * Prefers an English track when languageCode is present, else the first. Returns null if none
 * (captions disabled / not found). The HTML embeds the JSON as `"captionTracks":[{...}]`. */
export function extractCaptionTrackUrl(watchHtml: string): string | null {
  const m = watchHtml.match(/"captionTracks":(\[.*?\])/s);
  if (!m) return null;
  let tracks: Array<{ baseUrl?: string; languageCode?: string; kind?: string }>;
  try { tracks = JSON.parse(m[1]!); } catch { return null; }
  if (!Array.isArray(tracks) || !tracks.length) return null;
  // Prefer a manual English track, then any English, then any track at all.
  const pick =
    tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") ??
    tracks.find((t) => t.languageCode === "en") ??
    tracks.find((t) => typeof t.baseUrl === "string");
  const base = pick?.baseUrl;
  if (!base) return null;
  // The embedded URL is JSON-escaped (& -> &). Normalize.
  return base.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
}

/** Parse a timedtext transcript document (the legacy XML `<text start=..>…</text>` form OR the
 * JSON3 `{events:[{segs:[{utf8}]}]}` form) into plain, whitespace-collapsed text. Decodes the few
 * HTML entities YouTube emits. Returns "" if nothing parseable. */
export function parseTranscriptXml(doc: string): string {
  const d = doc.trim();
  // JSON3 form (when the caption URL carries &fmt=json3).
  if (d.startsWith("{")) {
    try {
      const obj = JSON.parse(d) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
      const parts = (obj.events ?? []).flatMap((e) => (e.segs ?? []).map((s) => s.utf8 ?? ""));
      return collapse(parts.join(""));
    } catch { /* fall through to XML */ }
  }
  // Legacy XML form: <text start="1.2" dur="3.4">line</text>
  const lines: string[] = [];
  for (const m of d.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs)) {
    lines.push(decodeEntities(m[1]!));
  }
  return collapse(lines.join(" "));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/<[^>]+>/g, " "); // strip any stray inline tags
}
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export interface TranscriptResult { videoId: string; text: string }

/**
 * Fetch a YouTube video's transcript as plain text, or null if unavailable (no captions / not a
 * YouTube URL / fetch failed). `fetchText` is injected (real fetch in prod, a fake in tests) and
 * must return the response body text for a GET, or throw. It's called for the watch page then the
 * caption track URL. Never throws — returns null on any failure so the caller can fall back.
 */
export async function fetchYouTubeTranscript(
  url: string,
  fetchText: (u: string) => Promise<string>,
): Promise<TranscriptResult | null> {
  const videoId = parseYouTubeId(url);
  if (!videoId) return null;
  try {
    const watch = await fetchText(`https://www.youtube.com/watch?v=${videoId}`);
    const capUrl = extractCaptionTrackUrl(watch);
    if (!capUrl) return null;
    const doc = await fetchText(capUrl);
    const text = parseTranscriptXml(doc);
    return text ? { videoId, text } : null;
  } catch {
    return null;
  }
}
