// Personal quick-log tracker (quick-log-tracker): "log weight 182", "spent $14 on lunch", "log mood 7"
// — text a tagged data point in seconds, then "show my weight this month" / "how much did I spend on
// food" comes back as a summary (+ a chart via the existing chart tool). Notes store FACTS, alerts watch
// EXTERNAL values — nothing captured the user's OWN time-series. This is the strongest daily-habit hook:
// a reason to text Relay every day. A tagged append-only store keyed by chatId+tag, reusing the
// summarizeSeries / chart {t,v} shape. Small atomic + corrupt-safe JSON (safe-store). Pure parse helpers
// exported + unit-tested. No key, no anvil.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

export interface LogPoint { t: number; v: number }
interface LogSeries { tag: string; points: LogPoint[]; unit?: string } // unit: "$" for spend, else bare
interface ChatLogs { chatId: number; series: LogSeries[] }

const MAX_TAGS_PER_CHAT = 50;
const MAX_POINTS_PER_TAG = 1000; // oldest-first drop past this (a chart/trend never needs more)
const MAX_TAG_LEN = 40;
const DAY = 86_400_000;

/** Parse a "log" command -> { tag, value, unit? }, or null. Forms:
 *   "log weight 182"          "log my weight 182 lbs"     "track mood 7"
 *   "spent $14 on lunch"      "spent 14 on groceries"     "log spent 14 food"  (money -> tag=the noun)
 * A money form ("spent $X on <thing>") tags by the THING (lunch/food) with unit "$"; a plain
 * "log <tag> <value>" tags by the given word. Exported for tests. */
export function parseLogCommand(text: string): { tag: string; value: number; unit?: string } | null {
  const t = text.trim();
  // A number that may carry thousands separators ("1,250", "$1,250.50") — commas stripped before
  // parseFloat (quick-log-thousands-comma): a rent/salary/bill log is exactly where the comma appears, and
  // the old \d+ pattern dropped the whole command silently on "spent $1,250 on rent".
  const num = (s: string) => parseFloat(s.replace(/,/g, ""));
  const NUM = "(-?\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|-?\\d+(?:\\.\\d+)?)";
  // Money: "spent $14 on lunch" / "spent 14 on food" / "paid $9 for parking" / "spent $1,250 on rent".
  const money = t.match(new RegExp(`^\\s*(?:i\\s+)?(?:spent|paid|logged?\\s+spending)\\s+\\$?${NUM}\\s*(?:on|for)\\s+(.+?)\\s*$`, "i"));
  if (money) {
    const tag = normalizeTag(money[2]!);
    if (tag) return { tag, value: num(money[1]!), unit: "$" };
  }
  // Value-FIRST: "log 3 coffees" / "track 2000 steps" / "record 5 miles" — the number leads, the noun is
  // the tag (quick-log-value-first). A very natural quick-log phrasing that the tag-first form below missed,
  // so counting habits (coffees/steps/miles/glasses) silently fell to null. Checked before the tag-first
  // form; only matches when a NUMBER immediately follows the verb, so "log weight 182" still takes tag-first.
  const valFirst = t.match(new RegExp(`^\\s*(?:log|track|record)\\s+${NUM}\\s+([a-z][\\w -]*?)\\s*$`, "i"));
  if (valFirst) {
    const tag = normalizeTag(valFirst[2]!);
    if (tag) return { tag, value: num(valFirst[1]!) };
  }
  // Generic: "log <tag> <value> [unit]" / "track <tag> <value>" — tag is a word(s), value a number.
  const gen = t.match(new RegExp(`^\\s*(?:log|track|record)\\s+(?:my\\s+)?([a-z][\\w -]*?)\\s+${NUM}\\s*([a-z$%°]+)?\\s*$`, "i"));
  if (gen) {
    const tag = normalizeTag(gen[1]!);
    if (!tag) return null;
    const unit = gen[3]?.trim();
    return { tag, value: num(gen[2]!), ...(unit ? { unit: unit.toLowerCase() } : {}) };
  }
  return null;
}

/** Parse a "show/how much <tag> [window]" query -> { tag, sinceMs?, mode }, or null. mode drives the
 * summary shape: "sum" for a spend total ("how much did I spend on food"), else "trend". Exported. */
