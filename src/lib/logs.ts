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
  // Money: "spent $14 on lunch" / "spent 14 on food" / "paid $9 for parking".
  const money = t.match(/^\s*(?:spent|paid|logged?\s+spending)\s+\$?(\d+(?:\.\d+)?)\s*(?:on|for)\s+(.+?)\s*$/i);
  if (money) {
    const tag = normalizeTag(money[2]!);
    if (tag) return { tag, value: parseFloat(money[1]!), unit: "$" };
  }
  // Generic: "log <tag> <value> [unit]" / "track <tag> <value>" — tag is a word(s), value a number.
  const gen = t.match(/^\s*(?:log|track|record)\s+(?:my\s+)?([a-z][\w -]*?)\s+(-?\d+(?:\.\d+)?)\s*([a-z$%°]+)?\s*$/i);
  if (gen) {
    const tag = normalizeTag(gen[1]!);
    if (!tag) return null;
    const unit = gen[3]?.trim();
    return { tag, value: parseFloat(gen[2]!), ...(unit ? { unit: unit.toLowerCase() } : {}) };
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
  return String(s ?? "").toLowerCase().replace(/^(?:my|the)\s+/i, "").replace(/[?.!,]+$/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LEN);
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
}

/** Sum a series' values within an optional window (for a spend total). */
export function sumSeries(points: LogPoint[], sinceMs?: number): { total: number; count: number } {
  const pts = sinceMs !== undefined ? points.filter((p) => p.t >= sinceMs) : points;
  return { total: pts.reduce((a, p) => a + p.v, 0), count: pts.length };
}
