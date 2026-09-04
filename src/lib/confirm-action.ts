// Confirm-to-act (confirm-to-act): Relay is deliberately read-only — the DANGEROUS_ACTION guard hard-
// refuses a committing click (buy/pay/submit/place order). This OPT-IN flow (env RELAY_CONFIRM_TO_ACT=1,
// OFF by default) turns the flat refusal into a one-shot approval: the agent PREVIEWS the exact single
// gated click + its target + a plain-language "this does X" line, stashes it per chat with a short TTL,
// and executes EXACTLY that one click only on an explicit YES. NO / anything-else / timeout discards it.
// It NEVER auto-executes, never batches, never persists across restart (in-memory only) — a deliberate,
// narrow crossing of the safety line under explicit per-action user consent. Pure parse/format helpers +
// an in-memory store; the actual click runs in the agent's held anvil session. Exported for tests.

/** Whether the opt-in flow is enabled (RELAY_CONFIRM_TO_ACT truthy: "1"/"true"/"yes"/"on"). Default OFF
 * so behavior is byte-identical — a committing click still hard-refuses — unless an operator opts in. */
export function confirmToActEnabled(raw: string | undefined = process.env.RELAY_CONFIRM_TO_ACT): boolean {
  return /^(1|true|yes|on)$/i.test(String(raw ?? "").trim());
}

/** How long a stashed pending action stays confirmable before it expires (2 min). A committing action a
 * user didn't confirm promptly must not fire on a stale, forgotten YES. */
export const CONFIRM_TTL_MS = 120_000;

/** A stashed pending committing action: the exact click to run on YES + human context for the preview. */
export interface PendingAction {
  chatId: number;
  sessionId: string;   // the anvil session the click must run in (must still be open at YES time)
  selector: string;    // the exact selector to click
  label: string;       // the button/link label (for the preview + audit)
  url: string;         // the page the click acts on (for the preview — "on <host>")
  createdMs: number;   // stash time, for TTL expiry
}

// A YES reply is a WHOLE-message affirmative — kept tight so an ordinary message ("yes please also add
// milk") isn't read as consent to a committing click (a false YES here spends money). Anything not a
// clear yes/no is treated as neither (the pending action stays until it's answered or times out).
const YES_RE = /^\s*(?:y|yes|yep|yeah|yup|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve[d]?|send it|👍|✅)\s*[!.]*\s*$/i;
const NO_RE = /^\s*(?:n|no|nope|nah|cancel|stop|don'?t|do not|abort|never mind|nevermind|forget it|❌)\s*[!.]*\s*$/i;

/** Classify a reply to a pending-action prompt: "yes" runs it, "no" discards, "other" leaves it pending
 * (the message routes normally). Exported for tests. */
export function classifyConfirmReply(text: string): "yes" | "no" | "other" {
  const t = String(text ?? "").trim();
  if (YES_RE.test(t)) return "yes";
  if (NO_RE.test(t)) return "no";
  return "other";
}

/** The user-facing confirm prompt: names the exact click + page + a blunt "this DOES it" warning + how to
 * respond. Deliberately explicit — the user is authorizing a real, possibly irreversible action. */
export function formatConfirmPrompt(a: Pick<PendingAction, "label" | "url">, ttlMs: number): string {
  const host = hostOf(a.url);
  const what = a.label.trim() ? `"${a.label.trim()}"` : "that button";
  const where = host ? ` on ${host}` : "";
  const mins = Math.max(1, Math.round(ttlMs / 60000));
  return `⚠️ To do this I'd click ${what}${where} — a real, possibly irreversible action (it may buy, pay, submit, or change something). Reply **YES** to go ahead (expires in ${mins} min), or **NO** to cancel. I won't do anything until you say YES.`;
}

function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

/** In-memory, per-chat pending-action store. One pending action per chat (a new proposal replaces the old
 * — the user only ever confirms the most recent). Never persisted (a committing action must not survive a
 * restart to fire later). TTL-checked on read. Exported for the handler/agent wiring + tests. */
export class PendingActionStore {
  private items = new Map<number, PendingAction>();
  constructor(private ttlMs: number, private now: () => number = Date.now) {}

  /** Stash (replacing any prior pending action for this chat). */
  set(a: Omit<PendingAction, "createdMs">): void {
    this.items.set(a.chatId, { ...a, createdMs: this.now() });
  }

  /** The chat's pending action if one is stashed AND not expired; else undefined (expired ones are pruned). */
  get(chatId: number): PendingAction | undefined {
    const a = this.items.get(chatId);
    if (!a) return undefined;
    if (this.now() - a.createdMs > this.ttlMs) { this.items.delete(chatId); return undefined; }
    return a;
  }

  /** Discard a chat's pending action (on YES-consumed, NO, or expiry). */
  clear(chatId: number): void { this.items.delete(chatId); }

  /** True if the chat has a live (non-expired) pending action. */
  has(chatId: number): boolean { return this.get(chatId) !== undefined; }
}
