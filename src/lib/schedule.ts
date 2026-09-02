// Scheduled/proactive tasks (m4): a user texts "remind me to X in 10m" or "check X
// every morning" and Relay fires the agent later, texting the result unprompted. This
// module is the pure parse + persistent store; the runner (schedule-runner.ts) polls it.
// Free-infra: a JSON file like MemoryStore — no external cron/DB. Clock is injected so
// parse + due-check are deterministic and unit-testable.

import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

export type ScheduleKind = "once" | "daily";

export interface Schedule {
  id: string;
  chatId: number;
  kind: ScheduleKind;
  task: string;        // the natural-language task to hand runAgent
  dueMs: number;       // next fire time (epoch ms)
  hourMin?: string;    // "HH:MM" local, for daily reschedule
  created: number;
}

export interface ParsedSchedule {
  kind: ScheduleKind;
  task: string;
  dueMs: number;
  hourMin?: string;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Strip a leading "remind me to"/"remind me"/"reminder:" so the stored task reads naturally.
function stripReminderPrefix(s: string): string {
  return s.replace(/^\s*(please\s+)?(remind me to|remind me|reminder:?|remember to)\s+/i, "").trim();
}

/**
 * Parse a natural scheduling phrase relative to `now`. Returns null if it isn't a
 * schedule request. Supported (case-insensitive):
 *   - "in N min/mins/minutes | N hour/hours | N day/days"  -> once
 *   - "tomorrow at 9am" / "tomorrow 9:30" / "at 5pm"        -> once
 *   - "every morning" (9am) / "every day at 8pm" / "daily at 07:00" -> daily
 * The task is whatever remains after removing the time clause + a reminder prefix.
 */
/**
 * Parse ONLY the timing from a clause and attach a caller-supplied task — for scheduling a
 * saved recipe ("schedule btc every morning" -> timing from "every morning", task = the
 * recipe's stored task). Reuses parseSchedule with a placeholder task, then swaps it in.
 */
export function parseScheduleFor(clause: string, task: string, now: number): ParsedSchedule | null {
  const p = parseSchedule(`${clause} __recipe__`, now);
  if (!p || !task.trim()) return null;
  return { ...p, task: task.trim() };
}

/**
 * Split a "schedule <name> <when>" command into the saved-item name and the trailing time
 * clause. The name may itself contain time-ish words ("check in", "log in", "my daily
 * report") — so a naive "split at the first every|in|at" truncates it (DEV-0129: `schedule
 * check in every morning` wrongly yielded name="check"). This scans split points left→right
 * and returns the FIRST where the trailing clause parses as a PURE time clause (nothing but
 * the cadence phrase remains, checked via a placeholder task), giving the longest name that
 * still leaves a clean clause. `text` is the full command including the leading "schedule".
 * An optional "recipe" keyword ("schedule recipe <name> <when>", DEV-0131) is stripped and
 * surfaced as `explicitRecipe` so the caller can force the recipe over a same-named digest.
 * Returns null if no split yields a parseable clause.
 */
export function splitScheduleCommand(text: string, now: number): { name: string; clause: string; explicitRecipe: boolean } | null {
  const m = text.trim().match(/^schedule\s+(?:(recipe)\s+)?(.+)$/i);
  if (!m) return null;
  const explicitRecipe = !!m[1];
  const tokens = m[2]!.trim().split(/\s+/);
  for (let k = 1; k < tokens.length; k++) {
    const name = tokens.slice(0, k).join(" ");
    const clause = tokens.slice(k).join(" ");
    const p = parseSchedule(`${clause} __recipe__`, now);
    if (p && p.task === "__recipe__") return { name, clause, explicitRecipe };
  }
  return null;
}

export function parseSchedule(text: string, now: number): ParsedSchedule | null {
  const raw = text.trim();
  const lower = raw.toLowerCase();

  // --- relative: "in 10 minutes", "in 2 hours", "in 1 day" ---
  const rel = lower.match(/\bin\s+(\d+)\s*(min(?:ute)?s?|hours?|hrs?|days?)\b/);
  if (rel) {
    const n = parseInt(rel[1]!, 10);
    const unit = rel[2]!;
    const ms = /^h/.test(unit) ? n * HOUR : /^d/.test(unit) ? n * DAY : n * MINUTE;
    const task = cleanTask(raw, rel[0]!);
    if (!task) return null;
    return { kind: "once", task, dueMs: now + ms };
  }

  // --- daily: "every morning", "every day at 8pm", "daily at 07:00" ---
  const daily = lower.match(/\b(every day|daily|every morning|every evening|every night)\b(?:\s+at\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?)?/);
  if (daily) {
    let hh: number, mm = 0;
    if (daily[2]) { hh = parseInt(daily[2], 10); mm = daily[3] ? parseInt(daily[3], 10) : 0; hh = to24h(hh, daily[4]); }
    else if (/morning/.test(daily[1]!)) hh = 9;
    else if (/evening/.test(daily[1]!)) hh = 18;
    else if (/night/.test(daily[1]!)) hh = 21;
    else hh = 9;
    const hourMin = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const task = cleanTask(raw, daily[0]!);
    if (!task) return null;
    return { kind: "daily", task, dueMs: nextDailyMs(now, hh, mm), hourMin };
  }

  // --- 24-hour clock: "at 14:30", "tomorrow at 09:00" (DEV-0189) ---
  // The am/pm branch below can't match a 24h time, but a COLON form "HH:MM" is unambiguous (it can't
  // be a stray bare integer), so accept it here. Hour 0-23, minute 00-59; requires the colon + 2-digit
  // minute so a lone "at 5" (no colon, no am/pm) still doesn't match.
  const at24 = lower.match(/\b(tomorrow\s+)?(?:at\s+)?([01]?[0-9]|2[0-3]):([0-5][0-9])\b(?!\s*(?:am|pm))/);
  if (at24) {
    const hh = parseInt(at24[2]!, 10);
    const mm = parseInt(at24[3]!, 10);
    let due = nextDailyMs(now, hh, mm);
    if (at24[1] && due - now < DAY) due += DAY; // "tomorrow" forces the next day if the time is still today
    const task = cleanTask(raw, at24[0]!);
    if (!task) return null;
    return { kind: "once", task, dueMs: due };
  }

  // --- absolute-ish: "tomorrow at 9am", "tomorrow 9:30", "at 5pm" (today or next day) ---
  const at = lower.match(/\b(tomorrow\s+)?(?:at\s+)?([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)\b/);
  if (at && (at[1] || at[4])) { // require "tomorrow" or an am/pm to avoid matching stray numbers
    const hh = to24h(parseInt(at[2]!, 10), at[4]);
    const mm = at[3] ? parseInt(at[3], 10) : 0;
    let due = nextDailyMs(now, hh, mm);
    if (at[1]) due = due <= now + DAY ? due : due; // "tomorrow" -> ensure at least today+1 handled by nextDailyMs
    if (at[1] && due - now < DAY) due += DAY; // force tomorrow if the time is still today
    const task = cleanTask(raw, at[0]!);
    if (!task) return null;
    return { kind: "once", task, dueMs: due };
  }

  return null;
}

function to24h(h: number, ampm?: string): number {
  if (!ampm) return h % 24;
  const pm = ampm.toLowerCase() === "pm";
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

// Timezone offset (minutes EAST of UTC) the user's "9am" is measured in. Default 0 = UTC. Set
// RELAY_TZ_OFFSET_MIN (e.g. -300 for US-Eastern EST, 60 for CET) so a daily fires at the user's
// wall-clock hour, not the deploy host's — on a UTC VM the old server-local setHours() made
// "every morning 9am" arrive at 9am UTC (middle of the night). Read at call time so it's tunable.
export function tzOffsetMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.RELAY_TZ_OFFSET_MIN);
  return Number.isFinite(n) ? n : 0;
}

// Next occurrence of hh:mm (in the user's timezone) at/after now, as an epoch-ms instant. Computes
// purely from UTC + the offset so it's independent of the SERVER's local zone (the bug this fixes).
export function nextDailyMs(now: number, hh: number, mm: number, offsetMin = tzOffsetMin()): number {
  // Shift into the user's zone, snap to today's hh:mm there, shift back to a UTC instant.
  const userNow = now + offsetMin * 60_000;
  const d = new Date(userNow);
  const atUser = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, 0, 0);
  let t = atUser - offsetMin * 60_000; // back to real UTC instant
  if (t <= now) t += DAY;
  return t;
}

