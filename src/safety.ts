// Safety layer for the agent: per-chat rate limiting, a dangerous-action guard for
// state-changing browser actions (adapted from DataFaucet auto-scan's DANGEROUS
// regex — not imported, mcp-forge stays untouched), and secret redaction for
// anything logged or echoed back to a user.

import { redactSecretsDeep, SENSITIVE_KEY_RE } from "./lib/redact-secrets.js";
import { intEnv } from "./lib/env.js";

// ---- per-chat rate limit ---------------------------------------------------

/** Resolve RELAY_RATE_LIMIT_PER_MIN to a safe value: a finite integer >= 0 (0 = explicit disable),
 * else FAIL SAFE to the default. An unvalidated Number(env) yielded NaN on a typo, and since both
 * checks in checkRateLimit compare against it (`NaN<=0` false, `len>=NaN` false) the limiter then
 * ALWAYS allowed — anti-abuse silently OFF, a fail-OPEN. Garbage/negative must keep the limiter ON. */
export function resolveRateLimit(raw: string | undefined, fallback = 10): number {
  // Thin wrapper over the shared intEnv (DEV-0166). allowZeroDisable: a literal 0 is the documented
  // "disable"; blank/garbage/negative FAIL SAFE to the default so a typo can't turn the limiter off.
  return intEnv(raw, { fallback, min: 0, allowZeroDisable: true });
}
const RATE_LIMIT_PER_MIN = resolveRateLimit(process.env.RELAY_RATE_LIMIT_PER_MIN);
const WINDOW_MS = 60_000;
const hits = new Map<number, number[]>();

/**
 * Returns { allowed, retryAfterSec }. Sliding 60s window per chat. Set
 * RELAY_RATE_LIMIT_PER_MIN=0 to disable.
 */
