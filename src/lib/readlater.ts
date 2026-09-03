// Read-it-later capture + recall (read-it-later-capture): "save this <link>" scrapes + summarizes the
// page once and stores {url, title, summary, t}; later "what did I save about <topic>" does a full-text
// search over those saved pages and returns the matches. Turns normal use into a personal knowledge base
// — a satisfied user builds a growing, searchable corpus (a strong retention / switching-cost hook) that
// the ad-hoc "read this link" path threw away every time. Small atomic + corrupt-safe JSON store keyed by
// chatId, mirroring NotesStore. The scrape+summarize is INJECTED (a dep) so the store + parsing are
// offline-unit-testable without anvil/LLM. Free-infra.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";
import { firstUrl } from "./result-list.js";

export interface SavedPage {
  url: string;
  title: string;   // a short human label (the page title, or the URL host as a fallback)
  summary: string; // the captured gist, so recall doesn't need to re-fetch
  created: number;  // epoch ms, for ordering + oldest-first eviction
  lastRecalledAt?: number; // epoch ms the user last SAW this page in a recall/recap — so a saved-and-
                           // forgotten page can be nudged (saved-page-unread-nudge). Unset = never revisited.
}
interface ChatSaved { chatId: number; pages: SavedPage[] }

// Cap saved pages per chat so the store (and any injected context) can't grow unbounded. Oldest-first
// drop when over — the newest saves are the ones a user is most likely to recall.
const MAX_SAVED_PER_CHAT = 100;
const MAX_SUMMARY_LEN = 1200;
const MAX_TITLE_LEN = 200;

/** Parse a "save this" capture command -> the URL to save, or null if it isn't one.
 *   "save this https://…"          "save this for later: https://…"
 *   "read it later https://…"      "/save https://…"       "bookmark https://…"
 *   "save https://… to read later"
 * Requires an explicit save/bookmark/read-it-later verb AND a URL in the message, so a normal "read this
 * link" (a fetch-now errand) or a bare pasted link still reaches the agent. Returns the first URL. */
export function parseSavePage(text: string): string | null {
  const t = text.trim();
  // Must open with a capture verb (anchored) so "should I save this article?" (a question) doesn't match.
  if (!/^\s*(?:\/save\b|save\s+(?:this|it|that|the\s+(?:page|article|link|link\s+below))?\b|bookmark\b|read\s+(?:it|this|that)\s+later\b|save\s+for\s+later\b)/i.test(t)) return null;
  const url = firstUrl(t);
  return url ?? null;
}

/** Parse a "what did I save / show my saved / my reading list" recall command -> { topic } (topic may be
 * empty = list all recent), or null if it isn't a saved-recall ask.
 *   "what did I save about the fed"   "what have I saved"   "show my saved pages"
 *   "my reading list"                 "search my saved for tariffs"   "/saved rust" */
export function parseSavedRecall(text: string): { topic: string } | null {
  const t = text.trim();
  // "/saved [topic]" explicit command.
  let m = t.match(/^\s*\/saved\b\s*(.*)$/i);
  if (m) return { topic: cleanTopic(m[1]!) };
  // "what did I save (about X)" / "what have I saved (about X)".
  m = t.match(/^\s*what\s+(?:did|have)\s+i\s+save[d]?\b(?:\s+about\s+(.+?)|\s+on\s+(.+?))?\s*\??\s*$/i);
  if (m) return { topic: cleanTopic(m[1] ?? m[2] ?? "") };
  // "show/list my saved [pages/articles] (about X)" / "my reading list (about X)".
  m = t.match(/^\s*(?:show|list)\s+(?:me\s+)?my\s+(?:saved|reading\s+list|bookmarks?)\b(?:\s+(?:pages?|articles?|links?))?(?:\s+about\s+(.+?))?\s*\??\s*$/i);
  if (m) return { topic: cleanTopic(m[1] ?? "") };
  m = t.match(/^\s*my\s+reading\s+list\b(?:\s+about\s+(.+?))?\s*\??\s*$/i);
  if (m) return { topic: cleanTopic(m[1] ?? "") };
  // "search my saved for X" / "find in my saved X".
  m = t.match(/^\s*(?:search|find\s+in)\s+my\s+saved\b(?:\s+(?:for|about)\s+(.+?))?\s*\??\s*$/i);
  if (m) return { topic: cleanTopic(m[1] ?? "") };
  return null;
}

function cleanTopic(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "").replace(/[.?!;]\s*$/g, "").trim();
}

/** True if a whole message asks what's saved-but-unread ("what haven't I read", "what did I save and
 * forget", "unread saved", "reading list I haven't read"). Distinct from parseSavedRecall (which lists/
 * searches ALL saves) — this scopes to the not-revisited ones. */
