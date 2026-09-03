// Per-user long-term memory (remember-facts-store): a user tells Relay a durable fact once
// ("remember my wife's birthday is June 3", "remember I'm vegetarian") and every future answer is
// filtered through it. Chat history is a short rolling window wiped by /reset — this is the persistent
// key-value note store, keyed by chatId, injected into the agent's context like the profile line.
// Small atomic + corrupt-safe JSON store (safe-store), free-infra. Mirrors ProfileStore.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

export interface Note {
  text: string;    // the remembered fact, verbatim-ish (prefix stripped, trimmed)
  created: number;  // epoch ms, for stable ordering + "forget the oldest" if ever capped
}
interface ChatNotes { chatId: number; notes: Note[] }

// A remembered fact is capped per chat so the injected context can't grow unbounded (and blow the
// model's context / cost). Oldest-first drop when over.
const MAX_NOTES_PER_CHAT = 30;
const MAX_NOTE_LEN = 300;

/** Parse a "remember X" command -> the fact to store, or null if it isn't one.
 *   "remember my wife's birthday is June 3"   "remember that I'm vegetarian"
 *   "note that I park in section G"           "/remember the wifi code is swordfish"
 * NOT a reminder ("remember to call mom" / "remind me to X") — that's a scheduled task, handled
 * elsewhere; a trailing time clause also disqualifies it so it reaches the scheduler instead. */
