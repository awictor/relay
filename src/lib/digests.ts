// Digests (m9): bundle several saved recipes into one named digest that runs them and
// sends a single combined message ("morning briefing" = weather + HN + btc). Compounding
// on recipes (m7) + scheduler (m4): one curated message instead of N proactive pings.
// Pure parse + persistent store (JSON file, gitignored, like RecipeStore/ScheduleStore).

import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

export interface Digest {
  chatId: number;
  name: string;       // unique per chat (lowercased)
  members: string[];  // recipe names (lowercased), in order
  schedule?: string;  // optional raw schedule phrase
  created: number;
}

export interface ParsedDigest {
  name: string;
  members: string[];
}

function normalizeName(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ").toLowerCase().slice(0, 60);
}

/**
 * Parse a digest definition. Returns {name, members} or null.
 *   "define digest <name>: <recipe1>, <recipe2>, ..."
 *   "digest <name>: <recipe1>, <recipe2>"
 * Members are comma-separated recipe names (normalized). Empty members -> null.
 */
export function parseDigestCommand(text: string): ParsedDigest | null {
  const m = text.trim().match(/^\s*(?:define\s+)?digest\s+([^:]+?)\s*:\s*(.+)$/i);
  if (!m) return null;
  const name = normalizeName(m[1]!);
  const members = m[2]!.split(",").map((s) => normalizeName(s)).filter(Boolean);
  if (!name || members.length === 0) return null;
  return { name, members };
}

export interface DigestStoreOptions {
  file: string;
  maxPerChat?: number;
  maxMembers?: number;
}

export class DigestStore {
  private file: string;
  private maxPerChat: number;
  private maxMembers: number;
  private items: Digest[] = [];

  constructor(opts: DigestStoreOptions) {
    this.file = opts.file;
    this.maxPerChat = opts.maxPerChat ?? 20;
    this.maxMembers = opts.maxMembers ?? 10;
    this.load();
  }

  private load(): void {
    const obj = readJsonSafe<{ items?: Digest[] }>(this.file);
    if (obj && Array.isArray(obj.items)) {
      this.items = obj.items.filter((d) => d && typeof d.name === "string" && Array.isArray(d.members));
    }
  }

  // Whether the LAST persist() write reached disk (persist-bool-all-stores) — read synchronously
  // right after define() to hedge a confirmation when the write failed. Defaults true.
  private lastWriteOk = true;
  /** Did the most recent write to disk succeed? */
  lastSaveOk(): boolean { return this.lastWriteOk; }
  // Members dropped by the per-digest cap on the LAST add() (digest-recipe-cap-silent-drop). Read right
  // after add() (no await between) so the caller can warn "kept the first N, dropped X" instead of the
  // tail silently vanishing. Empty when nothing was capped.
  private lastDropped: string[] = [];
  lastDroppedForCap(): string[] { return this.lastDropped; }
  private persist(): boolean {
    return (this.lastWriteOk = atomicWriteJson(this.file, { v: 1, items: this.items }));
  }

  /** Add/overwrite a digest by name. Members capped. Returns record, or null if at chat cap
   * (an update to an existing name is cap-exempt). */
  add(chatId: number, d: ParsedDigest & { schedule?: string }, now: number): Digest | null {
    const name = normalizeName(d.name);
    // Dedup members (order-preserving) BEFORE the cap (DEV-0194): a repeated recipe ("hn, hn, btc")
    // would otherwise run the same recipe twice, duplicate its briefing section, and burn a second
    // bounded anvil session per dup. A Set keyed on the normalized name collapses repeats to the first.
    const seen = new Set<string>();
    const deduped = d.members
      .map(normalizeName)
      .filter((m) => m && !seen.has(m) && (seen.add(m), true));
    const members = deduped.slice(0, this.maxMembers);
    // Members dropped BECAUSE the digest is full (not dedupe) — surfaced so a user defining a huge digest
    // is told the tail didn't fit instead of it silently vanishing (digest-recipe-cap-silent-drop). Reset
    // each add; read via lastDroppedForCap() right after, like lastSaveOk().
    this.lastDropped = deduped.slice(this.maxMembers);
    if (members.length === 0) return null;
    const existing = this.items.find((x) => x.chatId === chatId && x.name === name);
    if (!existing && this.items.filter((x) => x.chatId === chatId).length >= this.maxPerChat) return null;
    if (existing) {
      existing.members = members;
      existing.schedule = d.schedule;
      this.persist();
      return existing;
    }
    const rec: Digest = { chatId, name, members, schedule: d.schedule, created: now };
    this.items.push(rec);
    this.persist();
    return rec;
  }

  get(chatId: number, name: string): Digest | undefined {
    const n = normalizeName(name);
    return this.items.find((d) => d.chatId === chatId && d.name === n);
  }

  list(chatId: number): Digest[] {
    return this.items.filter((d) => d.chatId === chatId).sort((a, b) => a.name.localeCompare(b.name));
  }

  remove(chatId: number, name: string): boolean {
    const n = normalizeName(name);
    const before = this.items.length;
    this.items = this.items.filter((d) => !(d.chatId === chatId && d.name === n));
    const removed = this.items.length < before;
    if (removed) this.persist();
    return removed;
  }

  size(): number { return this.items.length; }
}
