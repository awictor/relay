// Change-alerts (m10): a watched task runs on a schedule but only NOTIFIES when the result
// changes from last time ("tell me when the price of X drops"). Turns Relay from fetch-on-
// demand into watch-and-notify. Pure parse + compare + persistent store (JSON file, like
// RecipeStore). The runner (alert-2) compares new vs stored lastValue and sends only on change.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export interface Alert {
  chatId: number;
  name: string;        // unique per chat (lowercased)
  task: string;        // task run each check
  lastValue?: string;  // last agent reply, for change comparison
  threshold?: number;  // optional: only notify if a numeric value moved >= this much
  created: number;
}

export interface ParsedAlert {
  name: string;
  task: string;
  threshold?: number;
}

function normalizeName(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ").toLowerCase().slice(0, 60);
}

/**
 * Parse an alert definition. Returns {name, task, threshold?} or null.
 *   "alert me <name>: <task>"          "watch <name>: <task>"
 *   ... optionally trailing "when it changes by <n>" / "by <n>" -> numeric threshold.
 */
export function parseAlertCommand(text: string): ParsedAlert | null {
  const m = text.trim().match(/^\s*(?:alert(?:\s+me)?|watch)\s+([^:]+?)\s*:\s*(.+)$/i);
  if (!m) return null;
  const name = normalizeName(m[1]!);
  let task = m[2]!.trim();
  let threshold: number | undefined;
  const th = task.match(/\s+(?:when it changes\s+)?by\s+(\d+(?:\.\d+)?)\s*$/i);
  if (th) { threshold = parseFloat(th[1]!); task = task.slice(0, th.index).trim(); }
  if (!name || !task) return null;
  return { name, task, threshold };
}

/** First number found in a string (handles $, commas: "$65,000.50" -> 65000.5). null if none. */
export function firstNumber(s: string): number | null {
  const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/**
 * Did the value change enough to notify? Text: any non-trivial difference (trimmed). With a
 * threshold + both sides numeric: only when |new - prev| >= threshold. No prev (first run)
 * is treated as "changed" by the caller (seed + notify), so this only compares two values.
 */
export function changed(prev: string, next: string, threshold?: number): boolean {
  const a = prev.trim(), b = next.trim();
  if (a === b) return false;
  if (threshold && threshold > 0) {
    const pn = firstNumber(a), nn = firstNumber(b);
    if (pn !== null && nn !== null) return Math.abs(nn - pn) >= threshold;
  }
  return true;
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
    try {
      if (!existsSync(this.file)) return;
      const obj = JSON.parse(readFileSync(this.file, "utf8"));
      if (obj && Array.isArray(obj.items)) this.items = obj.items.filter((a: Alert) => a && typeof a.name === "string" && typeof a.task === "string");
    } catch { this.items = []; }
  }

  private persist(): void {
    try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify({ v: 1, items: this.items }), "utf8"); } catch { /* best-effort */ }
  }

  /** Add/overwrite by name (update-in-place, cap-exempt). */
  add(chatId: number, a: ParsedAlert, now: number): Alert | null {
    const name = normalizeName(a.name);
    const existing = this.items.find((x) => x.chatId === chatId && x.name === name);
    if (!existing && this.items.filter((x) => x.chatId === chatId).length >= this.maxPerChat) return null;
    if (existing) { existing.task = a.task; existing.threshold = a.threshold; this.persist(); return existing; }
    const rec: Alert = { chatId, name, task: a.task, threshold: a.threshold, created: now };
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
