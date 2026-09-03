// Saved recipes (m7): a user teaches Relay a task once and names it, then re-runs it by
// name or on a schedule. Compounding value — one-off asks become reusable automations.
// Pure parse + persistent store (JSON file, gitignored, like ScheduleStore). The handler
// (recipe-2) routes commands; scheduled recipes (recipe-3) bridge to ScheduleStore.

import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

export interface Recipe {
  chatId: number;
  name: string;       // unique per chat (lowercased key)
  task: string;       // the natural-language task handed to the agent
  schedule?: string;  // optional raw schedule phrase (parsed by schedule.ts when set)
  created: number;
}

export interface ParsedRecipe {
  name: string;
  task: string;
}

// Recognizes recipe-save phrasings. Returns {name,task} or null.
//   "save this as <name>"            -> name only (task = the PRIOR message; caller supplies)
//   "save <name>: <task>"            -> both
//   "save recipe <name>: <task>"     -> both
// Only the explicit "<name>: <task>" forms yield a task here; "save this as X" returns an
// empty task so the caller can attach context (kept simple: we require the colon form for a task).
export function parseRecipeCommand(text: string): ParsedRecipe | null {
  const t = text.trim();
  // "save [recipe] <name>: <task>"
  const m = t.match(/^\s*save(?:\s+recipe)?\s+([^:]+?)\s*:\s*(.+)$/i);
  if (m) {
    const name = normalizeName(m[1]!);
    const task = m[2]!.trim();
    if (name && task) return { name, task };
  }
  return null;
}

/** Recognize "save (that|this|the last one) as <name>" -> the recipe name, for capturing the task the
 * user JUST ran without retyping it (the caller supplies the task from the prior turn). Returns the
 * normalized name, or null if it isn't this form. Distinct from parseRecipeCommand's "save <name>: <task>". */
export function parseSaveThatAs(text: string): string | null {
  const m = text.trim().match(/^\s*save\s+(?:that|this|the\s+last(?:\s+one)?|it)\s+as\s+(.+)$/i);
  if (!m) return null;
  const name = normalizeName(m[1]!);
  return name || null;
}

/** "watch that [below N / above N / in stock / by N]" -> the trailing alert clause (or "" for a bare
 * "watch that"), or null if it isn't a watch-that. The caller supplies the task from the prior turn +
 * builds the alert. Zero-retype on-ramp from a one-off answer to a standing watch (watch-that-by-ref). */
export function parseWatchThat(text: string): { clause: string } | null {
  const m = text.trim().match(/^\s*(?:watch|alert\s+me\s+(?:on|about|if|when)?)\s+(?:that|this|it)\b\s*(.*)$/i);
  if (!m) return null;
  return { clause: m[1]!.trim() };
}

/** "schedule that <when>" / "every morning that" -> the timing clause, or null. Caller supplies the
 * task from the prior turn. Complements save-that-as for recurring schedules (watch-that-by-ref). */
export function parseScheduleThat(text: string): { clause: string } | null {
  const t = text.trim();
  // "schedule that every morning" / "schedule this at 9am"
  let m = t.match(/^\s*schedule\s+(?:that|this|it)\b\s+(.+)$/i);
  if (m) return { clause: m[1]!.trim() };
  // "do that every morning" / "run that daily" — verb + that + a cadence clause
  m = t.match(/^\s*(?:do|run|send)\s+(?:that|this|it)\b\s+((?:every|daily|each|weekdays?|weekends?|at\b).+)$/i);
  if (m) return { clause: m[1]!.trim() };
  return null;
}

/** Recognize a run command: "/run [recipe] <name>" or "run [recipe] <name>". The optional
 * "recipe" keyword (DEV-0130: explicit recipe intent so a same-named digest can't shadow it) is
 * stripped from BOTH the slash and natural forms. Returns the name or null. */
export function parseRunCommand(text: string): string | null {
  const t = text.trim();
  const slash = t.match(/^\/run\s+(?:recipe\s+)?(.+)$/i);
  if (slash) return normalizeName(slash[1]!);
  const nat = t.match(/^run\s+(?:recipe\s+)?(.+)$/i);
  if (nat) return normalizeName(nat[1]!);
  return null;
}