function cleanTask(raw: string, timeClause: string): string {
  // Remove the time clause (case-insensitive) + reminder prefix + dangling connectors.
  const idx = raw.toLowerCase().indexOf(timeClause.toLowerCase());
  let s = idx >= 0 ? raw.slice(0, idx) + " " + raw.slice(idx + timeClause.length) : raw;
  s = stripReminderPrefix(s);
  return s.replace(/\s+/g, " ").replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, "").trim();
}

// --- persistent store (JSON file, gitignored — like MemoryStore) ---

export interface ScheduleStoreOptions {
  file: string;
  maxPerChat?: number;   // cap runaway scheduling (default 20)
}

export class ScheduleStore {
  private file: string;
  private maxPerChat: number;
  private items: Schedule[] = [];
  private seq = 0;

  constructor(opts: ScheduleStoreOptions) {
    this.file = opts.file;
    this.maxPerChat = opts.maxPerChat ?? 20;
    this.load();
  }

  private load(): void {
    const obj = readJsonSafe<{ items?: Schedule[]; seq?: number }>(this.file);
    if (!obj) return; // missing or corrupt (corrupt is backed up to .corrupt by readJsonSafe)
    if (Array.isArray(obj.items)) this.items = obj.items.filter((s) => s && typeof s.id === "string" && typeof s.dueMs === "number");
    if (typeof obj.seq === "number") this.seq = obj.seq;
  }