export function checkRateLimit(chatId: number, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
  if (RATE_LIMIT_PER_MIN <= 0) return { allowed: true, retryAfterSec: 0 };
  const arr = (hits.get(chatId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= RATE_LIMIT_PER_MIN) {
    const oldest = arr[0]!;
    return { allowed: false, retryAfterSec: Math.ceil((WINDOW_MS - (now - oldest)) / 1000) };
  }
  arr.push(now);
  hits.set(chatId, arr);
  return { allowed: true, retryAfterSec: 0 };
}

// ---- dangerous-action guard ------------------------------------------------

// State-changing / irreversible actions the agent must not perform autonomously
// (mirrors mcp-forge auto-scan's DANGEROUS button filter). Used to gate any click/type/submit on
// matching element text.
//
// Two tiers (dangerous-action-false-refuse). The bare-noun list over-blocked benign navigation:
// "order" matched "Order status", "reset" matched "reset filters", "remove"/"send" matched selectors
// like ".remove-filter" / "#send-search" — dead-ending a legit multi-step browse with a false REFUSED.
//   STRONG: unambiguous commit/destroy verbs — dangerous on their own (a button labeled just this IS
//           the committing act). e.g. pay, delete, checkout, unsubscribe, submit.
//   CONTEXTUAL: nouns that are ONLY dangerous with a committing object/verb nearby (order, send, reset,
//           remove, cancel, book, confirm) — "place order"/"send money"/"reset password" are caught,
//           but "order status"/"send-search"/"reset filters" pass. Matched via explicit collocations.
// m26 safety-audit-2 kept the committing synonyms (subscribe, bid, add to cart, donate); this split
// (dangerous-action-false-refuse) narrows the ambiguous ones without weakening the genuine catches.
export const DANGEROUS_ACTION_RE =
  /\b(delete|logout|log out|sign out|subscribe|unsubscribe|close account|close my account|deactivate|submit|pay|purchase|buy|checkout|transfer|withdraw|approve|authorize|destroy|wipe|erase|bid|add to cart|donate|donation|place (?:order|bid)|complete (?:order|purchase|checkout))\b/i;

// A committing object that turns an ambiguous verb into a real commit. "order/booking/purchase/
// payment/funds/money/subscription/account/reservation/card/transfer/donation".
const COMMIT_OBJ = "(?:order|orders|booking|reservation|purchase|payment|funds|money|subscription|account|card|donation|transfer|bid|gift|item|items|cart)";
// Ambiguous verb + a committing object (either order) — the genuinely dangerous phrasings, while a
// read/nav collocation ("order status", "booking reference", "send search") is left alone.
const CONTEXTUAL_RE = new RegExp(
  // <verb> ... <commit-object>:  "cancel my subscription", "remove payment card", "send money"
  "\\b(?:cancel|remove|send|reset|change|update|edit|book|confirm|make|start|renew)\\s+(?:\\w+\\s+){0,3}?" + COMMIT_OBJ + "\\b"
  // <commit-object> ... <verb>:  "order — place", "subscription cancel" (rare, but symmetric)
  + "|\\b(?:place|confirm|complete|submit)\\s+(?:the\\s+|a\\s+|your\\s+)?" + COMMIT_OBJ
  // password/security-sensitive resets + factory reset (destructive even without a commit object)
  + "|\\breset\\s+(?:my\\s+|the\\s+|your\\s+)?(?:password|account|settings|device|data|everything)\\b"
  + "|\\bfactory\\s+reset\\b"
  // "book (a) <thing>" / "book now" — a reservation commitment (but not "bookings"/"booking reference")
  + "|\\bbook\\s+(?:now|a\\s+|the\\s+|your\\s+|this\\s+)"
  // "confirm <commit>" collocations Excel/checkout use ("confirm and pay", "confirm order")
  + "|\\bconfirm\\s+(?:and\\s+)?(?:order|purchase|payment|booking|and\\s+pay|subscription|reservation)\\b"
  // send/transfer/pay/wire + a CURRENCY AMOUNT ("Send $50 to John", "transfer £200", "pay 100 usd") — a
  // money-movement commit that named-object matching missed because the object is a bare amount, not the
  // word "money" (dangerous-send-amount). Catches a $/€/£-prefixed or a number + currency word.
  + "|\\b(?:send|transfer|wire|pay|venmo|zelle|paypal)\\s+(?:\\w+\\s+){0,2}?(?:[$€£]\\s?\\d|\\d+(?:\\.\\d+)?\\s?(?:usd|eur|gbp|dollars?|euros?|pounds?|bucks?))"
  // "empty/clear (the) trash/cart/basket" — a destructive bulk action with no commit-object noun match.
  + "|\\b(?:empty|clear)\\s+(?:the\\s+|my\\s+|your\\s+)?(?:trash|bin|cart|basket|inbox)\\b",
  "i",
);

/** True if the given action/target text describes a destructive or committing action. STRONG verbs
 * match on their own; ambiguous nouns (order/send/reset/remove/book/confirm/cancel) match only in a
 * committing collocation so benign navigation ("Order status", "reset filters", ".remove-filter",
 * "#send-search") isn't false-refused (dangerous-action-false-refuse). */
export function isDangerousAction(text: string): boolean {
  return DANGEROUS_ACTION_RE.test(text) || CONTEXTUAL_RE.test(text);
}

// ---- redaction -------------------------------------------------------------

/**
 * Redact obvious secrets from a free-text string before logging or echoing it.
 * Masks common token shapes (Bearer/AIza/sk-/telegram/long hex) so a scraped page
 * or a user paste containing a credential doesn't leak into logs or a reply.
 */
export function redactText(s: string): string {
  return s
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bAIza[0-9A-Za-z_\-]{20,}/g, "[redacted-key]")
    // Gemini AQ. keys (the newer key shape — DEPLOY.md notes these are what the free tier issues).
    .replace(/\bAQ\.[A-Za-z0-9_\-]{20,}/g, "[redacted-key]")
    // Anthropic keys: sk-ant-... (hyphenated — the generic sk- rule below stops at the first hyphen,
    // so match this explicitly). m26 safety-audit-3.
    .replace(/\bsk-ant-[A-Za-z0-9\-]{16,}/g, "[redacted-key]")
    .replace(/\bsk-[A-Za-z0-9]{16,}/g, "[redacted-key]")
    .replace(/\b\d{8,10}:AA[0-9A-Za-z_\-]{30,}/g, "[redacted-token]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted-hex]");
}

/** Redact secrets from a structured object by key name (for logging tool args). */
export function redactObject(obj: unknown): unknown {
  return redactSecretsDeep(obj, () => "[redacted]", SENSITIVE_KEY_RE);
}