/** Parse a run command into { name, args } so a recipe can take values (product-loop). The FIRST
 * token after /run (or "run") is the recipe name; the rest is the argument string.
 *   "/run track sneakers"     -> { name: "track", args: "sneakers" }
 *   "run recipe morning"      -> { name: "morning", args: "" }
 * name is normalized like the store key. null if it isn't a run command. */
export function parseRunWithArgs(text: string): { name: string; args: string } | null {
  const t = text.trim();
  const m = t.match(/^(?:\/run|run)\s+(?:recipe\s+)?(\S+)\s*(.*)$/i);
  if (!m) return null;
  const name = normalizeName(m[1]!);
  if (!name) return null;
  return { name, args: m[2]!.trim() };
}

// Split a recipe task into sequential chain steps on the ">>" delimiter (recipe-chaining) — "find the
// cheapest flight to {city} >> then the weather + top news there >> summarize it all". Each step runs
// in order, the prior step's OUTPUT fed into the next as context, so a recipe becomes a small workflow.
// A step may start with "if <keyword>:" — the step only runs when the prior output contains <keyword>
// (case-insensitive), else the chain STOPS (a cheap conditional gate). Returns the ordered steps (the
// {text, ifContains?} shape); a task with no ">>" yields a single step (a plain recipe). Exported for tests.
export interface ChainStep { text: string; ifContains?: string }
// Cap chain length: each step is a full agent + browser run, so an unbounded chain (or a runaway one)
// would fan out into that many sequential runs on a single command. Extra steps past the cap are dropped.
export const MAX_CHAIN_STEPS = 6;
export function parseChainSteps(task: string): ChainStep[] {
  return task.split(/\s*>>\s*/).map((raw) => raw.trim()).filter(Boolean).slice(0, MAX_CHAIN_STEPS).map((s) => {
    const m = s.match(/^if\s+([^:]+?)\s*:\s*(.+)$/i);
    return m ? { text: m[2]!.trim(), ifContains: m[1]!.trim().toLowerCase() } : { text: s };
  });
}
export function isChain(task: string): boolean { return task.includes(">>"); }

// The distinct {slot} names in a task, in first-appearance order. Exported for tests.
export function slotNames(task: string): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const m of task.matchAll(/\{([a-z0-9_]+)\}/gi)) {
    const n = m[1]!.toLowerCase();
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

/** Substitute {slots} in a recipe task with the user's args (multi-slot-recipes). Filling rules:
 *   - No slots: task returned unchanged (stray args ignored).
 *   - ONE distinct slot: the whole arg string fills it ("track price of {item}" + "oat milk").
 *   - MULTIPLE distinct slots: args are matched by NAME when given as "name=value" pairs
 *     ("track {item} at {store}" + "item=milk store=HEB"); otherwise by POSITION, splitting the arg
 *     string on commas then whitespace ("track {item} at {store}" + "milk, HEB"). A slot with no
 *     matching arg is left blank. This is what makes a parameterized recipe with 2+ slots actually
 *     usable instead of stuffing one value into every slot. Exported for tests. */
export function applySlots(task: string, args: string): string {
  const names = slotNames(task);
  if (names.length === 0) return task;
  const a = args.trim();
  if (names.length === 1) return task.replace(/\{[a-z0-9_]+\}/gi, a);

  // Multiple slots: try name=value pairs first.
  const byName = new Map<string, string>();
  const pairRe = /([a-z0-9_]+)\s*=\s*("([^"]*)"|\S+)/gi;
  let m: RegExpExecArray | null, sawPair = false;
  while ((m = pairRe.exec(a)) !== null) { sawPair = true; byName.set(m[1]!.toLowerCase(), (m[3] ?? m[2])!); }
  if (sawPair) {
    return task.replace(/\{([a-z0-9_]+)\}/gi, (_full, n: string) => byName.get(n.toLowerCase()) ?? "");
  }
  // Else positional: split on commas (preferred) or whitespace, map to slots in order.
  const parts = (a.includes(",") ? a.split(",") : a.split(/\s+/)).map((p) => p.trim()).filter(Boolean);
  const pos = new Map(names.map((n, i) => [n, parts[i] ?? ""]));
  return task.replace(/\{([a-z0-9_]+)\}/gi, (_full, n: string) => pos.get(n.toLowerCase()) ?? "");
}

