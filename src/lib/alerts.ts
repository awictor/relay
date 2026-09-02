// Change-alerts (m10): a watched task runs on a schedule but only NOTIFIES when the result
// changes from last time ("tell me when the price of X drops"). Turns Relay from fetch-on-
// demand into watch-and-notify. Pure parse + compare + persistent store (JSON file, like
// RecipeStore). The runner (alert-2) compares new vs stored lastValue and sends only on change.

import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

export interface Alert {
  chatId: number;
  name: string;        // unique per chat (lowercased)
  task: string;        // task run each check
  lastValue?: string;  // last agent reply, for change comparison
  threshold?: number;  // optional: only notify if a numeric value moved >= this much
  condition?: AlertCondition; // optional: notify when a predicate holds (below/above/in-stock)
  created: number;
}

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
}

/** Evaluate a condition against an observed value string. below/above use extractValue; in_stock
 * looks for stock language. Returns null when the value can't be assessed (so the caller holds). */
export function conditionHolds(cond: AlertCondition, value: string): boolean | null {
  if (cond.op === "in_stock") {
    if (/\b(out of stock|sold out|unavailable|out-of-stock)\b/i.test(value)) return false;
    if (/\b(in stock|available|add to cart|buy now|in-stock)\b/i.test(value)) return true;
    return null; // ambiguous
  }
  const v = extractValue(value);
  if (v === null || cond.operand === undefined) return null;
  return cond.op === "below" ? v < cond.operand : v > cond.operand;
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
  const m = text.trim().match(/^\s*(?:alert(?:\s+me)?|watch)\s+([^:]+?)\s*:\s*(.+)$/i);
  if (!m) return null;
  const name = normalizeName(m[1]!);
  let task = m[2]!.trim();
  let threshold: number | undefined;
  let condition: AlertCondition | undefined;

  const below = task.match(/\s+(?:when\s+it\s+)?(?:drops?\s+)?(?:below|under|<)\s+\$?(\d+(?:,\d{3})*(?:\.\d+)?)\s*$/i);
  const above = task.match(/\s+(?:when\s+it\s+)?(?:goes?\s+|rises?\s+)?(?:above|over|hits?|reaches?|>)\s+\$?(\d+(?:,\d{3})*(?:\.\d+)?)\s*$/i);
  const stock = task.match(/\s+(?:when\s+(?:it'?s\s+)?)?(?:back\s+)?in\s+stock\s*$/i);
  const th = task.match(/\s+(?:when it changes\s+)?by\s+(\d+(?:\.\d+)?)\s*$/i);

  if (below) { condition = { op: "below", operand: parseFloat(below[1]!.replace(/,/g, "")) }; task = task.slice(0, below.index).trim(); }
  else if (above) { condition = { op: "above", operand: parseFloat(above[1]!.replace(/,/g, "")) }; task = task.slice(0, above.index).trim(); }
  else if (stock) { condition = { op: "in_stock" }; task = task.slice(0, stock.index).trim(); }
  else if (th) { threshold = parseFloat(th[1]!); task = task.slice(0, th.index).trim(); }

  if (!name || !task) return null;
  return threshold !== undefined ? { name, task, threshold } : condition ? { name, task, condition } : { name, task };
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

  const below = clause.match(/\s+(?:when\s+it\s+)?(?:drops?\s+)?(?:below|under|<)\s+\$?(\d+(?:,\d{3})*(?:\.\d+)?)\s*$/i);
  const above = clause.match(/\s+(?:when\s+it\s+)?(?:goes?\s+|rises?\s+)?(?:above|over|hits?|reaches?|>)\s+\$?(\d+(?:,\d{3})*(?:\.\d+)?)\s*$/i);
  const stock = clause.match(/\s+(?:when\s+(?:it'?s\s+)?)?(?:back\s+)?in\s+stock\s*$/i);
  const th = clause.match(/\s+by\s+(\d+(?:\.\d+)?)\s*$/i);

  if (below) return { name, condition: { op: "below", operand: parseFloat(below[1]!.replace(/,/g, "")) } };
  if (above) return { name, condition: { op: "above", operand: parseFloat(above[1]!.replace(/,/g, "")) } };
  if (stock) return { name, condition: { op: "in_stock" } };
  if (th) return { name, threshold: parseFloat(th[1]!) };
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
export function extractValue(s: string): number | null {
  const t = s.replace(/,/g, "");
  // currency-tagged first (symbol before, or code/word after)
  const cur = [...t.matchAll(/(?:[$€£]\s?)(-?\d+(?:\.\d+)?)|(-?\d+(?:\.\d+)?)\s?(?:usd|eur|gbp|dollars?|euros?)/gi)];
  if (cur.length) return parseFloat(cur[0]![1] ?? cur[0]![2]!);
  // Collect every number, flagging those immediately followed by % (a rate/change, not the value).
  const all: number[] = [], nonPct: number[] = [];
  for (const m of t.matchAll(/(-?\d+(?:\.\d+)?)(\s?%)?/g)) {
    if (!m[1]) continue;
    const n = parseFloat(m[1]);
    all.push(n);
    if (!m[2]) nonPct.push(n);
  }
  if (!all.length) return null;
  // Prefer real (non-percent) numbers; fall back to percents only if that's all there is.
  const pool = nonPct.length ? nonPct : all;
  const dec = pool.find((n) => !Number.isInteger(n));
  if (dec !== undefined) return dec;
  return pool.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
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
 * always does. If BOTH replies carry a value: changed iff |new - prev| >= (threshold || any nonzero
 * delta). If neither is numeric: compare NORMALIZED text (lead-ins/timestamps/punctuation stripped)
 * so pure phrasing drift on a "watch top HN story" alert doesn't ping every check — only a real
 * content change ("in stock" vs "sold out") fires. First run (no prev) is handled by the caller.
 */
export function changed(prev: string, next: string, threshold?: number): boolean {
  const a = prev.trim(), b = next.trim();
  const pv = extractValue(a), nv = extractValue(b);
  if (pv !== null && nv !== null) {
    const delta = Math.abs(nv - pv);
    return threshold && threshold > 0 ? delta >= threshold : delta > 0;
  }
  // No comparable number on one/both sides — compare the MEANINGFUL content, not phrasing/whitespace.
  return normalizeForCompare(a) !== normalizeForCompare(b);
}

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

  private persist(): void {
    atomicWriteJson(this.file, { v: 1, items: this.items });
  }

  /** Add/overwrite by name (update-in-place, cap-exempt). */
  add(chatId: number, a: ParsedAlert, now: number): Alert | null {
    const name = normalizeName(a.name);
    const existing = this.items.find((x) => x.chatId === chatId && x.name === name);
    if (!existing && this.items.filter((x) => x.chatId === chatId).length >= this.maxPerChat) return null;
    if (existing) { existing.task = a.task; existing.threshold = a.threshold; existing.condition = a.condition; this.persist(); return existing; }
    const rec: Alert = { chatId, name, task: a.task, threshold: a.threshold, condition: a.condition, created: now };
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
