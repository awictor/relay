// Safety layer for the agent: per-chat rate limiting, a dangerous-action guard for
// state-changing browser actions (adapted from DataFaucet auto-scan's DANGEROUS
// regex — not imported, mcp-forge stays untouched), and secret redaction for
// anything logged or echoed back to a user.

import { redactSecretsDeep, SENSITIVE_KEY_RE } from "./lib/redact-secrets.js";

// ---- per-chat rate limit ---------------------------------------------------

const RATE_LIMIT_PER_MIN = Number(process.env.RELAY_RATE_LIMIT_PER_MIN ?? 10);
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
// (mirrors mcp-forge auto-scan's DANGEROUS button filter). Used to gate any
// click/type/submit on matching element text once agent-2 adds those tools.
export const DANGEROUS_ACTION_RE =
  /\b(delete|remove|cancel|logout|log out|sign out|unsubscribe|close account|deactivate|submit|confirm|pay|purchase|buy|checkout|order|send|transfer|withdraw|approve|authorize|destroy|reset|wipe|erase)\b/i;

/** True if the given action/target text describes a destructive or committing action. */
export function isDangerousAction(text: string): boolean {
  return DANGEROUS_ACTION_RE.test(text);
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
    .replace(/\bsk-[A-Za-z0-9]{16,}/g, "[redacted-key]")
    .replace(/\b\d{8,10}:AA[0-9A-Za-z_\-]{30,}/g, "[redacted-token]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted-hex]");
}

/** Redact secrets from a structured object by key name (for logging tool args). */
export function redactObject(obj: unknown): unknown {
  return redactSecretsDeep(obj, () => "[redacted]", SENSITIVE_KEY_RE);
}
