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
 * This is what makes a change-alert compare the real value, not the wording around it.
 */
export function extractValue(s: string): number | null {
  const t = s.replace(/,/g, "");
  const nums: number[] = [];
  // currency-tagged first (symbol before, or code/word after)
  const cur = [...t.matchAll(/(?:[$€£]\s?)(-?\d+(?:\.\d+)?)|(-?\d+(?:\.\d+)?)\s?(?:usd|eur|gbp|dollars?|euros?)/gi)];
  if (cur.length) return parseFloat(cur[0]![1] ?? cur[0]![2]!);
  for (const m of t.matchAll(/-?\d+(?:\.\d+)?/g)) nums.push(parseFloat(m[0]));
  if (!nums.length) return null;
  const dec = nums.find((n) => !Number.isInteger(n));
  if (dec !== undefined) return dec;
  return nums.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
}

/**
 * Did the value change enough to notify? Compares the SALIENT VALUE, not raw prose — so a reply
 * whose wording drifted but whose tracked number is identical does NOT false-fire, and a real move
 * always does. If BOTH replies carry a value: changed iff |new - prev| >= (threshold || any nonzero
 * delta). If neither is numeric: fall back to trimmed-text inequality (e.g. "in stock"/"sold out").
 * First run (no prev) is handled by the caller (seed + notify).
 */
export function changed(prev: string, next: string, threshold?: number): boolean {
  const a = prev.trim(), b = next.trim();
  const pv = extractValue(a), nv = extractValue(b);
  if (pv !== null && nv !== null) {
    const delta = Math.abs(nv - pv);
    return threshold && threshold > 0 ? delta >= threshold : delta > 0;
  }
  // No comparable number on one/both sides — compare the meaningful text, not incidental whitespace.
  return a !== b;
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
