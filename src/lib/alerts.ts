// Change-alerts (m10): a watched task runs on a schedule but only NOTIFIES when the result
// changes from last time ("tell me when the price of X drops"). Turns Relay from fetch-on-
// demand into watch-and-notify. Pure parse + compare + persistent store (JSON file, like
// RecipeStore). The runner (alert-2) compares new vs stored lastValue and sends only on change.

import { atomicWriteJson, readJsonSafe } from "./safe-store.js";
import { pageWatchUrl } from "./pagediff.js";
import { parseWeatherCondition } from "./weather-alert.js";

export interface Alert {
  chatId: number;
  name: string;        // unique per chat (lowercased)
  task: string;        // task run each check
  lastValue?: string;  // last agent reply, for change comparison
  threshold?: number;  // optional: only notify if a numeric value moved >= this much
  condition?: AlertCondition; // optional: notify when a predicate holds (below/above/in-stock)
  // Weather-conditional (weather-conditional-alert): "text me if it rains tomorrow" — a forecast predicate
  // (rain/snow/below/above/wind + today|tomorrow) checked directly against the keyless Open-Meteo forecast,
  // edge-triggered (fires when it FIRST becomes true). Present -> the runner takes the weather branch.
  weather?: import("./weather-alert.js").WeatherCondition;
  // Feed-watch (new-item-feed-watch): the task returns a LIST (jobs, listings, restocks) and we notify
  // only when a NEW entry appears — not on any value change. `seen` is the set of item keys already
  // reported; undefined = never checked (seed silently on the first run so setup doesn't dump the
  // whole list). A feed alert has neither threshold nor condition.
  feed?: boolean;
  seen?: string[];
  // Watch-any-page (watch-any-page-diff): a bare-URL watch pings when the PAGE's visible text changes
  // (restocks, policy/status/appointment pages) — the page is fetched directly (no agent) and diffed
  // against the last snapshot. `pageUrl` marks it; `lastValue` holds the last page text for the diff.
  pageUrl?: string;
  // Page-diff flap guard (page-diff-flap-guard): consecutive checks that saw a change. A page that
  // changes on EVERY fetch (dynamic content the volatile-token mask didn't catch) would ping forever +
  // bypasses the anti-spam cap/quiet-hours (alerts are exempt), so after too many straight changes the
  // watch auto-mutes (pausedUntil) instead of firehosing the user. Reset to 0 on any unchanged check.
  flapCount?: number;
  // Follow-feed subscriptions (follow-feed-subscriptions): a KEYLESS feed source (RSS/Reddit/HN/YouTube)
  // fetched DIRECTLY on each check instead of running the flaky agent. When set, the alert is a feed
  // watch whose items come from feedSource.url via lib/feeds.ts — reuses the whole seen-set/new-item
  // path below. Absent -> a normal (agent-driven) feed/value/predicate watch.
  feedSource?: { kind: "rss" | "reddit" | "hn" | "youtube"; url: string; label: string };
  // Trigger-to-action (trigger-to-action-alerts): when this alert fires, ALSO run the saved recipe
  // named here and append its result to the notification — watch-and-DO, not just watch-and-notify
  // ("when new jobs appear, run my summarize-jobs recipe"). The recipe stays a normal read-only task
  // (no login/pay). Undefined = plain notify. Resolved at fire time so editing the recipe changes it.
  then?: string;
  // Time series (watch-time-series): each check with an extractable numeric value appends {t,v} here,
  // so a user can ask "how has X moved this week" / min-max / trend — answered from stored data, no LLM.
  // Capped; oldest-first drop. Only numeric watches accumulate a series (a prose watch has no value).
  series?: Array<{ t: number; v: number }>;
  // Watchlist (watchlists): track N items as ONE watch — each member is its own sub-task with its own
  // last value; a check runs them all and sends ONE grouped ping of only the members that CHANGED, so a
  // basket (5 stocks / 3 job feeds) is a single standing dashboard, not N separate alerts + N pings. A
  // watchlist alert has members instead of a single trigger. `label` is a short human name per member.
  members?: Array<{ label: string; task: string; last?: string }>;
  created: number;
}

// Cap watchlist members so one check can't fan out into an unbounded burst of agent runs.
const MAX_WATCHLIST_MEMBERS = 8;

// Cap the per-alert time series so a long-lived watch can't grow unbounded. ~1 point/check; at a daily
// cadence this is ~1 year, at hourly ~2 weeks — enough for "this week/month" trend answers.
const MAX_SERIES_POINTS = 400;

// Cap the per-alert seen-set so a long-lived feed watch can't grow its stored keys without bound.
// Oldest keys drop first; a dropped item re-notifying once months later is acceptable.
const MAX_SEEN_KEYS = 200;

// A predicate alert: notify when the watched value satisfies it (edge-triggered — fires when it
// FIRST becomes true, not every check while true, so "below 50k" pings once on the drop).
export interface AlertCondition {
  op: "below" | "above" | "in_stock";
  operand?: number; // for below/above
}

export interface ParsedAlert {
  name: string;
  task: string;
  threshold?: number;
  condition?: AlertCondition;
  feed?: boolean; // notify on a NEW list item, not on a value change
  weather?: import("./weather-alert.js").WeatherCondition; // weather-conditional-alert
  pageUrl?: string; // watch-any-page-diff: a bare-URL watch that pings on any page-content change
  feedSource?: { kind: "rss" | "reddit" | "hn" | "youtube"; url: string; label: string }; // follow-feed-subscriptions
  then?: string;  // run this saved recipe when the alert fires (trigger-to-action-alerts)
  members?: Array<{ label: string; task: string }>; // watchlist: N sub-watches, one grouped ping
}

/** Derive a short human label for a watchlist member from its task (first few salient words). */
function memberLabel(task: string): string {
  return task.trim().replace(/^(?:the\s+|price of\s+|check\s+)/i, "").split(/\s+/).slice(0, 4).join(" ").slice(0, 40) || task.slice(0, 40);
}

// A "sentence-y" line: ends with terminal punctuation or is long with no bullet — prose, not a list item.
const SENTENCE_RE = /[.!?]$/;

/** Split an agent reply into candidate feed items. A feed reply is a LIST (jobs/listings/restocks): a
 * bulleted/numbered set, or several short title-ish lines. This MUST NOT treat a prose reply as a single
 * "item" — the agent rewords the same fact between checks, so a one-line-prose item false-fires "1 new"
 * every time (feed-agent-prose-false-new). So: (1) if any lines carry an explicit bullet/ordinal marker,
 * take ONLY those (a real list, lead-in prose ignored); (2) else accept multiple short, non-sentence
 * lines as a bare list; (3) a reply with no marked items and <2 qualifying lines (i.e. prose) yields []
 * — the feed path then finds nothing new + stays silent instead of crying wolf. Exported for tests. */
