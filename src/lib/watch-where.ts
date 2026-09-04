// Where-to-watch (movie-where-to-watch): "where can I stream Dune 2" / "is Oppenheimer on Netflix" is a
// top evening errand Relay had no tool for — it fell to a cold logged-out scrape that floated a wrong or
// stale answer. There is NO reliable keyless streaming-availability API (TMDb/OMDb/JustWatch all need a
// key or block datacenter GETs), so — like the transit-directions bridge — this hands back a JustWatch
// link (accurate, per-region streaming/rent/buy availability) + steers the user to get_fact for the
// film's details, instead of inventing a "it's on Netflix" the model can't verify. Pure; no I/O.

import { stripTrailingCourtesy } from "./text-clean.js";

// A film/show title the user wants to watch. Extracted from phrasing so the query is the TITLE, not the
// whole sentence ("where can I watch Dune Part Two" -> "Dune Part Two").
const WATCH_RE = /\b(?:where\s+(?:can\s+i\s+)?(?:watch|stream)|how\s+(?:can\s+i\s+)?(?:watch|stream)|watch|stream|streaming|is)\s+(.+?)(?:\s+(?:streaming|available|online|on\s+(?:netflix|hulu|max|disney\+?|prime|paramount\+?|peacock|apple\s?tv\+?)))?\s*\??$/i;

/** Extract the title from a where-to-watch ask, or null if it isn't one. Requires a watch/stream cue so
 * a plain "Dune" doesn't hijack. Strips a trailing platform clause ("on Netflix") so the JustWatch query
 * is the bare title. Exported for tests. */
export function parseWatchQuery(text: string): string | null {
  // Strip a trailing courtesy so "where to watch Dune please" queries "Dune", not "Dune please" — the
  // title-capture is end-anchored and would otherwise fold "please" into the JustWatch query
  // (courtesy-tail bug class). The gate cue (watch/stream) sits before the title, unaffected.
  const t = stripTrailingCourtesy(String(text ?? "").trim());
  // Gate: must mention watch/stream (or "is X on <platform>"). Avoids catching every title mention.
  if (!/\b(watch|stream|streaming)\b/i.test(t) && !/\bis\s+.+\bon\s+(netflix|hulu|max|disney|prime|paramount|peacock|apple)/i.test(t)) return null;
  const m = t.match(WATCH_RE);
  if (!m) return null;
  let title = (m[1] ?? "").trim().replace(/^["']|["']$/g, "").replace(/[.?!]+$/, "").trim();
  // Drop a leading "the movie"/"the show"/"the film" filler.
  title = title.replace(/^(?:the\s+)?(?:movie|film|show|series)\s+/i, "").trim();
  if (title.length < 2) return null;
  return title.slice(0, 100);
}

// Region for JustWatch (default US). A saved country could refine this later; kept simple/keyless now.
const DEFAULT_REGION = "us";

/** A JustWatch search URL for a title in a region — its results page lists where the title streams /
 * rents / buys, accurate per region. Exported for tests. */
export function justWatchUrl(title: string, region = DEFAULT_REGION): string {
  return `https://www.justwatch.com/${region}/search?q=${encodeURIComponent(title.trim())}`;
}

/** The honest where-to-watch reply: a JustWatch link (real per-region availability) + a note that we
 * can't verify a specific platform ourselves, so we point them there rather than guess. */
export function formatWatchWhere(title: string, region = DEFAULT_REGION): string {
  return `Here's where "${title}" is streaming / to rent or buy (by region, live on JustWatch):\n${justWatchUrl(title, region)}\n\nI can't reliably confirm a specific service myself (availability changes constantly + varies by country), so this link is the accurate source. Want the rating or a plot summary instead? Just ask.`;
}