export function parseLogQuery(text: string, now: number): { tag: string; sinceMs?: number; mode: "sum" | "trend" } | null {
  const t = text.trim();
  const windowMs = /\btoday\b/i.test(t) ? DAY
    : /\bthis week\b|\bpast week\b|\blast (?:7 days|week)\b/i.test(t) ? 7 * DAY
    : /\bthis month\b|\bpast month\b|\blast (?:30 days|month)\b/i.test(t) ? 30 * DAY
    : /\bthis year\b|\bpast year\b|\blast (?:365 days|year)\b/i.test(t) ? 365 * DAY
    : undefined;
  // "how much did I spend on food" / "how much on lunch this week" -> a SUM over the spend tag.
  const spend = t.match(/^\s*how\s+much\s+(?:did\s+i\s+|have\s+i\s+)?(?:spen[dt]|paid?)\s+(?:on\s+|for\s+)?(.+?)\s*\??\s*$/i);
  if (spend) {
    const tag = normalizeTag(stripWindow(spend[1]!));
    if (tag) return { tag, mode: "sum", ...(windowMs !== undefined ? { sinceMs: now - windowMs } : {}) };
  }
  // Count-sum: "how much coffee this week" / "how many coffees have I had" / "how many steps today" — a
  // SUM over a NON-money tag, the read side of the value-first "log 3 coffees" write (quick-log-count-query).
  // No spend verb (that's the branch above); tag is the noun after how-much/how-many. Window optional.
  const count = t.match(/^\s*how\s+(?:much|many)\s+(.+?)\s*\??\s*$/i);
  if (count) {
    const tag = normalizeTag(stripWindow(count[1]!).replace(/\b(?:have\s+i\s+had|did\s+i\s+(?:have|do|log)|i've\s+had|so\s+far)\b/gi, "").trim());
    if (tag) return { tag, mode: "sum", ...(windowMs !== undefined ? { sinceMs: now - windowMs } : {}) };
  }
  // "show my weight [this month]" / "my mood trend" / "my weight history". Require either an explicit
  // "show my <tag>" opener OR a trailing trend/history/log/chart word — a bare "what's the weather" (no
  // show-my, no trend word) is NOT a log query (it'd wrongly tag "weather"). "show my <tag>" itself is
  // fine because "my" scopes it to the user's own tracked data.
  const show = t.match(/^\s*(?:show|graph|plot)\s+(?:me\s+)?(?:my|the)\s+(.+?)(?:\s+(?:trend|history|chart|log|over time))?\s*\??\s*$/i)
    || t.match(/^\s*(?:my\s+)?(.+?)\s+(?:trend|history|log|chart)\s*\??\s*$/i);
  if (show) {
    const tag = normalizeTag(stripWindow(show[1]!));
    if (tag) return { tag, mode: "trend", ...(windowMs !== undefined ? { sinceMs: now - windowMs } : {}) };
  }
  return null;
}

function stripWindow(s: string): string {
  return s.replace(/\b(this week|this month|this year|today|over time|so far|lately|recently|trend|history|chart|log)\b/gi, "").trim();
}
function normalizeTag(s: string): string {
  let t = String(s ?? "").toLowerCase().replace(/^(?:my|the)\s+/i, "").replace(/[?.!,]+$/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LEN);
  // Singularize a trailing plural so the WRITE tag ("log 3 coffees" -> coffees) and the READ tag ("how
  // much coffee" -> coffee) converge on ONE series (quick-log-tag-plural): an exact-match store otherwise
  // splits them and the logged count can't be read back. "ss" (progress) + short words left alone; "ies"
  // -> "y" (calories->calorie is odd but consistent both ways, which is what matters for matching).
  const last = t.split(" ").pop() ?? "";
  if (last.length > 3 && !last.endsWith("ss")) {
    if (last.endsWith("ies")) t = t.slice(0, -3) + "y";
    else if (last.endsWith("s")) t = t.slice(0, -1);
  }
  return t;
}

export class LogStore {
  private file: string;
  private items: ChatLogs[] = [];
  constructor(opts: { file: string }) { this.file = opts.file; this.load(); }

  private load(): void {
    const obj = readJsonSafe<{ items?: ChatLogs[] }>(this.file);
    if (obj && Array.isArray(obj.items)) this.items = obj.items.filter((c) => c && typeof c.chatId === "number" && Array.isArray(c.series));
  }
  private lastWriteOk = true;
  lastSaveOk(): boolean { return this.lastWriteOk; }
  private persist(): boolean { return (this.lastWriteOk = atomicWriteJson(this.file, { v: 1, items: this.items })); }

  private forChat(chatId: number): ChatLogs {
    let c = this.items.find((x) => x.chatId === chatId);
    if (!c) { c = { chatId, series: [] }; this.items.push(c); }
    return c;
  }

  /** Append a data point to a tag (creating it), stamped `now`. Caps points (oldest-first) + tags per
   * chat. `unit` is set on first create + refreshed if given. Returns the point count + saved flag. */
  add(chatId: number, tag: string, value: number, now: number, unit?: string): { count: number; saved: boolean } | null {
    const c = this.forChat(chatId);
    let s = c.series.find((x) => x.tag === tag);
    if (!s) {
      if (c.series.length >= MAX_TAGS_PER_CHAT) return null; // too many distinct tags
      s = { tag, points: [], ...(unit ? { unit } : {}) };
      c.series.push(s);
    } else if (unit && !s.unit) s.unit = unit;
    s.points.push({ t: now, v: value });
    if (s.points.length > MAX_POINTS_PER_TAG) s.points.splice(0, s.points.length - MAX_POINTS_PER_TAG);
    return { count: s.points.length, saved: this.persist() };
  }

  /** The stored series for a tag (all points), or [] if none. */
  seriesOf(chatId: number, tag: string): LogPoint[] {
    return this.items.find((c) => c.chatId === chatId)?.series.find((s) => s.tag === tag)?.points ?? [];
  }
  unitOf(chatId: number, tag: string): string | undefined {
    return this.items.find((c) => c.chatId === chatId)?.series.find((s) => s.tag === tag)?.unit;
  }
  /** Tag names for a chat (for a "what am I logging" list). */
  tags(chatId: number): string[] {
    return this.items.find((c) => c.chatId === chatId)?.series.map((s) => s.tag) ?? [];
  }
  /** All series (tag + points + unit) for a chat — for the weekly-logs digest recap (logs-weekly-summary). */
  allSeries(chatId: number): Array<{ tag: string; points: LogPoint[]; unit?: string }> {
    return this.items.find((c) => c.chatId === chatId)?.series ?? [];
  }
}

/** Sum a series' values within an optional window (for a spend total). */
export function sumSeries(points: LogPoint[], sinceMs?: number): { total: number; count: number } {
  const pts = sinceMs !== undefined ? points.filter((p) => p.t >= sinceMs) : points;
  return { total: pts.reduce((a, p) => a + p.v, 0), count: pts.length };
}

// A reserved digest member that folds a weekly recap of the user's OWN trackers into a briefing
// (logs-weekly-summary) — the counterpart to the reading-list recap member. So "digest morning: weather,
// my logs" ends each briefing with "this week you logged: weight 182→180, spent $240 on food, 5 coffees".
const LOG_RECAP_MEMBER_NAMES = new Set(["my logs", "my trackers", "trackers", "my stats", "log recap", "weekly logs", "my week"]);
export function isLogRecapMember(name: string): boolean {
  return LOG_RECAP_MEMBER_NAMES.has(name.trim().toLowerCase());
}

/** Parse a weekly log-recap opt-in/opt-out (logs-recap-nudge-or-standalone), or null if it isn't one.
 *   ON:  "recap my logs weekly" / "weekly log recap" / "send me my logs weekly" / "weekly stats recap"
 *   OFF: "stop log recaps" / "turn off weekly logs" / "stop recapping my logs"
 * Distinct from the digest "my logs" MEMBER: this schedules a STANDALONE weekly send for a user who logs
 * but never built a digest. Exported for tests. */
export function parseLogRecapToggle(text: string): { on: boolean } | null {
  const t = text.trim().toLowerCase();
  if (/^\s*(?:stop|turn off|disable|cancel|no more)\b.*\b(?:log|logs|stats|tracker)\b.*\brecap|^\s*(?:stop|turn off|disable)\s+(?:my\s+)?(?:weekly\s+)?(?:log|logs|stats|tracker)s?\b/i.test(t)
      || /^\s*(?:stop|turn off|disable|cancel)\s+recapping\s+(?:my\s+)?(?:logs?|stats|trackers?)\b/i.test(t)) {
    return { on: false };
  }
  if (/^\s*(?:recap|summar(?:ize|y\s+of))\s+(?:my\s+)?(?:logs?|stats|trackers?)\s+(?:weekly|every\s+week)\b/i.test(t)
      || /^\s*(?:weekly\s+)?(?:log|logs|stats|tracker)s?\s+recaps?\b/i.test(t)
      || /^\s*(?:send|text)\s+me\s+(?:my\s+)?(?:logs?|stats|trackers?)\s+(?:weekly|every\s+week)\b/i.test(t)
      || /^\s*(?:weekly\s+)?(?:my\s+)?(?:logs?|stats|tracker)s?\s+(?:weekly|recap)\b/i.test(t)) {
    return { on: true };
  }
  return null;
}

/** One recap line for a tag over the window: a $ tag sums ("spent $240 on food, 12x"); a metric tag shows
 * first→last with an arrow ("weight 182→180 ↓2"); a bare count sums ("5 coffees"). Null if <1 point in window. */
function logRecapLine(tag: string, points: LogPoint[], unit: string | undefined, sinceMs: number): string | null {
  const pts = points.filter((p) => p.t >= sinceMs).sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  if (unit === "$") {
    const total = pts.reduce((a, p) => a + p.v, 0);
    return `spent $${fmt(total)} on ${tag}${pts.length > 1 ? ` (${pts.length}x)` : ""}`;
  }
  // A metric with movement (>=2 points) reads as a trend; a single reading just shows the value.
  if (pts.length >= 2) {
    const first = pts[0]!.v, last = pts[pts.length - 1]!.v, d = last - first;
    const arrow = d > 0 ? "↑" : d < 0 ? "↓" : "→";
    const move = d !== 0 ? ` ${arrow}${fmt(Math.abs(d))}` : "";
    return `${tag} ${fmt(first)}→${fmt(last)}${move}${unit && unit !== "$" ? ` ${unit}` : ""}`;
  }
  return `${tag} ${fmt(pts[0]!.v)}${unit && unit !== "$" ? ` ${unit}` : ""}`;
}

/** The proactive weekly-recap message for a "logrecap:" fire (logs-recap-nudge-or-standalone +
 * log-recap-empty-guidance), or null to stay silent. Three cases:
 *   - something logged this week -> the "📊 Your week in numbers" recap.
 *   - NEVER logged (empty store) + not yet nudged -> a one-time "how to log" heads-up (so a subscriber who
 *     never logged isn't met with silence forever). The caller records the nudge so it fires once.
 *   - logged before but a quiet week (or already nudged) -> null (a genuine no-news week isn't worth a ping).
 * Pure: takes the series + whether the empty-nudge already fired. Exported for tests. */
export function logRecapProactiveText(
  series: Array<{ tag: string; points: LogPoint[]; unit?: string }>,
  alreadyNudgedEmpty: boolean,
  now: number,
): { text: string; nudgedEmpty?: boolean } | null {
  const recap = logsWeeklySummary(series, now);
  if (recap) return { text: `📊 Your week in numbers\n${recap}` };
  if (series.length === 0 && !alreadyNudgedEmpty) {
    return {
      text: `📊 Your weekly log recap is on, but you haven't logged anything yet. Try "log weight 182", "spent $14 on lunch", or "log mood 7" — then I'll recap it here each week. (Say "stop log recaps" to turn this off.)`,
      nudgedEmpty: true,
    };
  }
  return null;
}

/** A weekly recap of ALL of a chat's trackers for a digest section (logs-weekly-summary), or null when
 * nothing was logged in the window (so the digest treats it as an empty member, not a failure). `windowMs`
 * defaults to 7 days. Pure — takes the already-read series list so it stays offline-testable. */
export function logsWeeklySummary(
  series: Array<{ tag: string; points: LogPoint[]; unit?: string }>,
  now: number,
  windowMs = 7 * DAY,
): string | null {
  const since = now - windowMs;
  const lines = series.map((s) => logRecapLine(s.tag, s.points, s.unit, since)).filter((l): l is string => l !== null);
  if (!lines.length) return null;
  return `this week you logged:\n${lines.map((l) => `  - ${l}`).join("\n")}`;
}