export function extractListItems(reply: string): string[] {
  const lines = reply.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const MARKER = /^\s*(?:[-*•·]|\d+[.)])\s+/;
  const marked = lines.filter((l) => MARKER.test(l));
  const clean = (l: string) => l.replace(MARKER, "").trim();
  if (marked.length) {
    // Explicit list: take the marked items (drop any that are just a lead-in ending in ":").
    return marked.map(clean).filter((l) => l.length >= 2 && !l.endsWith(":"));
  }
  // No markers: accept a BARE list only if there are >=2 short, non-sentence lines (titles/entries).
  // A single line, or lines that read like sentences (prose), are NOT a feed -> [] (stay silent).
  const candidates = lines.filter((l) => l.length >= 2 && !l.endsWith(":") && !(SENTENCE_RE.test(l) && l.length > 80));
  if (candidates.length >= 2) return candidates;
  return [];
}

// Small deterministic string hash (FNV-1a, 32-bit -> base36). Used to disambiguate long feed keys.
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** A stable-ish key for a feed item so re-phrasing/reordering doesn't read as new. Lowercased, punctuation
 * and volatile lead-ins stripped, whitespace collapsed (reuses normalizeForCompare). When the normalized
 * text exceeds the 120-char prefix, a hash of the FULL text is appended (feed-key-collision): two distinct
 * long titles sharing a 120-char prefix (verbose news/marketplace boilerplate) would otherwise collide, so
 * the second is treated as already-seen and a genuinely-new item silently never pings. Exported for tests. */
export function feedItemKey(item: string): string {
  const norm = normalizeForCompare(item);
  if (norm.length <= 120) return norm;
  return norm.slice(0, 120) + "#" + shortHash(norm);
}

// Out-of-stock language (checked first — takes precedence over any affirmative on the same page).
const OUT_OF_STOCK_RE = /\b(out of stock|sold out|unavailable|out-of-stock|currently unavailable|not available)\b/i;

// An error-ish / no-real-value reply (alert-series-poisoned-by-error-number). A non-degraded agent
// answer can still be a soft failure that happens to contain a number ("the page returned a 404",
// "couldn't load the price right now", "error 500") — extractValue would pull 404/500 and the
// time-series (chart/trend) would show a bogus spike. Detect the shape so recordPoint can skip it.
// NOTE: does NOT include a bare 4xx/5xx number — "$450" / "bitcoin 5900" are real values, so a status
// code only counts inside an explicit error phrase ("error 404", "status 500", "returned a 503").
// ANCHORED to real failure PHRASING, not lone words (error-reply-overbroad): a legitimate headline/answer
// routinely contains "cannot", "blocked", "error", "no results", "failed" mid-sentence ("Why you cannot
// trust AI benchmarks", "Tesla recall blocked by court", "No results found for that team tonight"). The
// old regex flagged all of those as soft failures, so a news/HN/value watch went DARK on that change +
// held the stale baseline. Now a match requires (a) an explicit HTTP error + code, OR (b) a first-person
// fetch failure — "couldn't/can't/unable to/failed to <fetch-verb>" (load/fetch/reach/get/retrieve/find/
// connect/access/read/open/pull/look up/complete), OR (c) a standalone fetch-failure idiom.
const FETCH_VERB = "(?:load|loading|fetch|reach|get|retrieve|retriev\\w+|find|connect(?:\\s+to)?|access|read|open|pull|look\\s*up|complete|process|parse|display|show)";
const ERROR_REPLY_RE = new RegExp(
  // (a) explicit HTTP error + status code, either order: "error 404", "returned a 503", "404 error",
  // "status: 500". Allows a short filler ("a"/"the"/"an") between the error word and the code.
  "\\b(?:error|status|code|returned|http|response)\\b(?:\\s+(?:code|a|an|the|with|of|status))?[:#\\s]*[45]\\d\\d\\b" +
  "|\\b[45]\\d\\d\\s+(?:error|status|response|code)\\b" +
  // (b) first-person fetch failure: "couldn't load", "can't reach", "unable to fetch", "failed to get"
  "|\\b(?:couldn'?t|could\\s+not|can'?t|cannot|unable\\s+to|failed\\s+to|was\\s+unable\\s+to|wasn'?t\\s+able\\s+to)\\s+(?:\\w+\\s+){0,2}" + FETCH_VERB + "\\b" +
  // (c) standalone soft-failure idioms
  "|\\b(?:please\\s+)?try\\s+again(?:\\s+(?:later|in\\s+a\\b))?\\b|\\baccess\\s+denied\\b|\\brequest\\s+(?:failed|timed?\\s*out)\\b|\\b(?:timed?\\s*out|timeout)\\s+(?:while|trying|fetching|loading)\\b|\\b(?:page|site|server|it)\\s+(?:is\\s+)?(?:down|unavailable|unreachable|not\\s+responding)\\b|\\bno\\s+(?:data|price|results?)\\s+(?:available|found|returned)\\b|\\bcouldn'?t\\s+be\\s+(?:reached|loaded|found|retrieved)\\b",
  "i",
);
/** True if a reply reads like a fetch/soft failure rather than a real value — so a stray status code
 * (404/500) or "N/A" number isn't recorded into the watch's time series. Exported for tests. */
