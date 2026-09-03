// Persistent per-chat memory (DEV-0001). Relay kept per-chat context in an in-memory Map, so every
// redeploy/restart wiped it and the bot forgot mid-conversation. This backs that Map with a bounded
// JSON file: load on boot, save on each update. Free-infra (a local file, no DB), synchronous and
// tiny — memory is a handful of short message arrays, not a hot path.
//
// Bounds (both to keep the file + prompts small and stop unbounded growth from a chatty deployment):
//   - maxTurns: messages retained PER chat (the caller already trims; enforced here too as a floor).
//   - maxChats: distinct chats retained; when exceeded, the LEAST-RECENTLY-UPDATED chat is evicted.
// A corrupt/absent file loads as empty (never throws on boot — a bad file must not crash the bot).

import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

// Kept structural (not importing LLMMessage) so this module has no cycle with agent/llm; the caller
// stores whatever message shape it uses. `unknown[]` = an opaque per-chat context array.
export type ChatId = number;

export interface MemoryStoreOptions {
  file: string;          // path to the JSON file (gitignored); injectable for tests
  maxChats?: number;     // distinct chats before LRU eviction (default 500)
  maxTurns?: number;     // messages retained per chat (default 12 = 6 turns)
}

interface Entry { history: unknown[]; updated: number; }

export class MemoryStore {
  private file: string;
  private maxChats: number;
  private maxTurns: number;
  private map = new Map<ChatId, Entry>();
  // Did the most recent write to disk succeed? (memory-write-silent-fail) Every OTHER store tracks this
  // + exposes lastSaveOk() so the caller can hedge; conversation memory was the one store that ignored
  // atomicWriteJson's boolean, so a full/unwritable disk silently dropped the chat's context with no
  // notice to user or operator. Starts true (nothing written yet is not a failure).
  private lastWriteOk = true;

  /** Did the most recent persist reach disk? False after a failed write — the in-memory history is
   * live this session but won't survive a restart, so the caller can warn once (like the other stores). */
  lastSaveOk(): boolean { return this.lastWriteOk; }

  constructor(opts: MemoryStoreOptions) {
    this.file = opts.file;
    this.maxChats = opts.maxChats ?? 500;
    this.maxTurns = opts.maxTurns ?? 12;
    this.load();
  }

  // Load on construct. A missing or corrupt file is NOT fatal — start empty. This is why the bot
  // survives a first boot (no file yet) and a truncated write (partial JSON) without crashing.
  private load(): void {
    // Corrupt file is backed up to .corrupt by readJsonSafe (recoverable), then we start clean —
    // never throw on boot, never silently discard the file without a trace.
    const obj = readJsonSafe<{ chats?: Record<string, Entry> }>(this.file);
    if (obj && obj.chats && typeof obj.chats === "object") {
      for (const [k, v] of Object.entries(obj.chats)) {
        const e = v as Entry;
        if (e && Array.isArray(e.history)) {
          this.map.set(Number(k), { history: e.history.slice(-this.maxTurns), updated: Number(e.updated) || 0 });
        }
      }
    }
  }

  private persist(): void {
    const chats: Record<string, Entry> = {};
    for (const [k, v] of this.map) chats[String(k)] = v;
    // atomic temp+rename — a crash mid-write can't truncate memory. Track the result so a failed write
    // (full/unwritable disk) is visible via lastSaveOk() instead of being silently swallowed.
    this.lastWriteOk = atomicWriteJson(this.file, { v: 1, chats });
  }

  get(chatId: ChatId): unknown[] {
    return this.map.get(chatId)?.history ?? [];
  }

  // Store this chat's history (trimmed to maxTurns), stamp it, evict LRU past maxChats, persist.
  set(chatId: ChatId, history: unknown[], now: number = Date.now()): void {
    this.map.set(chatId, { history: history.slice(-this.maxTurns), updated: now });
    if (this.map.size > this.maxChats) {
      // Evict the least-recently-updated chat(s) down to the cap.
      const sorted = [...this.map.entries()].sort((a, b) => a[1].updated - b[1].updated);
      const toEvict = this.map.size - this.maxChats;
      for (let i = 0; i < toEvict; i++) {
        const victim = sorted[i];
        if (victim) this.map.delete(victim[0]);
      }
    }
    this.persist();
  }

  // Drop one chat's history (DEV-0023 /reset). Returns true if there was something to clear.
  // Persists so the wipe survives a restart. No-op (false) for an unknown chat.
  delete(chatId: ChatId): boolean {
    const had = this.map.delete(chatId);
    if (had) this.persist();
    return had;
  }

  size(): number {
    return this.map.size;
  }
}
