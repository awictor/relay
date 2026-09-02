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

/** Substitute {slots} in a recipe task with the user's args. If the task has named slots, ALL of
 * them get the (single) arg string — recipes are simple, usually one slot ("track price of {item}").
 * Multiple distinct slot names each get the full arg string. A task with no {slot} is returned
 * unchanged (so a plain recipe run with stray args just ignores them). Exported for tests. */
export function applySlots(task: string, args: string): string {
  const a = args.trim();
  if (!/\{[a-z0-9_]+\}/i.test(task)) return task; // no slots — nothing to fill
  return task.replace(/\{[a-z0-9_]+\}/gi, a);
}

/** True if the task has at least one {slot}. Used to detect a slotted recipe run with no argument
 * (which would substitute empty + run a broken task) so the caller can ask for the value instead. */
export function hasSlots(task: string): boolean {
  return /\{[a-z0-9_]+\}/i.test(task);
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
