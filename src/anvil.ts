// anvil-engine client — self-hosted browser, no Browserbase/Browserless/Steel.
// Verified against awictor/anvil-engine: create session over REST, build the CDP
// ws endpoint ourselves (the returned websocketUrl hardcodes localhost + omits the
// token), connect puppeteer to it, release when done. Simple fetches use REST /v1/scrape.

import { isUrlSafe } from "./lib/url-validator.js";

const BASE = (process.env.ANVIL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.ANVIL_API_KEY || "";

function authHeaders(): Record<string, string> {
  return KEY ? { Authorization: `Bearer ${KEY}` } : {};
}

/** Liveness probe — used by the loop's STAGE INFRA to confirm anvil is reachable. */
export async function anvilLive(timeoutMs = 4000): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/v1/live`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

export interface AnvilSession {
  id: string;
  browserWSEndpoint: string;
}

/** Create a browser session and return its id + the correctly-built CDP ws endpoint. */
export async function createSession(opts: { headless?: boolean; stealth?: boolean } = {}): Promise<AnvilSession> {
  const r = await fetch(`${BASE}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ headless: opts.headless ?? true, stealth: opts.stealth ?? true }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    throw new Error(`anvil create session failed: ${r.status} ${await r.text().catch(() => "")}`.slice(0, 300));
  }
  const s = (await r.json()) as { id: string };
  if (!s.id) throw new Error("anvil create session: no id in response");

  // Build the endpoint ourselves — the returned websocketUrl always says localhost
  // and omits the token. Derive scheme/host from BASE, append token if auth is on.
  const u = new URL(BASE);
  const wsScheme = u.protocol === "https:" ? "wss" : "ws";
  let browserWSEndpoint = `${wsScheme}://${u.host}/cdp?session=${encodeURIComponent(s.id)}`;
  if (KEY) browserWSEndpoint += `&token=${encodeURIComponent(KEY)}`;
  return { id: s.id, browserWSEndpoint };
}

/** Release a session (POST, not DELETE). Best-effort. */
export async function releaseSession(id: string): Promise<void> {
  try {
    await fetch(`${BASE}/v1/sessions/${encodeURIComponent(id)}/release`, {
      method: "POST",
      headers: authHeaders(),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Drive a fresh browser session with puppeteer, then always release.
 * The callback receives a connected puppeteer Browser.
 */
export async function withBrowser<T>(fn: (browser: import("puppeteer-core").Browser) => Promise<T>): Promise<T> {
  const { default: puppeteer } = await import("puppeteer-core");
  const session = await createSession();
  let browser: import("puppeteer-core").Browser | undefined;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: session.browserWSEndpoint });
    return await fn(browser);
  } finally {
    if (browser) {
      try {
        browser.disconnect();
      } catch {
        /* ignore */
      }
    }
    await releaseSession(session.id);
  }
}

/**
 * Fetch a page's text (or html) via anvil's REST /v1/scrape — no CDP driving needed.
 * SSRF-guarded before the call. Returns { content, title, url }.
 */
export async function scrape(
  url: string,
  opts: { format?: "text" | "html"; waitForSelector?: string } = {}
): Promise<{ content: string; title: string; url: string }> {
  const check = isUrlSafe(url);
  if (!check.safe) throw new Error(`Blocked URL: ${check.reason}`);
  const r = await fetch(`${BASE}/v1/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ url, format: opts.format ?? "text", waitForSelector: opts.waitForSelector }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) {
    throw new Error(`anvil scrape failed: ${r.status} ${await r.text().catch(() => "")}`.slice(0, 300));
  }
  return (await r.json()) as { content: string; title: string; url: string };
}
