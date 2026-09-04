// Multi-turn browse continuity (persist-browse-session-across-turns): normally runAgent opens a browser
// session for an interactive task and releases it at the end of the turn, so a follow-up ("now sort by
// price", "open the 2nd") re-navigates from scratch. When RELAY_BROWSE_CONTINUITY is on, the handler
// carries an OPEN session per-chat between messages via this store: the next turn within an idle TTL
// resumes the same page. Off by default — a live session per chat holds a real Chrome tab, so this is
// opt-in and hard-bounded (one session per chat, idle-reaped). No timers: reaping is lazy (checked on
// each touch/get), so nothing leaks if the process is idle.

/** True if the WHOLE message asks to close/drop a held browse page ("done", "close the page", "nevermind",
 * "stop browsing"). Lets a user explicitly release a carried session instead of waiting for the idle reap
 * (session-status-surface). Whole-message + anchored so a real task ("close my rings", "done with X?")
 * isn't intercepted; only fires when a session is actually held (checked at the call site). */
export function isCloseSessionRequest(text: string): boolean {
  return /^\s*(?:done|i'?m done|that'?s all|close(?: the| that)?(?: page| tab| browser| session)?|stop browsing|nevermind|never mind|nvm|forget it|drop it|close it)\s*[.!]*\s*$/i.test(text);
}

/** Is cross-turn browse continuity enabled? Default OFF (opt-in; each carried session pins a Chrome tab). */
export function browseContinuityEnabled(raw: string | undefined = process.env.RELAY_BROWSE_CONTINUITY): boolean {
  return /^(1|true|yes|on)$/i.test(String(raw ?? "").trim());
}

// How long a carried session stays resumable after the last activity. A short window: the point is a
// quick follow-up ("now filter to nonstop"), not an hour-long hold of a browser tab. Env-tunable.
export const BROWSE_IDLE_MS = Math.max(30_000, Number(process.env.RELAY_BROWSE_IDLE_MS) || 180_000); // 3 min

interface CarriedSession { sessionId: string; lastActivityMs: number; }

/**
 * Per-chat carry of ONE open browse session, TTL-idle-reaped. `release` is the anvil session releaser;
 * the store calls it whenever it drops a session (idle-expired, replaced by a newer one, or explicitly
 * cleared) so a tab is never leaked. `now` is injected for offline-testable time. All reaping is lazy
 * (on get/set/touch) — no background timer.
 */
export class BrowseSessionStore {
  private map = new Map<number, CarriedSession>();
  constructor(
    private release: (sessionId: string) => Promise<void> | void,
    private now: () => number,
    private idleMs: number = BROWSE_IDLE_MS,
  ) {}

  /** The still-fresh session id carried for this chat, or undefined. Reaps it first if it's gone idle. */
  get(chatId: number): string | undefined {
    const c = this.map.get(chatId);
    if (!c) return undefined;
    if (this.now() - c.lastActivityMs > this.idleMs) { this.drop(chatId); return undefined; }
    return c.sessionId;
  }

  /**
   * Record `sessionId` as this chat's live session (after a turn ended with it open). If a DIFFERENT
   * session was carried, the old one is released first (a chat holds at most one tab). A repeat of the
   * same id just refreshes its activity stamp. Reaps other chats' idle sessions opportunistically.
   */
  set(chatId: number, sessionId: string): void {
    const prev = this.map.get(chatId);
    if (prev && prev.sessionId !== sessionId) void this.release(prev.sessionId);
    this.map.set(chatId, { sessionId, lastActivityMs: this.now() });
    this.reapIdle(chatId);
  }

  /** Drop + release this chat's carried session (e.g. the turn didn't keep it open, or /reset). No-op if none. */
  drop(chatId: number): void {
    const c = this.map.get(chatId);
    if (!c) return;
    this.map.delete(chatId);
    void this.release(c.sessionId);
  }

  /** Release every idle session EXCEPT `exceptChat` (just-touched). Keeps the fleet from accumulating
   * abandoned tabs when many chats each browse once and never follow up. */
  private reapIdle(exceptChat?: number): void {
    const t = this.now();
    for (const [chatId, c] of this.map) {
      if (chatId === exceptChat) continue;
      if (t - c.lastActivityMs > this.idleMs) { this.map.delete(chatId); void this.release(c.sessionId); }
    }
  }

  /** Test/inspection: how many sessions are currently carried. */
  size(): number { return this.map.size; }
}
