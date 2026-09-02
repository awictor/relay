// Pending background errands (background-errand-persist): a detached "get back to me" run lives only
// in memory, so a deploy/crash mid-run silently drops a spoken promise ("On it — I'll text you when
// it's done") — the result never arrives. This is a tiny persistent record of in-flight errands so the
// worker can, on startup, re-run (or at least own up to) anything that was interrupted. Atomic +
// corrupt-safe JSON via safe-store, keyed by a per-errand id. Mirrors the other stores.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

export interface PendingErrand {
  id: string;      // unique per errand (chatId + timestamp + seq)
  chatId: number;
  text: string;    // the ORIGINAL user message, so a replay re-runs exactly what they asked
  startedAt: number;
}

// A safety cap: a pending errand older than this on startup is assumed abandoned/stuck (the process
// was down for a long time) — we tell the user it was interrupted rather than silently re-running a
// now-stale request. Also bounds the file.
export const STALE_ERRAND_MS = 6 * 3_600_000; // 6h

export class BackgroundStore {
  private file: string;
  private items: PendingErrand[] = [];
  private seq = 0;
  constructor(opts: { file: string }) { this.file = opts.file; this.load(); }

  private load(): void {
    const obj = readJsonSafe<{ items?: PendingErrand[]; seq?: number }>(this.file);
    if (obj && Array.isArray(obj.items)) this.items = obj.items.filter((e) => e && typeof e.id === "string" && typeof e.chatId === "number" && typeof e.text === "string");
    if (obj && typeof obj.seq === "number") this.seq = obj.seq;
  }
  private persist(): void { atomicWriteJson(this.file, { v: 1, seq: this.seq, items: this.items }); }

  /** Record a newly-dispatched errand; returns its stable id (pass to remove() when it settles). */
  add(chatId: number, text: string, now: number): string {
    const id = `bg${++this.seq}-${chatId}`;
    this.items.push({ id, chatId, text, startedAt: now });
    this.persist();
    return id;
  }

  /** Remove an errand once it has settled (delivered or failed). No-op if already gone. */
  remove(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((e) => e.id !== id);
    if (this.items.length !== before) this.persist();
  }

  /** All currently-pending errands (for startup replay). */
  list(): PendingErrand[] { return [...this.items]; }

  /** Drain the store: return everything pending + clear it (used at startup so a replay that itself
   * gets interrupted re-persists fresh entries rather than stacking the old ones). */
  drain(): PendingErrand[] {
    const all = [...this.items];
    if (all.length) { this.items = []; this.persist(); }
    return all;
  }

  size(): number { return this.items.length; }
}

/**
 * On startup, decide what to do with each errand that was in flight when the worker stopped
 * (background-errand-persist). Fresh ones (< STALE_ERRAND_MS old) are RE-RUN — the caller re-injects
 * the original message. Stale ones just get an honest "I was interrupted" note so an old promise isn't
 * silently dropped OR surprise-answered hours late. Pure decision fn; the caller does the I/O.
 * Returns, per errand, whether to replay + the message to send first.
 */
export function planErrandReplay(
  errands: PendingErrand[],
  now: number,
): Array<{ errand: PendingErrand; replay: boolean; notice: string }> {
  return errands.map((errand) => {
    const stale = now - errand.startedAt > STALE_ERRAND_MS;
    return stale
      ? { errand, replay: false, notice: `Earlier you asked me to "${errand.text}" and I got interrupted before finishing. Ask again if you still want it.` }
      : { errand, replay: true, notice: `I restarted while working on "${errand.text}" — picking it back up now.` };
  });
}