  private persist(): void {
    atomicWriteJson(this.file, { v: 1, seq: this.seq, items: this.items });
  }

  /** Add a schedule for a chat. Returns the stored record, or null if the chat is at its cap. */
  add(chatId: number, p: ParsedSchedule, now: number): Schedule | null {
    if (this.items.filter((s) => s.chatId === chatId).length >= this.maxPerChat) return null;
    const s: Schedule = { id: `s${++this.seq}`, chatId, kind: p.kind, task: p.task, dueMs: p.dueMs, hourMin: p.hourMin, created: now };
    this.items.push(s);
    this.persist();
    return s;
  }

  list(chatId: number): Schedule[] {
    return this.items.filter((s) => s.chatId === chatId).sort((a, b) => a.dueMs - b.dueMs);
  }

  /** Remove by id (optionally scoped to a chat). Returns true if something was removed. */
  remove(id: string, chatId?: number): boolean {
    const before = this.items.length;
    this.items = this.items.filter((s) => !(s.id === id && (chatId === undefined || s.chatId === chatId)));
    const removed = this.items.length < before;
    if (removed) this.persist();
    return removed;
  }

  /** Schedules due at/before now. */
  dueNow(now: number): Schedule[] {
    return this.items.filter((s) => s.dueMs <= now);
  }

  /** After firing: drop a "once", or advance a "daily" to its next occurrence. */
  complete(id: string, now: number): void {
    const s = this.items.find((x) => x.id === id);
    if (!s) return;
    if (s.kind === "daily" && s.hourMin) {
      const [hh, mm] = s.hourMin.split(":").map((n) => parseInt(n, 10));
      s.dueMs = nextDailyMs(now, hh!, mm!);
    } else {
      this.items = this.items.filter((x) => x.id !== id);
    }
    this.persist();
  }

  size(): number { return this.items.length; }
}
