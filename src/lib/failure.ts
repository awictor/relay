// m14 degrade-1: map a raw agent/tool error to a friendly, user-facing message that never
// leaks internals (stack-ish text, hostnames, status codes). The RAW message is still logged
// by the handler (turn-log carries `error`) — this only shapes what the USER sees over text.
//
// Categories, most specific first:
//   browser  -> anvil unreachable/failed (the self-hosted browser is down or refused).
//   llm      -> free-tier model overloaded/rate-limited (transient, retry soon).
//   blocked  -> the target URL was refused (SSRF/private/blocked protocol) — user-actionable.
//   generic  -> anything else: a plain apology, no raw text.

export type FailureKind = "browser" | "llm" | "blocked" | "generic";

/** Classify a raw error message into a coarse failure kind. */
export function classifyFailure(rawMessage: string): FailureKind {
  const m = rawMessage || "";
  // LLM overload/rate — check before generic 5xx so a model 503 reads as "brain busy".
  if (/\b(429|503|UNAVAILABLE|overloaded|high demand|rate ?limit|quota|resource exhausted)\b/i.test(m)) return "llm";
  // Blocked/unsafe URL — the SSRF guard's phrasing ("Blocked URL: ...", "refused (...)").
  if (/Blocked URL|Blocked protocol|Blocked hostname|Blocked IP|\brefused \(/i.test(m)) return "blocked";
  // anvil / browser transport down: connection refused, DNS, socket, fetch failed, anvil's own
  // "create session failed" / "anvil ... failed", or a bare timeout with no other classification.
  if (/ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|fetch failed|network|anvil|create session|browserWSEndpoint|\bWebSocket\b|timed out|timeout/i.test(m)) return "browser";
  return "generic";
}

/** The friendly reply text for a raw error. Same categories as classifyFailure. */
export function friendlyError(rawMessage: string): string {
  switch (classifyFailure(rawMessage)) {
    case "llm":
      return "My brain's overloaded right now (free-tier model is busy). Try again in a moment.";
    case "browser":
      return "My browser's having trouble right now — give it a moment and try again.";
    case "blocked":
      return "I can't open that link — it looks unsafe or points somewhere private.";
    default:
      return "Sorry — something went wrong on my end. Try again in a moment.";
  }
}