export function looksLikeErrorReply(reply: string): boolean {
  return ERROR_REPLY_RE.test(reply);
}
// STRONG availability phrases: an explicit statement the item itself is in stock. Enough on their own.
const IN_STOCK_STRONG_RE = /\b(in stock|in-stock|available (?:now|to (?:buy|order|purchase))|available for (?:purchase|order)|back in stock)\b/i;
// WEAK signals: a purchase CTA. On a product page these ride along with CROSS-SELL/recommended items
// too ("Add to cart" on a related product), so a CTA alone must NOT confirm the watched item is in
// stock (in-stock-cta-scoping) — it only counts when no recommendation framing is present.
const CTA_RE = /\b(add to cart|add to bag|add to basket|buy now|buy it now|order now|pre-?order)\b/i;
// Recommendation / cross-sell framing whose CTAs belong to OTHER products, not the watched one.
const CROSS_SELL_RE = /\b(you (?:may|might) also|related|recommended|similar (?:items?|products?)|customers also|frequently bought|sponsored|people also|more like this|you'll also love)\b/i;

/** Evaluate a condition against an observed value string. below/above use extractValue; in_stock
 * looks for stock language. Returns null when the value can't be assessed (so the caller holds). */
export function conditionHolds(cond: AlertCondition, value: string, hint?: string): boolean | null {
  if (cond.op === "in_stock") {
    if (OUT_OF_STOCK_RE.test(value)) return false;                 // negation wins
    if (IN_STOCK_STRONG_RE.test(value)) return true;               // explicit availability statement
    const cta = value.match(CTA_RE);
    if (cta) {
      const cross = value.match(CROSS_SELL_RE);
      // No cross-sell framing at all -> the CTA is the watched product's, in stock.
      if (!cross) return true;
      // Both present (the COMMON case — almost every product page has a "you may also like" block):
      // treat the CTA as the watched item's when it sits BEFORE the first cross-sell marker (the primary
      // above-the-fold buy button precedes the recommendations). Only a CTA that appears SOLELY inside
      // cross-sell framing stays ambiguous. Without this, "alert me when back in stock" returned null on
      // EVERY check of a normal product page and the restock was never caught (instock-cross-sell-never-fires).
      return cta.index! < cross.index! ? true : null;
    }
    return null; // ambiguous
  }
  // Pass the watched task as a hint so a multi-number reply ("S&P 5,900, Dow 42,000") compares the number
  // nearest the watched entity, not the largest one (extractvalue-largest-magnitude).
  const v = extractValue(value, hint);
  if (v === null || cond.operand === undefined) return null;
  return cond.op === "below" ? v < cond.operand : v > cond.operand;
}

/** True if this alert's signal PERSISTS to morning, so its send is safe to defer past quiet hours
 * (quiet-hours-persistent-alerts + unthrottled-change-watch). Only a PREDICATE (below/above/in_stock)
 * or WEATHER alert is edge-triggered — a crossing can revert overnight and be missed if the CHECK is
 * deferred, so those must run on cadence (NOT deferrable). Everything else — a plain/threshold
 * change-watch (its new value is still there in the morning), a watchlist, a feed, a page-diff — is
 * deferrable, which also stops a no-threshold "watch btc: price of bitcoin" from pinging all night. */
export function isQuietDeferrable(alert: Pick<Alert, "condition" | "weather">): boolean {
  return !alert.condition && !alert.weather;
}

function normalizeName(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ").toLowerCase().slice(0, 60);
}

/**
 * Parse an alert definition. Returns {name, task, threshold?, condition?} or null.
 *   "alert me <name>: <task>"          "watch <name>: <task>"
 * Optional trailing clause, checked in order:
 *   "... below <n>" / "under <n>" / "drops below <n>"   -> condition below n
 *   "... above <n>" / "over <n>"  / "hits <n>"          -> condition above n
 *   "... back in stock" / "when it's in stock"          -> condition in_stock
 *   "... (when it changes) by <n>"                       -> numeric change threshold
 */
export function parseAlertCommand(text: string): ParsedAlert | null {
  // The name/task separator is a colon — but NOT the ":" inside a URL scheme ("https://"). Without the
  // (?!//) guard, "watch this page https://ex.com for changes" split at "https:" into a garbage alert
  // named "this page https" watching "//ex.com ..." (alert-colon-in-url); the guard makes that phrasing
  // find no separator and fall through (null) so the agent/page-watch handles it. A real "watch news:
  // https://x.com" still splits at the "news:" colon (followed by a space, not "//").
  const m = text.trim().match(/^\s*(?:alert(?:\s+me)?|watch)\s+([^:]+?)\s*:(?!\/\/)\s*(.+)$/i);
  if (!m) return null;
  const name = normalizeName(m[1]!);
  let task = m[2]!.trim();
  let threshold: number | undefined;
  let condition: AlertCondition | undefined;
  let then: string | undefined;

  // Trigger-to-action (trigger-to-action-alerts): a trailing "then run <recipe>" / "then <recipe>"
  // means run that saved recipe on fire + append its result. Stripped FIRST (it's the outermost
  // clause) so the price/stock/feed parsing below still sees a clean task tail.
  const thenClause = task.match(/\s+then\s+(?:run\s+)?(?:recipe\s+)?([a-z0-9][\w -]{0,58})\s*$/i);
  if (thenClause) { then = normalizeName(thenClause[1]!); task = task.slice(0, thenClause.index).trim(); }

  // Weather-conditional (weather-conditional-alert): "watch umbrella: if it rains tomorrow" / "alert cold:
  // if it drops below freezing tonight". Requires a WEATHER cue word (rain/snow/wind/freez/temp-threshold)
  // so a plain "watch btc: ... below 50000" (no weather word) does NOT match. Checked before the numeric/
  // feed/page parsing (those clauses don't co-occur with a weather cue).
  // A weather cue: precip/wind words, OR a temperature framing (freezing/cold/hot/degrees/°) — the latter
  // lets "if it drops below 32°"/"if it's below freezing" be a weather alert, while a plain "if it goes
  // below 50000" (no temp/weather word) stays a numeric watch. parseWeatherCondition returns null anyway
  // if it can't build a condition, so this gate is just a cheap pre-filter.
  if (name && /\b(rains?|rainy|snows?|snowy|freez\w*|frost|wind\w*|gust\w*|umbrella|sunny|storm\w*|showers?|cold|chilly|hot|heat|temperature|degrees?)\b|°/i.test(task)) {
    const wx = parseWeatherCondition(task);
    if (wx) { const base = { name, task, weather: wx }; return then ? { ...base, then } : base; }
  }

  // Watchlist (watchlists): a SEMICOLON-separated task is a basket of sub-watches — "watch markets: btc
  // price; eth price; gold price" -> one grouped ping of only the members that moved. Checked before the
  // single-trigger parsing (which assumes one task). At least 2 non-empty parts required.
  const parts = task.split(";").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    if (!name) return null;
    // Labels are the member IDENTITY used by setMemberLasts — two similar tasks ("news on tesla model
    // 3" / "...model y") can derive the same 4-word label, so setMemberLasts would update the wrong one
    // and one member re-fires every check (watchlist-member-label-collision). Disambiguate duplicates
    // with a numeric suffix so every label is unique within the watchlist.
    const seen = new Map<string, number>();
    const members = parts.slice(0, MAX_WATCHLIST_MEMBERS).map((p) => {
      const base = memberLabel(p);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { label: n > 1 ? `${base} (${n})` : base, task: p };
    });
    // Carry a `then` recipe through the watchlist branch (watchlist-then-dropped) — the thenClause was
    // stripped above, so 'watch mk: btc; eth then run summary' should still run the recipe on a change.
    return then ? { name, task, members, then } : { name, task, members };
  }

  // Watch-any-page (watch-any-page-diff): a task that is essentially a bare URL means "ping when THIS
  // page changes" — fetched + diffed directly, no agent. Checked before feed/threshold (a URL has none
  // of those clauses). Carries a `then` recipe through like the others.
  const pageUrl = pageWatchUrl(task);
  if (pageUrl) {
    if (!name) return null;
    const base = { name, task: pageUrl, pageUrl };
    return then ? { ...base, then } : base;
  }

  // Feed-watch: a trailing "for new items/listings/jobs/posts" or a leading "new " in the task
  // ("watch jobs: new remote react roles") means notify on a NEW list entry, not a value change.
  const feedTail = task.match(/\s+for\s+new\s+(?:items?|listings?|jobs?|posts?|results?|entries|ones?)\s*$/i);
  let feed = false;
  if (feedTail) { feed = true; task = task.slice(0, feedTail.index).trim(); }
  else if (/^new\s+\S/i.test(task)) { feed = true; }

  // Operand grammar (threshold-suffix-drop): a magnitude suffix (k/m/mm/mn/bn/b/t/thousand/million/…)
  // AND an optional trailing currency word (usd/eur/dollars/…) are now accepted, mirroring extractValue
  // on the VALUE side. Before, "below 50k" / "above 1.2M" / "below 50,000 usd" failed the operand parse,
  // silently degrading the alert into a plain fire-on-every-wiggle change-watch (the exact opposite of
  // the crossing the user asked for) — and "50k"/"1.2M" is the dominant way people write price levels.
  const NUM = "(\\d+(?:,\\d{3})*(?:\\.\\d+)?)";
  const SFX = "\\s?(k|mm|mn|bn|b|m|t|thousand|million|billion|trillion)?";
  const CUR = "(?:\\s?(?:usd|eur|gbp|dollars?|euros?|pounds?))?";
  const below = task.match(new RegExp(`\\s+(?:when\\s+it\\s+)?(?:drops?\\s+)?(?:below|under|<)\\s+\\$?${NUM}${SFX}${CUR}\\s*$`, "i"));
  const above = task.match(new RegExp(`\\s+(?:when\\s+it\\s+)?(?:goes?\\s+|rises?\\s+)?(?:above|over|hits?|reaches?|>)\\s+\\$?${NUM}${SFX}${CUR}\\s*$`, "i"));
  const stock = task.match(/\s+(?:when\s+(?:it'?s\s+)?)?(?:back\s+)?in\s+stock\s*$/i);
  const th = task.match(new RegExp(`\\s+(?:when it changes\\s+)?by\\s+${NUM}${SFX}${CUR}\\s*$`, "i"));

  // A price/stock trigger takes precedence over the feed cue (an explicit number/stock clause is
  // unambiguous); only treat as a feed watch when no such trigger is present.
  if (below) { condition = { op: "below", operand: parseOperand(below[1]!, below[2]) }; task = task.slice(0, below.index).trim(); feed = false; }
  else if (above) { condition = { op: "above", operand: parseOperand(above[1]!, above[2]) }; task = task.slice(0, above.index).trim(); feed = false; }
  else if (stock) { condition = { op: "in_stock" }; task = task.slice(0, stock.index).trim(); feed = false; }
  else if (th) { threshold = parseOperand(th[1]!, th[2]); task = task.slice(0, th.index).trim(); feed = false; }

  if (!name || !task) return null;
  const base = feed ? { name, task, feed: true }
    : threshold !== undefined ? { name, task, threshold }
    : condition ? { name, task, condition }
    : { name, task };
  return then ? { ...base, then } : base;
}

/**
 * Parse a conversational EDIT of an existing alert's trigger (product-loop). Returns
 * {name, threshold?|condition?} or null. Lets a user retune an alert by talking instead of
 * delete+recreate:
 *   "change btc to below 45000"   "make btc fire under 200"   "set btc above 70000"
 *   "update btc to back in stock"  "change btc to by 500"
 * Only the trigger changes; the task + lastValue are preserved by the store. The trailing clause
 * reuses the same below/above/in-stock/by grammar as parseAlertCommand.
 */
export function parseAlertEdit(text: string): { name: string; threshold?: number; condition?: AlertCondition } | null {
  // "<verb> <name> [to|fire|so it fires] <clause>". Verb-anchored so it can't swallow a define.
  const m = text.trim().match(/^\s*(?:change|update|edit|set|make)\s+(?:alert\s+)?(.+?)\s+(?:to\s+|fire\s+|so\s+it\s+fires?\s+)?((?:when\s+|drops?\s+|goes?\s+|rises?\s+|back\s+)?(?:below|under|<|above|over|hits?|reaches?|>|in\s+stock|by)\b.*)$/i);
  if (!m) return null;
  const name = normalizeName(m[1]!);
  const clause = " " + m[2]!.trim();
  if (!name) return null;

  // Same operand grammar as parseAlertCommand (threshold-suffix-drop): scale a k/m/bn suffix + tolerate a
  // trailing currency word, so "change btc to below 45k" / "make btc fire under 1.2m" retune correctly
  // instead of silently failing to parse (leaving the old trigger in place — a confusing no-op).
  const NUM = "(\\d+(?:,\\d{3})*(?:\\.\\d+)?)";
  const SFX = "\\s?(k|mm|mn|bn|b|m|t|thousand|million|billion|trillion)?";
  const CUR = "(?:\\s?(?:usd|eur|gbp|dollars?|euros?|pounds?))?";
  const below = clause.match(new RegExp(`\\s+(?:when\\s+it\\s+)?(?:drops?\\s+)?(?:below|under|<)\\s+\\$?${NUM}${SFX}${CUR}\\s*$`, "i"));
  const above = clause.match(new RegExp(`\\s+(?:when\\s+it\\s+)?(?:goes?\\s+|rises?\\s+)?(?:above|over|hits?|reaches?|>)\\s+\\$?${NUM}${SFX}${CUR}\\s*$`, "i"));
  const stock = clause.match(/\s+(?:when\s+(?:it'?s\s+)?)?(?:back\s+)?in\s+stock\s*$/i);
  const th = clause.match(new RegExp(`\\s+by\\s+${NUM}${SFX}${CUR}\\s*$`, "i"));

  if (below) return { name, condition: { op: "below", operand: parseOperand(below[1]!, below[2]) } };
  if (above) return { name, condition: { op: "above", operand: parseOperand(above[1]!, above[2]) } };
  if (stock) return { name, condition: { op: "in_stock" } };
  if (th) return { name, threshold: parseOperand(th[1]!, th[2]) };
  return null;
}

/** First number found in a string (handles $, commas: "$65,000.50" -> 65000.5). null if none. */
export function firstNumber(s: string): number | null {
  const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/**
 * The SALIENT numeric value a watched task is tracking, or null. An agent reply is prose that
 * varies run-to-run ("Bitcoin is $65,000 as of 3pm" vs "BTC sits at $65,010 right now") and the
 * FIRST number is often a date/count, not the value — so instead of firstNumber we prefer, in order:
 *   1. a currency-tagged amount ($65,000.50 / 65,000 USD / €1.2)
 *   2. a decimal number (prices/rates usually have one)
 *   3. the largest-magnitude number (a price dwarfs a "3pm"/"1st")
 * PERCENTAGES are excluded from 2+3: "BTC up 2.5% at 68000" tracks 68000, not the 2.5 delta —
 * otherwise the decimal-preference grabbed 2.5 and every "below 50000"/"above 70000" predicate
 * fired/never-fired against a percent. A %-tagged number is only used if it's the ONLY number.
 * This is what makes a change-alert compare the real value, not the wording around it.
 */
// Magnitude suffixes: "$60k" is 60,000, "$1.2M" is 1,200,000. Without scaling, extractValue read the
// leading digits only (60, 1.2) and a "below 50000" price alert fired the instant the agent phrased
// the price as "$60k" — off by 3+ orders of magnitude, so the headline watch feature lied. Bare "m"/"t"
// are excluded from the untagged branch (a "3m ago" / "5t" in prose isn't millions/trillions); the
// currency-tagged branch is unambiguous so it accepts "m"/"mn"/"mm"/"t" too.
const MAG: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };
function magMult(sfx: string | undefined, allowBareMT: boolean): number {
  if (!sfx) return 1;
  const key = sfx.toLowerCase();
  if (!allowBareMT && (key === "m" || key === "t")) return 1;
  return MAG[key] ?? 1;
}

/** Parse an alert-OPERAND number string + optional magnitude suffix into its numeric value
 * (threshold-suffix-drop): strips in-number commas + scales k/m/bn/… so "50k"->50000, "1.2M"->1200000,
 * "50,000"->50000. allowBareMT is true here — an explicit trigger clause ("below 1.2m") unambiguously
 * means the magnitude, unlike free-text extraction where a bare "m"/"t" is risky. Exported for tests. */
export function parseOperand(numStr: string, suffix?: string): number {
  return parseFloat(numStr.replace(/,/g, "")) * magMult(suffix, true);
}

// Words in a watched task that DON'T identify the entity (so the entity-proximity hint keys on the real
// subject: "check the S&P 500 index" -> "s&p 500 index", not "check"/"the"). Kept small + generic.
const HINT_STOP = new Set(["check", "the", "a", "an", "of", "price", "cost", "value", "current", "latest", "whats", "what", "is", "for", "on", "in", "at", "my", "to", "watch", "track", "level", "quote", "how", "much", "s"]);

/** Positions (char offset) in `hay` where any salient token of `hint` occurs (lowercased). Used to bias
 * value extraction toward the number NEAREST the watched entity in a multi-number reply. */
function hintPositions(hay: string, hint: string): number[] {
  const toks = hint.toLowerCase().replace(/[^a-z0-9%&. ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !HINT_STOP.has(w));
  const pos: number[] = [];
  const low = hay.toLowerCase();
  for (const tok of toks) {
    let from = 0;
    for (;;) { const i = low.indexOf(tok, from); if (i < 0) break; pos.push(i); from = i + tok.length; }
  }
  return pos;
}

/**
 * The SALIENT numeric value a watched task is tracking, or null. See the block comment above for the
 * ordering (currency-tag > decimal > largest-magnitude). `hint` (the watched task text) disambiguates a
 * MULTI-number reply: "S&P 5,900, Dow 42,000" for a task about the S&P must track 5,900, not the biggest
 * number (extractvalue-largest-magnitude) — so when >1 candidate survives the ordering AND the hint's
 * entity words appear in the reply, pick the candidate NEAREST an entity mention rather than the largest.
 * With no hint (or no entity match), behavior is unchanged (largest-magnitude fallback).
 */
// A number sitting next to a "past value" marker is the OLD figure being compared against, not the
// current value (change-watch-tracks-historical-value): "$150 previously, now $120", "5 left, was 8",
// "up from 30 to 42". Tracking it means a price/stock watch compares the wrong number, so a "below 130"
// alert on "now $120, was $150" silently never fires. `start`/`end` are the candidate's char span in `t`.
function isHistoricalValue(t: string, start: number, end: number): boolean {
  const low = t.toLowerCase();
  const before = low.slice(Math.max(0, start - 14), start);
  // Unambiguous comparison markers BEFORE the number ("down from 30", "previously 150", "prior 8") —
  // "from" also covers "down from"/"up from". Allow a currency symbol/space between.
  if (/\b(?:from|previously|prior|earlier|before)\s*[$€£]?\s*$/.test(before)) return true;
  // "was"/"were" is AMBIGUOUS: "the rate was 1.085" is the CURRENT value in past tense, but "now $5, was
  // $8" is a comparison. Only treat "was N" as the old figure when the reply ALSO carries a current-value
  // cue (now/currently/today/left/remaining/in stock/at present) — otherwise it's just past-tense phrasing.
  if (/\b(?:was|were)\s*[$€£]?\s*$/.test(before) && /\b(?:now|currently|today|at present|left|remaining|in stock)\b/.test(low)) return true;
  // Marker immediately AFTER the number ("$150 previously", "8 last week", "10 a month ago").
  const after = low.slice(end, end + 16);
  if (/^\s*(?:previously|prior|earlier|before|last\s+(?:week|month|year)|a\s+(?:week|month|day|year)\s+ago|yesterday|ago)\b/.test(after)) return true;
  return false;
}

export function extractValue(s: string, hint?: string): number | null {
  const t = s.replace(/,/g, "");
  const hints = hint ? hintPositions(t, hint) : [];
  // Prefer CURRENT-value candidates: drop any adjacent to a past-value marker, unless that empties the
  // pool (then they're all we have). Keeps a watch tracking "now $120", not the "was $150" it beats.
  const dropHistorical = (cands: Array<{ v: number; at: number; end: number }>) => {
    const live = cands.filter((c) => !isHistoricalValue(t, c.at, c.end));
    return live.length ? live : cands;
  };
  // Numbers that appear IN the entity name ("S&P 500", "Nasdaq 100") are labels, not the value — a reply
  // "S&P 500 is at 5,900" must not track 500. Collect the hint's numeric tokens to exclude such matches.
  const hintNums = hint ? new Set((hint.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => parseFloat(n))) : new Set<number>();
  const nearestByHint = (cands: Array<{ v: number; at: number; end?: number }>): number => {
    // Drop candidates that are just the entity's label number (e.g. the "500" in "S&P 500"), unless that
    // leaves nothing. Only when a hint is present.
    const usable = hints.length ? (cands.filter((c) => !hintNums.has(c.v)).length ? cands.filter((c) => !hintNums.has(c.v)) : cands) : cands;
    if (hints.length && usable.length > 1) {
      // Financial phrasing is "<entity> <value>" ("Apple $230", "S&P 500 at 5,900"), so prefer the
      // number that comes closest AFTER an entity mention. A candidate before every entity mention (it
      // belongs to a different entity, "Nvidia $180, Apple ...") gets a large penalty. Ties -> earliest.
      const score = (c: { at: number }) => {
        const after = hints.filter((h) => c.at >= h).map((h) => c.at - h);
        return after.length ? Math.min(...after) : Infinity;
      };
      let best = usable[0]!, bestD = Infinity;
      for (const c of usable) { const d = score(c); if (d < bestD) { bestD = d; best = c; } }
      // If no candidate follows an entity mention, fall back to absolute-nearest.
      if (bestD === Infinity) {
        for (const c of usable) { const d = Math.min(...hints.map((h) => Math.abs(h - c.at))); if (d < bestD) { bestD = d; best = c; } }
      }
      return best.v;
    }
    return usable.reduce((a, b) => (Math.abs(b.v) > Math.abs(a.v) ? b : a)).v;
  };
  // currency-tagged first (symbol before, or code/word after) — scale a k/m/bn/billion suffix.
  const cur = [...t.matchAll(/(?:[$€£]\s?)(-?\d+(?:\.\d+)?)\s?(k|mm|mn|bn|b|m|t|thousand|million|billion|trillion)?\b|(-?\d+(?:\.\d+)?)\s?(k|mm|mn|bn|b|m|t|thousand|million|billion|trillion)?\s?(?:usd|eur|gbp|dollars?|euros?)/gi)];
  if (cur.length) {
    // Multiple currency amounts + a hint -> the one nearest the entity, else the first (prior behavior).
    const raw = cur.map((c) => ({ v: parseFloat((c[1] ?? c[3]!)) * magMult(c[1] !== undefined ? c[2] : c[4], true), at: c.index ?? 0, end: (c.index ?? 0) + c[0].length }));
    // Drop the "was $X"/"from $X"/"$X previously" comparison figure so the watch tracks the CURRENT price
    // (change-watch-tracks-historical-value), not the old one it's being compared against.
    const cands = dropHistorical(raw);
    if (hints.length && cands.length > 1) return nearestByHint(cands);
    return cands[0]!.v;
  }
  // Count-magnitude (watch-magnitude-suffix): a NON-currency count like "1.2M subscribers", "5B views",
  // "900k downloads" — the general untagged branch below excludes a bare "m"/"t" (to avoid "3m ago" /
  // "5t"), so "1.2M subscribers" collapsed to 1.2 and a "below 50000"/"above 2000000" predicate fired
  // against a value off by 6+ orders. Here a k/m/b/t/mn/bn suffix IS scaled when it's immediately
  // followed by a count noun (subscribers/followers/views/... — never a time word like "ago"/"min").
  const COUNT_NOUN = "(?:subscribers?|subs?|followers?|views?|downloads?|installs?|users?|stars?|tokens?|streams?|members?|likes?|reads?|plays?|watchers?|forks?|commits?|listeners?|readers?|viewers?|units?|copies|copy|sales?|orders?)";
  const countMag = [...t.matchAll(new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s?(k|mn|mm|bn|m|b|t|thousand|million|billion|trillion)\\s+${COUNT_NOUN}\\b`, "gi"))];
  if (countMag.length) {
    const cands = dropHistorical(countMag.map((c) => ({ v: parseFloat(c[1]!) * magMult(c[2], true), at: c.index ?? 0, end: (c.index ?? 0) + c[0].length })));
    if (hints.length && cands.length > 1) return nearestByHint(cands);
    return cands[0]!.v;
  }
  // Collect every number, flagging those immediately followed by % (a rate/change, not the value)
  // and scaling a trailing k/bn/billion/million/thousand magnitude suffix (bare m/t excluded here).
  // The suffix MUST be a true token end — a (?![a-z]) boundary (extractvalue-bare-kb-overscale): otherwise
  // a bare "k"/"b" glued to a word scaled a plain count wildly ("4 boxes"->4e9, "3 km"->3000, "2 kg"->2000,
  // "3 bedrooms"->3e9). A real magnitude ("$60k", "900k downloads", "1.3bn") isn't followed by a letter.
  const all: Array<{ v: number; at: number; end: number }> = [], nonPct: Array<{ v: number; at: number; end: number }> = [];
  for (const m of t.matchAll(/(-?\d+(?:\.\d+)?)\s?(?:(k|bn|b|thousand|million|billion|trillion)(?![a-z]))?(\s?%)?/gi)) {
    if (!m[1]) continue;
    const entry = { v: parseFloat(m[1]) * magMult(m[2], false), at: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
    all.push(entry);
    if (!m[3]) nonPct.push(entry);
  }
  if (!all.length) return null;
  // Prefer real (non-percent) numbers; fall back to percents only if that's all there is. Then drop any
  // "was X"/"X last week" comparison figure so a change-watch tracks the CURRENT number, not the old one.
  const pool = dropHistorical(nonPct.length ? nonPct : all);
  // A decimal is usually the price/rate — but with MULTIPLE decimals + a hint, pick the nearest entity.
  const decs = pool.filter((n) => !Number.isInteger(n.v));
  if (decs.length) return decs.length > 1 && hints.length ? nearestByHint(decs) : decs[0]!.v;
  return nearestByHint(pool);
}

// Common lead-ins the agent varies run-to-run without the underlying answer changing
// ("As of 3pm, the top story is X" vs "Right now the top story is X"). Stripped before comparing so
// a non-numeric watch doesn't false-fire on pure phrasing drift.
const PROSE_NOISE_RE = new RegExp(
  "\\b(?:" +
    "as of [\\w:apm. ]+?|right now|currently|at the moment|at present|today|this (?:morning|afternoon|evening)|" +
    "the (?:current|latest)|it'?s|it is|here'?s|here is|according to [\\w. ]+?|" +
    "\\d{1,2}:\\d{2}\\s?(?:am|pm)?|\\d{1,2}\\s?(?:am|pm)" +
  ")\\b",
  "gi",
);

/** Normalize a non-numeric reply to its stable content: lowercase, drop volatile lead-ins/timestamps,
 * strip punctuation, collapse whitespace. So "As of 3pm, the top story is X." and "Right now the top
 * story is X!" normalize equal and a watch on that prose doesn't false-fire every check. Exported for tests. */
export function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(PROSE_NOISE_RE, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drop punctuation/emoji, keep letters+digits
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Did the value change enough to notify? Compares the SALIENT VALUE, not raw prose — so a reply
 * whose wording drifted but whose tracked number is identical does NOT false-fire, and a real move
 * always does. If BOTH replies carry a value: with an explicit threshold, changed iff |new - prev| >=
 * threshold. WITHOUT a threshold, changed iff the move clears a small RELATIVE deadband (default 0.5%
 * of the previous value, env RELAY_ALERT_DEADBAND_PCT) — a bare "watch bitcoin price" must NOT ping on
 * every sub-cent tick (no-threshold-watch-firehose): alerts skip the anti-spam cap + quiet hours, so a
 * volatile price with a nonzero-delta rule trained users to mute the bot. The relative band still fires
 * a small-integer count (0.5% of 5 ≈ 0.025, so 5→6 clears it) and any move off zero. If neither side is
 * numeric: compare NORMALIZED text (lead-ins/timestamps/punctuation stripped) so pure phrasing drift on
 * a "watch top HN story" alert doesn't ping every check — only a real content change ("in stock" vs
 * "sold out") fires. First run (no prev) is handled by the caller.
 */
// Default no-threshold deadband as a FRACTION of the previous value. 0.5% filters price/quote jitter
// while staying far below any move a watcher would care about; env-tunable (given in PERCENT).
const DEFAULT_DEADBAND_PCT = 0.5;
function noThresholdBand(prev: number): number {
  const pct = Number(process.env.RELAY_ALERT_DEADBAND_PCT);
  const usePct = Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_DEADBAND_PCT;
  return Math.abs(prev) * (usePct / 100);
}
export function changed(prev: string, next: string, threshold?: number, hint?: string): boolean {
  const a = prev.trim(), b = next.trim();
  const pv = extractValue(a, hint), nv = extractValue(b, hint);
  if (pv !== null && nv !== null) {
    const delta = Math.abs(nv - pv);
    // Explicit threshold wins; otherwise require the move to clear the relative deadband (a move off a
    // zero baseline has band 0, so it still fires — 0 → anything is always meaningful).
    return threshold && threshold > 0 ? delta >= threshold : delta > noThresholdBand(pv);
  }
  // No comparable number on one/both sides — compare the MEANINGFUL content, not phrasing/whitespace.
  return normalizeForCompare(a) !== normalizeForCompare(b);
}

/** Parse a "how has <name> moved / trend / history" ask into the alert name + an optional lookback
 * window (ms), or null if it isn't one (watch-time-series). Handles "how has btc moved this week",
 * "btc trend", "history of btc", "btc over the last month". Window words: today/week/month; absent =
 * all recorded points. Name is normalized to match the alert store. */
export function parseTrendRequest(text: string, now: number): { name: string; sinceMs?: number } | null {
  const t = text.trim();
  const DAY = 86_400_000;
  const windowMs = /\btoday\b/i.test(t) ? DAY
    : /\bthis week\b|\bpast week\b|\blast (?:7 days|week)\b/i.test(t) ? 7 * DAY
    : /\bthis month\b|\bpast month\b|\blast (?:30 days|month)\b/i.test(t) ? 30 * DAY
    : undefined;
  const m =
    t.match(/^\s*how\s+(?:has|have|did|is)\s+(.+?)\s+(?:been\s+)?(?:moved?|moving|changed?|trend(?:ed|ing)?|doing|done|performed?)\b/i)
    || t.match(/^\s*(?:show|what'?s|whats|give)\s+(?:me\s+|us\s+)?(?:the\s+)?(.+?)\s+(?:trend|history|chart|over time)\b/i)
    || t.match(/^\s*(?:trend|history|chart)\s+(?:of|for)\s+(.+?)\s*$/i)
    || t.match(/^\s*(.+?)\s+(?:trend|history|over the (?:last|past)\s+\w+)\s*$/i);
  if (!m) return null;
  let name = m[1]!.trim().replace(/\b(this week|this month|today|over time|so far|lately|recently)\b/gi, "").trim();
  name = name.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").toLowerCase().slice(0, 60);
  if (!name) return null;
  return windowMs !== undefined ? { name, sinceMs: now - windowMs } : { name };
}

/** Summarize a numeric time series into a one-line human trend (watch-time-series): first→last with
 * delta + direction, min, max, and the sample count/span. `sinceMs` filters to points at/after it.
 * Returns null when there aren't at least 2 points in range (nothing to trend). Pure; for tests. */
export function summarizeSeries(points: Array<{ t: number; v: number }>, now: number, sinceMs?: number): string | null {
  const pts = (sinceMs !== undefined ? points.filter((p) => p.t >= sinceMs) : points).slice().sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const first = pts[0]!, last = pts[pts.length - 1]!;
  const vals = pts.map((p) => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const d = last.v - first.v;
  const arrow = d > 0 ? "↑" : d < 0 ? "↓" : "→";
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const pct = first.v !== 0 ? ` (${d >= 0 ? "+" : ""}${((d / Math.abs(first.v)) * 100).toFixed(1)}%)` : "";
  const spanDays = Math.max(1, Math.round((last.t - first.t) / 86_400_000));
  return `${fmt(first.v)} → ${fmt(last.v)} ${arrow}${fmt(Math.abs(d))}${pct} over ${pts.length} checks (~${spanDays}d). Low ${fmt(min)}, high ${fmt(max)}.`;
}

/**
 * A "good deal?" verdict for a current numeric value vs its recorded history (good-deal-price-verdict):
 * where does `current` sit in the range of past points? Turns a bare price answer/ping into a judgment
 * the user acts on ("lowest in 30d — good time to buy"). Returns null when there isn't enough history
 * to judge (< minPoints) so a fresh watch doesn't over-claim. `current` need not be in `points` yet.
 * Direction-agnostic on purpose: a LOW is framed as a buy signal, a HIGH as a sell/watch signal — the
 * user decides; we just place it in the range. Exported + pure.
 */
export function priceVerdict(
  points: Array<{ t: number; v: number }>,
  current: number,
  minPoints = 5,
): string | null {
  const vals = points.map((p) => p.v).filter((v) => Number.isFinite(v));
  if (vals.length < minPoints) return null;
  const min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) return null; // flat history — no meaningful range to place it in
  const spanDays = Math.max(1, Math.round((points[points.length - 1]!.t - points[0]!.t) / 86_400_000));
  const win = `${vals.length} checks (~${spanDays}d)`;
  // Position of current in [min,max]: 0 = at/below the recorded low, 1 = at/above the high.
  const pos = (current - min) / (max - min);
  if (current <= min) return `📉 Lowest in ${win} — a good time if you're buying.`;
  if (current >= max) return `📈 Highest in ${win} — pricey right now.`;
  if (pos <= 0.15) return `📉 Near its ${win} low — a good time if you're buying.`;
  if (pos >= 0.85) return `📈 Near its ${win} high — pricey right now.`;
  return `≈ Middle of its ${win} range (low ${fmtNum(min)}, high ${fmtNum(max)}).`;
}
function fmtNum(n: number): string { return Number.isInteger(n) ? String(n) : n.toFixed(2); }

export interface AlertStoreOptions { file: string; maxPerChat?: number; }

export class AlertStore {
  private file: string;
  private maxPerChat: number;
  private items: Alert[] = [];

  constructor(opts: AlertStoreOptions) {
    this.file = opts.file;
    this.maxPerChat = opts.maxPerChat ?? 50;
    this.load();
  }

  private load(): void {
    const obj = readJsonSafe<{ items?: Alert[] }>(this.file);
    if (obj && Array.isArray(obj.items)) this.items = obj.items.filter((a) => a && typeof a.name === "string" && typeof a.task === "string");
  }

  // Whether the LAST persist() write reached disk (persist-bool-all-stores) — read synchronously
  // right after save() to hedge a "watching X" confirmation when the write failed. Defaults true.
  private lastWriteOk = true;
  /** Did the most recent write to disk succeed? */
  lastSaveOk(): boolean { return this.lastWriteOk; }
  private persist(): boolean {
    return (this.lastWriteOk = atomicWriteJson(this.file, { v: 1, items: this.items }));
  }

  /** Add/overwrite by name (update-in-place, cap-exempt). */
  add(chatId: number, a: ParsedAlert, now: number): Alert | null {
    const name = normalizeName(a.name);
    const existing = this.items.find((x) => x.chatId === chatId && x.name === name);
    if (!existing && this.items.filter((x) => x.chatId === chatId).length >= this.maxPerChat) return null;
    if (existing) {
      // Did the TRIGGER actually change? (task, numeric threshold, or predicate condition). A re-define
      // that changes what we're watching for must reset the baseline so the NEW trigger edge-evaluates
      // fresh (watch-redefine-baseline-reset) — else the stale lastValue makes prevHolds compute from the
      // old value and an already-true predicate ('watch btc: bitcoin below 45000' when it's already below)
      // is suppressed forever: the just-set alert is silently dead. The conversational-edit path
      // (updateTrigger) already clears it; this is the define-overwrite path doing the same.
      const condChanged = JSON.stringify(existing.condition) !== JSON.stringify(a.condition);
      // pageUrl must be re-synced from the new command (alert-redefine-stale-fields): the old overwrite
      // branch never touched it, so re-defining a name AS a page-watch left pageUrl=undefined (ran the LLM
      // on a bare URL instead of page-diffing), and re-pointing a former page-watch to a value task left a
      // stale pageUrl (kept diffing the OLD page forever). The confirmation said one thing, the watch did
      // another. Set it (undefined clears it) + treat a change as a trigger change so state resets.
      const pageChanged = existing.pageUrl !== a.pageUrl;
      const triggerChanged = existing.task !== a.task || existing.threshold !== a.threshold || condChanged || pageChanged;
      existing.task = a.task; existing.threshold = a.threshold; existing.condition = a.condition; existing.then = a.then; existing.pageUrl = a.pageUrl;
      if (triggerChanged) {
        // Re-evaluate the new trigger from scratch AND drop the old series/flap so a re-pointed watch (e.g.
        // 'watch price: bitcoin' -> '...silver') doesn't stitch two entities' history into one phantom trend.
        existing.lastValue = undefined;
        existing.series = undefined;
        existing.flapCount = undefined;
      }
      // Switching an existing alert to/from a feed watch resets its baseline so the new mode seeds fresh.
      if (!!existing.feed !== !!a.feed) { existing.feed = a.feed; existing.seen = undefined; existing.lastValue = undefined; }
      // Re-following the same name can change the source (e.g. r/x -> a blog); reset seen so it reseeds.
      if (JSON.stringify(existing.feedSource) !== JSON.stringify(a.feedSource)) { existing.feedSource = a.feedSource; existing.seen = undefined; existing.lastValue = undefined; }
      // Re-defining to/from a weather-conditional (weather-conditional-alert): sync it + reset the baseline
      // so the new predicate edge-evaluates fresh (mirrors the pageUrl/feed reset).
      if (JSON.stringify(existing.weather) !== JSON.stringify(a.weather)) { existing.weather = a.weather; existing.lastValue = undefined; }
      // Re-stating a watchlist replaces its members (preserving each member's last value by label so an
      // unchanged member doesn't re-fire), or clears them when it's no longer a watchlist.
      if (a.members) {
        const prevLast = new Map((existing.members ?? []).map((m) => [m.label, m.last]));
        existing.members = a.members.map((m) => ({ label: m.label, task: m.task, last: prevLast.get(m.label) }));
      } else if (existing.members) {
        existing.members = undefined;
      }
      this.persist(); return existing;
    }
    const rec: Alert = { chatId, name, task: a.task, threshold: a.threshold, condition: a.condition, feed: a.feed, ...(a.weather ? { weather: a.weather } : {}), ...(a.pageUrl ? { pageUrl: a.pageUrl } : {}), ...(a.feedSource ? { feedSource: a.feedSource } : {}), then: a.then, members: a.members?.map((m) => ({ label: m.label, task: m.task })), created: now };
    this.items.push(rec);
    this.persist();
    return rec;
  }

  get(chatId: number, name: string): Alert | undefined {
    const n = normalizeName(name);
    return this.items.find((a) => a.chatId === chatId && a.name === n);
  }

  list(chatId: number): Alert[] {
    return this.items.filter((a) => a.chatId === chatId).sort((x, y) => x.name.localeCompare(y.name));
  }

  /** Retune an existing alert's trigger in place (conversational edit), preserving task + lastValue.
   * A threshold and a condition are mutually exclusive, so setting one clears the other. Returns the
   * updated record, or null if no alert by that name. */
  updateTrigger(chatId: number, name: string, patch: { threshold?: number; condition?: AlertCondition }): Alert | null {
    const a = this.get(chatId, name);
    if (!a) return null;
    if (patch.condition !== undefined) { a.condition = patch.condition; a.threshold = undefined; }
    else if (patch.threshold !== undefined) { a.threshold = patch.threshold; a.condition = undefined; }
    // Clear the baseline so the NEW trigger evaluates fresh (edge-triggered against no prior value):
    // an edit into an already-true predicate then fires on the immediate check-on-edit instead of
    // being suppressed by a lastValue captured under the old trigger.
    a.lastValue = undefined;
    this.persist();
    return a;
  }

  /** Record the latest observed value (after a check). */
  setLast(chatId: number, name: string, value: string): void {
    const a = this.get(chatId, name);
    if (a) { a.lastValue = value; this.persist(); }
  }

  /** Page-diff flap guard (page-diff-flap-guard): bump the consecutive-change counter on a page watch
   * that changed AGAIN this check; returns the new count. The runner uses it to auto-mute a page that
   * changes on every fetch (a firehose) rather than pinging forever. Reset with resetFlap. */
  bumpFlap(chatId: number, name: string): number {
    const a = this.get(chatId, name);
    if (!a) return 0;
    a.flapCount = (a.flapCount ?? 0) + 1;
    this.persist();
    return a.flapCount;
  }
  /** Clear a page watch's flap counter (an unchanged check). No-op if not found / already 0. */
  resetFlap(chatId: number, name: string): void {
    const a = this.get(chatId, name);
    if (a && a.flapCount) { a.flapCount = 0; this.persist(); }
  }

  /** Watchlist (watchlists): record the latest value of the members named in `updates` (by label), so
   * an unchanged member doesn't re-fire next check. Called by the caller's post-send commit. No-op if
   * the alert / member isn't found. */
  setMemberLasts(chatId: number, name: string, updates: Array<{ label: string; value: string }>): void {
    const a = this.get(chatId, name);
    if (!a?.members) return;
    let changed = false;
    for (const u of updates) {
      const m = a.members.find((x) => x.label === u.label);
      if (m && m.last !== u.value) { m.last = u.value; changed = true; }
    }
    if (changed) this.persist();
  }

  /** Time series (watch-time-series): append a numeric point {t,v} to the alert's series (capped,
   * oldest-first drop). No-op if the alert isn't found. Called after a check whose value parsed to a
   * number, so "how has X moved" can be answered from stored data. */
  recordPoint(chatId: number, name: string, v: number, t: number): void {
    const a = this.get(chatId, name);
    if (!a || !Number.isFinite(v)) return;
    const series = a.series ?? [];
    series.push({ t, v });
    a.series = series.length > MAX_SERIES_POINTS ? series.slice(series.length - MAX_SERIES_POINTS) : series;
    this.persist();
  }

  /** The recorded series for an alert (empty if none). */
  seriesOf(chatId: number, name: string): Array<{ t: number; v: number }> {
    return this.get(chatId, name)?.series ?? [];
  }

  /** Feed-watch (new-item-feed-watch): merge freshly-seen item keys into the alert's seen-set, capping
   * its size (oldest keys drop first). Called after a feed check so the newly-reported items aren't
   * re-notified next time. No-op if the alert isn't found. */
  recordSeen(chatId: number, name: string, keys: string[]): void {
    const a = this.get(chatId, name);
    if (!a) return;
    const merged = [...(a.seen ?? [])];
    const have = new Set(merged);
    for (const k of keys) { if (!have.has(k)) { merged.push(k); have.add(k); } }
    a.seen = merged.length > MAX_SEEN_KEYS ? merged.slice(merged.length - MAX_SEEN_KEYS) : merged;
    this.persist();
  }

  remove(chatId: number, name: string): boolean {
    const n = normalizeName(name);
    const before = this.items.length;
    this.items = this.items.filter((a) => !(a.chatId === chatId && a.name === n));
    const removed = this.items.length < before;
    if (removed) this.persist();
    return removed;
  }

  size(): number { return this.items.length; }
}