export function isUnreadSavedRequest(text: string): boolean {
  const t = text.trim();
  return /^\s*(?:what\s+haven'?t\s+i\s+read|what\s+did\s+i\s+save\s+and\s+(?:forget|not\s+read)|what'?s\s+(?:in\s+my\s+)?unread|unread\s+(?:saved|reading\s+list|pages?)|(?:my\s+)?reading\s+list\s+i\s+haven'?t\s+read|what\s+have\s+i\s+not\s+read)\b.*\??\s*$/i.test(t);
}

/** Parse an opt-in/opt-out command for the WEEKLY proactive unread nudge (weekly-unread-proactive-nudge),
 * or null if it isn't one. { on: true } = start the weekly nudge, { on: false } = stop it.
 *   on:  "nudge me about my reading list", "remind me about my saved pages weekly", "weekly reading nudge"
 *   off: "stop reading list nudges", "stop nudging me about my reading list", "turn off reading nudges" */
export function parseUnreadNudgeToggle(text: string): { on: boolean } | null {
  const t = text.trim().toLowerCase();
  if (/^\s*(?:stop|turn off|disable|cancel|no more)\b.*\b(?:reading|saved|read[- ]?it[- ]?later)\b.*\bnudg/i.test(t)
      || /^\s*(?:stop|turn off|disable)\s+nudging\s+me\s+about\s+(?:my\s+)?(?:reading|saved)\b/i.test(t)) {
    return { on: false };
  }
  if (/^\s*(?:nudge|remind)\s+me\s+(?:about\s+)?(?:my\s+)?(?:reading\s+list|saved|unread|read[- ]?it[- ]?later)\b/i.test(t)
      || /^\s*(?:weekly\s+)?(?:reading|unread)\s+(?:list\s+)?nudges?\b/i.test(t)
      || /^\s*(?:start\s+)?nudging\s+me\s+about\s+(?:my\s+)?(?:reading|saved)\b/i.test(t)) {
    return { on: true };
  }
  return null;
}

/** Format an unread-nudge line for a set of stale-unread saved pages (saved-page-unread-nudge), or null
 * when there are none. Used by both a "what haven't I read" reply and a proactive weekly nudge. */
export function formatUnreadNudge(pages: SavedPage[]): string | null {
  if (!pages.length) return null;
  const lines = pages.map((p) => `• ${p.title} — ${p.url}`);
  return `📚 You saved ${pages.length === 1 ? "this" : `these ${pages.length}`} a while back but haven't revisited ${pages.length === 1 ? "it" : "them"}:\n${lines.join("\n")}\n\nWant a recap of any? Say "what did I save about …".`;
}

/** A short host label from a URL, for a fallback title ("nytimes.com"). */
export function hostLabel(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url.slice(0, MAX_TITLE_LEN); }
}

// Reserved digest member names that mean "a recap of my saved reading list" rather than a recipe
// (saved-page-digest-integration): "define digest morning: weather, reading list" folds recent saves into
// the briefing. Matched case-insensitively against the normalized member name.
const RECAP_MEMBER_NAMES = new Set(["reading list", "reading recap", "saved", "saved pages", "read later", "read-it-later"]);
export function isReadingRecapMember(name: string): boolean {
  return RECAP_MEMBER_NAMES.has(name.trim().toLowerCase());
}

/** A short recap of the most-recent saved pages for a digest section (saved-page-digest-integration), or
 * null when nothing is saved (so the digest treats it as an empty member, not a failure). `limit` caps how
 * many titles show. Titles + links only — the point is a nudge to revisit, not to re-dump every summary. */
export function readingRecap(pages: SavedPage[], limit = 5): string | null {
  if (!pages.length) return null;
  const recent = [...pages].sort((a, b) => b.created - a.created).slice(0, limit);
  const lines = recent.map((p) => `  - ${p.title} — ${p.url}`);
  const more = pages.length > recent.length ? `\n  …and ${pages.length - recent.length} more (say "my reading list").` : "";
  return `${recent.length} saved to revisit:\n${lines.join("\n")}${more}`;
}

export class SavedStore {
  private file: string;
  private items: ChatSaved[] = [];
  constructor(opts: { file: string }) { this.file = opts.file; this.load(); }

  private load(): void {
    const obj = readJsonSafe<{ items?: ChatSaved[] }>(this.file);
    if (obj && Array.isArray(obj.items)) {
      this.items = obj.items.filter((c) => c && typeof c.chatId === "number" && Array.isArray(c.pages));
    }
  }
  private lastWriteOk = true;
  lastSaveOk(): boolean { return this.lastWriteOk; }
  private persist(): boolean { return (this.lastWriteOk = atomicWriteJson(this.file, { v: 1, items: this.items })); }

  private forChat(chatId: number): ChatSaved {
    let c = this.items.find((x) => x.chatId === chatId);
    if (!c) { c = { chatId, pages: [] }; this.items.push(c); }
    return c;
  }

  list(chatId: number): SavedPage[] { return this.items.find((c) => c.chatId === chatId)?.pages ?? []; }

