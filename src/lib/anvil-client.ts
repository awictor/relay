// ============================================================================
// CANONICAL anvil-client — SHARED between Relay and DataFaucet (m13).
//
// Relay (src/anvil.ts) and DataFaucet (mcp-forge browser routes) both connect to
// anvil-engine the same way: build the CDP ws + /v1/view URLs from a base URL + session id
// (anvil's own returned websocketUrl hardcodes localhost + omits the token, so consumers
// must build it), and share one transient-error taxonomy for retry.
//
// VENDORING CONTRACT: this file is COPIED verbatim into mcp-forge (src/lib/anvil-client.ts).
// A parity test in each repo asserts the two copies are byte-identical. To change it: edit
// here, copy to mcp-forge, run both suites. Keep it dependency-light + pure (no imports) so
// it vendors cleanly.
// ============================================================================

export interface AnvilConnectUrls {
  /** puppeteer browserWSEndpoint — ws(s)://host/cdp?session=<id>[&token=<key>] */
  connectUrl: string;
  /** MJPEG live-view — <base>/v1/view?session=<id>[&token=<key>] */
  liveUrl: string;
}

/**
 * Build the CDP ws endpoint + MJPEG live-view URL for an anvil session. Derives scheme/host
 * from the REST base URL (https -> wss); appends the API key as a token when present. Pure.
 */
export function buildConnectUrls(baseUrl: string, sessionId: string, apiKey?: string): AnvilConnectUrls {
  const base = baseUrl.replace(/\/$/, "");
  const u = new URL(base);
  const wsScheme = u.protocol === "https:" ? "wss" : "ws";
  const sid = encodeURIComponent(sessionId);
  let connectUrl = `${wsScheme}://${u.host}/cdp?session=${sid}`;
  let liveUrl = `${base}/v1/view?session=${sid}`;
  if (apiKey) {
    const tok = encodeURIComponent(apiKey);
    connectUrl += `&token=${tok}`;
    liveUrl += `&token=${tok}`;
  }
  return { connectUrl, liveUrl };
}

/** True for transient anvil/network errors worth one more try — timeouts, connection
 * resets, and 5xx. NOT for SSRF/4xx/"Blocked URL" (deterministic — retry won't help). */
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Blocked URL|Blocked protocol|Blocked hostname|Blocked IP/i.test(msg)) return false;
  // Classify on the HTTP STATUS only, never on digits inside the response body. Throwers format
  // "<label> failed: <status> <body>", so a loose whole-string /\b4\d\d\b/ scan (DEV-0148 bug)
  // misread a 5xx whose body text carried a 4xx-shaped number (e.g. a 503 body "expected 400 fields")
  // as non-transient and skipped a valid retry. Prefer an explicit status=<code> token; else take the
  // FIRST 3-digit code (the status precedes the body). 4xx except 408/429 => deterministic, no retry.
  const tokened = msg.match(/status=(\d{3})/);
  const codeStr = tokened ? tokened[1] : msg.match(/\b([1-5]\d{2})\b/)?.[1];
  if (codeStr) {
    const code = Number(codeStr);
    if (code >= 400 && code < 500) return code === 408 || code === 429; // client fault: retry only 408/429
    if (code >= 500) return true; // server fault: worth a retry
  }
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|fetch failed/i.test(msg);
}