/** True if the task has at least one {slot}. Used to detect a slotted recipe run with no argument
 * (which would substitute empty + run a broken task) so the caller can ask for the value instead. */
export function hasSlots(task: string): boolean {
  return /\{[a-z0-9_]+\}/i.test(task);
}

/** Would applySlots mis-fill this multi-slot recipe (multi-slot-multiword-value)? For 2+ distinct slots
 * filled POSITIONALLY (no name=value pairs, no commas) the arg string is whitespace-split, so a
 * multi-word value silently corrupts the mapping ("oat milk HEB" -> item="oat", store="milk", drops
 * "HEB"). Ambiguous exactly when: >1 slot, args non-empty, no name=value pair, no comma, and the
 * whitespace token count != the slot count. A comma or name=value form is unambiguous; a matching token
 * count is taken at face value. Lets the caller ask for a clearer form instead of a confident wrong run. */
export function slotsAmbiguous(task: string, args: string): boolean {
  const names = slotNames(task);
  if (names.length < 2) return false;
  const a = args.trim();
  if (!a) return false; // handled by the missing-arg path
  if (/[a-z0-9_]+\s*=\s*\S/i.test(a)) return false; // name=value pairs -> unambiguous
  if (a.includes(",")) return false;                 // comma-separated -> unambiguous
  return a.split(/\s+/).filter(Boolean).length !== names.length; // token/slot mismatch -> ambiguous
}

function normalizeName(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ").toLowerCase().slice(0, 60);
}

export interface RecipeStoreOptions {
  file: string;
  maxPerChat?: number;
}

export class RecipeStore {
  private file: string;
  private maxPerChat: number;
  private items: Recipe[] = [];

  constructor(opts: RecipeStoreOptions) {
    this.file = opts.file;
    this.maxPerChat = opts.maxPerChat ?? 50;
    this.load();
  }

  private load(): void {
    const obj = readJsonSafe<{ items?: Recipe[] }>(this.file);
    if (obj && Array.isArray(obj.items)) {
      this.items = obj.items.filter((r) => r && typeof r.name === "string" && typeof r.task === "string");
    }
  }

  private persist(): void {
    atomicWriteJson(this.file, { v: 1, items: this.items });
  }

  /** Add or overwrite a recipe by name. Returns the record, or null if the chat is at cap
   * (a name that already exists updates in place and never counts against the cap). */
  add(chatId: number, r: ParsedRecipe & { schedule?: string }, now: number): Recipe | null {
    const name = normalizeName(r.name);
    const existing = this.items.find((x) => x.chatId === chatId && x.name === name);
    if (!existing && this.items.filter((x) => x.chatId === chatId).length >= this.maxPerChat) return null;
    if (existing) {
      existing.task = r.task;
      existing.schedule = r.schedule;
      this.persist();
      return existing;
    }
    const rec: Recipe = { chatId, name, task: r.task, schedule: r.schedule, created: now };
    this.items.push(rec);
    this.persist();
    return rec;
  }

  get(chatId: number, name: string): Recipe | undefined {
    const n = normalizeName(name);
    return this.items.find((r) => r.chatId === chatId && r.name === n);
  }

  list(chatId: number): Recipe[] {
    return this.items.filter((r) => r.chatId === chatId).sort((a, b) => a.name.localeCompare(b.name));
  }

  remove(chatId: number, name: string): boolean {
    const n = normalizeName(name);
    const before = this.items.length;
    this.items = this.items.filter((r) => !(r.chatId === chatId && r.name === n));
    const removed = this.items.length < before;
    if (removed) this.persist();
    return removed;
  }

  size(): number { return this.items.length; }
}