  /** Save a captured page. De-dupes by URL (a re-save UPDATES the title/summary rather than duplicating).
   * At the cap, drops the OLDEST + returns its title in `evicted`. `saved=false` when the disk write
   * failed so the caller doesn't claim it persisted (mirrors NotesStore's contract). */
  add(chatId: number, page: { url: string; title?: string; summary: string }, now: number): { page: SavedPage; evicted: string[]; dup: boolean; saved: boolean } {
    const c = this.forChat(chatId);
    const title = (page.title?.trim() || hostLabel(page.url)).slice(0, MAX_TITLE_LEN);
    const summary = page.summary.trim().slice(0, MAX_SUMMARY_LEN);
    const existing = c.pages.find((p) => p.url === page.url);
    if (existing) {
      // Re-save of the same URL: refresh its title/summary in place, don't duplicate.
      existing.title = title; existing.summary = summary; existing.created = now;
      const saved = this.persist();
      return { page: existing, evicted: [], dup: true, saved };
    }
    const rec: SavedPage = { url: page.url, title, summary, created: now };
    c.pages.push(rec);
    let evicted: string[] = [];
    if (c.pages.length > MAX_SAVED_PER_CHAT) {
      evicted = c.pages.splice(0, c.pages.length - MAX_SAVED_PER_CHAT).map((p) => p.title);
    }
    const saved = this.persist();
    return { page: rec, evicted, dup: false, saved };
  }

  /** Full-text search over a chat's saved pages by whole-word relevance across title+summary+url. An
   * EMPTY topic returns the most-recent pages (a plain "what have I saved"). Higher score = better; ties
   * break to most-recent. Returns up to `limit` matches. */
  search(chatId: number, topic: string, limit = 8): SavedPage[] {
    const pages = this.list(chatId);
    if (!pages.length) return [];
    const t = norm(topic);
    if (!t) return [...pages].sort((a, b) => b.created - a.created).slice(0, limit); // no topic -> recent
    const terms = t.split(" ").filter(Boolean);
    const scored = pages.map((p) => ({ p, score: this.score(p, terms) })).filter((x) => x.score > 0);
    scored.sort((a, b) => (b.score - a.score) || (b.p.created - a.p.created));
    return scored.slice(0, limit).map((x) => x.p);
  }

  /** Stamp that the user just SAW these URLs in a recall/recap (saved-page-unread-nudge), so an unread
   * nudge doesn't keep re-surfacing a page they've revisited. Best-effort persist; a failed write only
   * means a page might be nudged once more, which is harmless. Returns how many were stamped. */
  markRecalled(chatId: number, urls: string[], now: number): number {
    const c = this.items.find((x) => x.chatId === chatId);
    if (!c) return 0;
    const set = new Set(urls);
    let n = 0;
    for (const p of c.pages) if (set.has(p.url)) { p.lastRecalledAt = now; n++; }
    if (n) this.persist();
    return n;
  }

  /** Saved pages the user hasn't revisited in a while (saved-page-unread-nudge): saved before `now -
   * staleMs` AND never recalled (or last recalled before that cutoff). Oldest-save first (the most
   * forgotten). `limit` caps the result. Empty when nothing qualifies. */
  unread(chatId: number, staleMs: number, now: number, limit = 5): SavedPage[] {
    const cutoff = now - staleMs;
    return this.list(chatId)
      .filter((p) => p.created <= cutoff && (p.lastRecalledAt === undefined || p.lastRecalledAt <= cutoff))
      .sort((a, b) => a.created - b.created)
      .slice(0, limit);
  }

  // Relevance of a page to the search terms: whole-word hits across title + summary + url host, summed,
  // with the title weighted higher (a topic in the title is a stronger signal than one deep in the body).
  private score(p: SavedPage, terms: string[]): number {
    const titleWords = new Set(norm(p.title).split(" "));
    const bodyWords = new Set((norm(p.summary) + " " + norm(hostLabel(p.url))).split(" "));
    let s = 0;
    for (const w of terms) {
      if (titleWords.has(w)) s += 2;
      else if (bodyWords.has(w)) s += 1;
    }
    return s;
  }

  /** Delete saved pages matching `term` (by URL exact, else whole-word title/summary match). Returns the
   * removed titles so the caller can confirm what was dropped. */
  forget(chatId: number, term: string): string[] {
    const c = this.items.find((x) => x.chatId === chatId);
    if (!c) return [];
    const byUrl = c.pages.filter((p) => p.url === term.trim());
    const doomed = new Set(byUrl.length ? byUrl : this.search(chatId, term, MAX_SAVED_PER_CHAT).filter((p) => this.score(p, norm(term).split(" ").filter(Boolean)) >= 2));
    if (!doomed.size) return [];
    const removed = c.pages.filter((p) => doomed.has(p)).map((p) => p.title);
    c.pages = c.pages.filter((p) => !doomed.has(p));
    if (removed.length) this.persist();
    return removed;
  }

  /** Forget every saved page for a chat. Returns how many were cleared. */
  clear(chatId: number): number {
    const c = this.items.find((x) => x.chatId === chatId);
    const n = c?.pages.length ?? 0;
    if (n) { c!.pages = []; this.persist(); }
    return n;
  }

  size(): number { return this.items.reduce((a, c) => a + c.pages.length, 0); }
}

function norm(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
