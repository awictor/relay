// Named lists (personal-notes-lists-store): "add eggs to my grocery list", "what's on my grocery list",
// "remove milk from my list". Distinct from notes.ts (durable FACTS about the user, injected into every
// answer): a list is an editable collection the user reads back + checks items off. Small atomic +
// corrupt-safe JSON store keyed by chatId + list name, free-infra. Pure parse helpers exported + tested.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

interface List { name: string; items: string[] }
interface ChatLists { chatId: number; lists: List[] }

const MAX_LISTS_PER_CHAT = 20;
const MAX_ITEMS_PER_LIST = 100;
const MAX_ITEM_LEN = 200;

/** Normalize a list name: lowercased, trimmed, strip a leading "my "/"the " + a trailing "list". So
 * "my grocery list" / "the groceries" / "grocery" all key the same list. Empty -> "list" (a default). */
export function normalizeListName(raw: string): string {
  const n = String(raw ?? "").toLowerCase().replace(/^\s*(?:my|the)\s+/, "").replace(/\s+list\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return n || "list";
}

export type ListCommand =
  | { op: "add"; list: string; item: string }
  | { op: "remove"; list: string; item: string }
  | { op: "show"; list: string }
  | { op: "clear"; list: string };

/**
 * Parse a list command, or null. Handles:
 *   add:    "add eggs to my grocery list", "add milk and bread to groceries", "put oat milk on my list"
 *   remove: "remove milk from my grocery list", "cross off eggs", "check off bread"
 *   show:   "what's on my grocery list", "show my list", "my grocery list"
 *   clear:  "clear my grocery list", "empty my list"
 * Anchored so ordinary chat ("add a comment to the PR") that isn't a personal-list op mostly falls
 * through — an "add X to (my) <name> list" / "on my <name> list" shape is required. Exported for tests.
 */
export function parseListCommand(text: string): ListCommand | null {
  const t = text.trim();

  // clear / empty
  const clear = t.match(/^\s*(?:clear|empty|wipe)\s+(?:out\s+)?(?:my|the)\s+(.+?)\s*$/i);
  if (clear && /\blist\b/i.test(clear[1]!)) return { op: "clear", list: normalizeListName(clear[1]!) };

  // remove / cross off / check off  "<item>" from "<list>"
  const rem = t.match(/^\s*(?:remove|delete|cross\s+off|check\s+off|take)\s+(.+?)\s+(?:from|off)\s+(?:my|the)\s+(.+?)\s*$/i);
  if (rem) return { op: "remove", list: normalizeListName(rem[2]!), item: rem[1]!.trim() };

  // add / put  "<item>" to/on "<list>"
  const add = t.match(/^\s*(?:add|put|append)\s+(.+?)\s+(?:to|on|in)\s+(?:my|the)\s+(.+?)\s*$/i);
  if (add && /\blist\b/i.test(add[2]!)) return { op: "add", list: normalizeListName(add[2]!), item: add[1]!.trim() };

  // show:  "what's on my grocery list" / "show my list" / "my grocery list" (bare, ending in "list")
  const show = t.match(/^\s*(?:what'?s\s+(?:on|in)\s+(?:my|the)\s+(.+?)|show\s+(?:me\s+)?(?:my|the)\s+(.+?)|(?:my|the)\s+(.+?))\s*\??\s*$/i);
  if (show) {
    const raw = show[1] ?? show[2] ?? show[3] ?? "";
    if (/\blist\b/i.test(raw)) return { op: "show", list: normalizeListName(raw) };
  }
  return null;
}

/** Parse an "export/download my <name> list [as csv/a spreadsheet/a file]" command -> the list name,
 * or null (csv-export-tabular). A list read back as bullets is lost when the chat scrolls; this lets the
 * user keep it as a .csv document. Requires an export verb + a "list"-shaped target so a normal "show my
 * list" (which parseListCommand handles) isn't hijacked. Exported for tests. */
export function parseListExport(text: string): { list: string } | null {
  const m = text.trim().match(/^\s*(?:export|download|send|save)\s+(?:me\s+)?(?:my|the)\s+(.+?)(?:\s+(?:as|to)\s+(?:a\s+)?(?:csv|spreadsheet|excel|file|sheet|\.csv|\.xlsx?))?\s*$/i);
  if (!m) return null;
  const raw = m[1]!.trim();
  if (!/\blist\b/i.test(raw)) return null; // must target a named LIST, not "download my invoice"
  return { list: normalizeListName(raw) };
}

/** Split an add-item into multiple items on "and"/commas so "add milk and bread" adds two. Exported. */
export function splitItems(s: string): string[] {
  return s.split(/\s*,\s*|\s+and\s+/i).map((i) => i.replace(/[.;]+$/, "").trim()).filter(Boolean).slice(0, 20);
}

export class ListStore {
  private file: string;
  private items: ChatLists[] = [];
  constructor(opts: { file: string }) { this.file = opts.file; this.load(); }

  private load(): void {
    const obj = readJsonSafe<{ items?: ChatLists[] }>(this.file);
    if (obj && Array.isArray(obj.items)) this.items = obj.items.filter((c) => c && typeof c.chatId === "number" && Array.isArray(c.lists));
  }
  // Whether the LAST write reached disk — read right after remove/clear so a "removed"/"cleared"
  // confirmation can hedge a failed persist (delete-persist-hedge): an unhedged failed delete brings the
  // item back on restart, contradicting what the user was told. Defaults true (a read before any write).
  private lastWriteOk = true;
  lastSaveOk(): boolean { return this.lastWriteOk; }
  private persist(): boolean { return (this.lastWriteOk = atomicWriteJson(this.file, { v: 1, items: this.items })); }
  private forChat(chatId: number): ChatLists {
    let c = this.items.find((x) => x.chatId === chatId);
    if (!c) { c = { chatId, lists: [] }; this.items.push(c); }
    return c;
  }
  private getList(chatId: number, name: string): List | undefined {
    return this.items.find((c) => c.chatId === chatId)?.lists.find((l) => l.name === name);
  }

  /** Add items to a list (creating it, capped). Skips exact-dup items (case-insensitive). Returns the
   * items actually added + the full list after. Null if the per-chat list cap is hit on a NEW list. */
  add(chatId: number, name: string, items: string[]): { added: string[]; list: string[]; saved: boolean } | null {
    const c = this.forChat(chatId);
    let l = c.lists.find((x) => x.name === name);
    if (!l) {
      if (c.lists.length >= MAX_LISTS_PER_CHAT) return null;
      l = { name, items: [] }; c.lists.push(l);
    }
    const added: string[] = [];
    for (const raw of items) {
      const item = raw.slice(0, MAX_ITEM_LEN);
      if (!item || l.items.length >= MAX_ITEMS_PER_LIST) continue;
      if (l.items.some((x) => x.toLowerCase() === item.toLowerCase())) continue; // dedupe
      l.items.push(item); added.push(item);
    }
    // saved=false when the write failed — the caller must not confirm the addition as durable.
    const saved = this.persist();
    return { added, list: [...l.items], saved };
  }

  /** Remove list item(s) matching `item` by WHOLE-WORD relevance, NOT raw substring — so "remove milk"
   * doesn't also nuke "almond milk" / "milk chocolate" (lists-remove-substring-collateral; notes.ts was
   * already hardened the same way). Removes only the BEST tier: an exact (normalized) match wins alone;
   * else items containing ALL the query's words as whole words; else (only if neither) items sharing
   * SOME query words. Returns the removed items so the caller can show exactly what went. */
  remove(chatId: number, name: string, item: string): string[] {
    const l = this.getList(chatId, name);
    if (!l) return [];
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    const q = norm(item);
    if (!q) return [];
    const qWords = q.split(" ").filter(Boolean);
    const score = (x: string): number => {
      const xn = norm(x);
      if (xn === q) return 3;
      const words = new Set(xn.split(" "));
      const hits = qWords.filter((w) => words.has(w)).length;
      if (hits === 0) return 0;
      return hits === qWords.length ? 2 : 1;
    };
    const scored = l.items.map((x) => ({ x, s: score(x) }));
    const best = Math.max(0, ...scored.map((e) => e.s));
    if (best === 0) return [];
    const removed = scored.filter((e) => e.s === best).map((e) => e.x);
    l.items = l.items.filter((x) => !removed.includes(x));
    this.persist();
    return removed;
  }

  /** The items on a list (empty if none/unknown). */
  show(chatId: number, name: string): string[] { return this.getList(chatId, name)?.items ?? []; }

  /** Clear a list's items. Returns how many were removed. */
  clear(chatId: number, name: string): number {
    const l = this.getList(chatId, name);
    const n = l?.items.length ?? 0;
    if (l && n) { l.items = []; this.persist(); }
    return n;
  }

  /** Names of a chat's non-empty lists (for a /dashboard-style rollup or "which list?"). */
  names(chatId: number): string[] {
    return this.items.find((c) => c.chatId === chatId)?.lists.filter((l) => l.items.length).map((l) => l.name) ?? [];
  }
}