export function parseRemember(text: string): string | null {
  const m = text.trim().match(/^\s*(?:\/remember|remember|note)\s+(?:that\s+)?(.+)$/i);
  if (!m) return null;
  let fact = m[1]!.trim();
  // "remember to X" is a to-do, not a fact — let it fall through to the scheduler / reminder path.
  if (/^to\s+/i.test(fact)) return null;
  // Trim trailing sentence punctuation, then surrounding quotes (order matters: `"…".` leaves a `"`
  // if quotes are stripped before the period).
  fact = fact.replace(/[.;]\s*$/, "").replace(/^["']|["']$/g, "").replace(/[.;]\s*$/, "").trim().slice(0, MAX_NOTE_LEN);
  return fact || null;
}

/** Parse a "forget X" fact-recall command -> a match term, or a "clear all" sentinel, or null.
 *   "forget that I'm vegetarian"  -> "i'm vegetarian"   (fuzzy delete by substring)
 *   "forget what you know" / "forget everything you know about me" -> { all: true }
 * Scoped to FACT-forget phrasings so it doesn't collide with /forget <recipe-name>. */
export function parseForgetFact(text: string): { term: string } | { all: true } | null {
  const t = text.trim();
  if (/^\s*forget\s+(?:everything|all|what)\b.*\byou\s+know\b/i.test(t) || /^\s*forget\s+(?:everything|all)\s+about\s+me\b/i.test(t)) {
    return { all: true };
  }
  const m = t.match(/^\s*forget\s+(?:that\s+|the\s+fact\s+that\s+)(.+)$/i);
  if (!m) return null;
  const term = m[1]!.trim().replace(/^["']|["']$/g, "").replace(/[.;?]\s*$/, "").trim();
  return term ? { term } : null;
}

/** True if the WHOLE message asks what Relay remembers ("what do you know about me", "what do you
 * remember"). Lets the handler answer from the store directly, no agent run. */
export function isRecallRequest(text: string): boolean {
  return /^\s*what\s+(?:do\s+you\s+(?:know|remember)|have\s+i\s+told\s+you)\b.*\??\s*$/i.test(text.trim());
}

export class NotesStore {
  private file: string;
  private items: ChatNotes[] = [];
  constructor(opts: { file: string }) { this.file = opts.file; this.load(); }

  private load(): void {
    const obj = readJsonSafe<{ items?: ChatNotes[] }>(this.file);
    if (obj && Array.isArray(obj.items)) {
      this.items = obj.items.filter((c) => c && typeof c.chatId === "number" && Array.isArray(c.notes));
    }
  }
  private persist(): boolean { return atomicWriteJson(this.file, { v: 1, items: this.items }); }

  private forChat(chatId: number): ChatNotes {
    let c = this.items.find((x) => x.chatId === chatId);
    if (!c) { c = { chatId, notes: [] }; this.items.push(c); }
    return c;
  }

  list(chatId: number): Note[] { return this.items.find((c) => c.chatId === chatId)?.notes ?? []; }

  /** Add a fact. De-dupes an exact (case-insensitive) repeat. When at the cap, drops the OLDEST to make
   * room and returns its text in `evicted` so the caller can warn the user (a silent drop of the
   * earliest fact — often the most important — reads as "you forgot" — notes-cap-silent-evict). `dup`
   * marks an exact repeat (nothing stored). */
  add(chatId: number, text: string, now: number): { note: Note; evicted: string[]; dup: boolean; saved: boolean } {
    const c = this.forChat(chatId);
    const norm = text.trim().toLowerCase();
    const existing = c.notes.find((n) => n.text.trim().toLowerCase() === norm);
    if (existing) return { note: existing, evicted: [], dup: true, saved: true }; // already known — don't duplicate
    const note: Note = { text: text.trim(), created: now };
    c.notes.push(note);
    let evicted: string[] = [];
    if (c.notes.length > MAX_NOTES_PER_CHAT) {
      evicted = c.notes.splice(0, c.notes.length - MAX_NOTES_PER_CHAT).map((n) => n.text);
    }
    // saved=false when the disk write failed — the caller must NOT claim "I'll remember that" as if it
    // persisted (lists-remove-atomic-write-failure): it's in memory for now but gone on restart.
    const saved = this.persist();
    return { note, evicted, dup: false, saved };
  }

  /** Score how well a stored fact matches a forget `term`, higher = better; 0 = no match.
   * WORD-BOUNDARY based so "tea" doesn't hit "Teagan" (notes-forget-substring-collateral). Scoring:
   *   3 = exact (normalized) equality; 2 = the fact contains ALL of the term's words as whole words;
   *   1 = the fact shares SOME of the term's words (>=1) as whole words. Word = alphanumeric run. */
  private matchScore(factText: string, term: string): number {
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    const fact = norm(factText);
    const t = norm(term);
    if (!t) return 0;
    if (fact === t) return 3;
    const factWords = new Set(fact.split(" "));
    const termWords = t.split(" ").filter(Boolean);
    const hits = termWords.filter((w) => factWords.has(w)).length;
    if (hits === 0) return 0;
    return hits === termWords.length ? 2 : 1;
  }

  /** Delete facts matching `term` by WHOLE-WORD relevance (not raw substring — "tea" won't delete
   * "Teagan's birthday"). Removes only the BEST tier of matches: an exact/all-words match deletes just
   * those; if none, a partial (some-words) match deletes those. Returns the removed facts' text so the
   * caller can show the user exactly what was forgotten (notes-forget-substring-collateral). */
  forget(chatId: number, term: string): string[] {
    const c = this.items.find((x) => x.chatId === chatId);
    if (!c) return [];
    const scored = c.notes.map((n) => ({ n, score: this.matchScore(n.text, term) })).filter((x) => x.score > 0);
    if (!scored.length) return [];
    const best = Math.max(...scored.map((x) => x.score));
    const doomed = new Set(scored.filter((x) => x.score === best).map((x) => x.n));
    const removed = c.notes.filter((n) => doomed.has(n)).map((n) => n.text);
    c.notes = c.notes.filter((n) => !doomed.has(n));
    if (removed.length) this.persist();
    return removed;
  }

  /** Forget every fact for a chat. Returns how many were cleared. */
  clear(chatId: number): number {
    const c = this.items.find((x) => x.chatId === chatId);
    const n = c?.notes.length ?? 0;
    if (n) { c!.notes = []; this.persist(); }
    return n;
  }

  /** A context string for the agent injecting the remembered facts, or "" if none. */
  contextLine(chatId: number): string {
    const notes = this.list(chatId);
    if (!notes.length) return "";
    return `things the user asked me to remember: ${notes.map((n) => n.text).join("; ")}`;
  }

  size(): number { return this.items.reduce((a, c) => a + c.notes.length, 0); }
}
