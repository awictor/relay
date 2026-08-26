// anvil-engine client — self-hosted browser, no Browserbase/Browserless/Steel.
// Verified against awictor/anvil-engine: create session over REST, build the CDP
// ws endpoint ourselves (the returned websocketUrl hardcodes localhost + omits the
// token), connect puppeteer to it, release when done. Simple fetches use REST /v1/scrape.

import { isUrlSafe } from "./lib/url-validator.js";
import { buildConnectUrls, isTransientError } from "./lib/anvil-client.js";

export { isTransientError }; // re-export: canonical impl now lives in the shared anvil-client (m13)

const BASE = (process.env.ANVIL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.ANVIL_API_KEY || "";

function authHeaders(): Record<string, string> {
  return KEY ? { Authorization: `Bearer ${KEY}` } : {};
}

const RETRY_ATTEMPTS = Math.max(1, Number(process.env.ANVIL_RETRY_ATTEMPTS ?? 2)); // total tries
const RETRY_BASE_MS = 400;

/** Run an anvil op with a bounded retry on transient errors (exponential backoff).
 * Deterministic failures (SSRF/4xx) throw immediately. */
async function withRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await op();
    } catch (e) {
      lastErr = e;
      if (attempt >= RETRY_ATTEMPTS || !isTransientError(e)) throw e;
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt));
    }
  }
  throw lastErr;
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
  const s = await withRetry(async () => {
    const r = await fetch(`${BASE}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ headless: opts.headless ?? true, stealth: opts.stealth ?? true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      throw new Error(`anvil create session failed: ${r.status} ${await r.text().catch(() => "")}`.slice(0, 300));
    }
    const parsed = (await r.json()) as { id: string };
    if (!parsed.id) throw new Error("anvil create session: no id in response");
    return parsed;
  }, "createSession");

  // Build the endpoint via the shared client (anvil's returned websocketUrl hardcodes
  // localhost + omits the token). Canonical impl in lib/anvil-client.ts (m13).
  const { connectUrl } = buildConnectUrls(BASE, s.id, KEY || undefined);
  return { id: s.id, browserWSEndpoint: connectUrl };
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

// ---- persistent-session actions (multi-step browsing) ---------------------
// These target an existing session via X-Session-Id, so an agent can navigate,
// then click/type, then read — across several tool calls on the same page.

async function action(sessionId: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return withRetry(async () => {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId, ...authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw new Error(`anvil ${path} failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return (await r.json().catch(() => ({}))) as Record<string, unknown>;
  }, path);
}

/** Navigate the session's page to a URL. SSRF-guarded. Defaults to
 * domcontentloaded — networkidle2 hangs (up to anvil's 60s cap) on sites that
 * keep polling (e.g. Hacker News), which caused user-facing timeouts. */
export async function navigate(sessionId: string, url: string, waitUntil = "domcontentloaded"): Promise<{ url: string; title: string }> {
  const check = isUrlSafe(url);
  if (!check.safe) throw new Error(`Blocked URL: ${check.reason}`);
  const r = await action(sessionId, "/v1/actions/navigate", { url, waitUntil });
  return { url: String(r.url ?? url), title: String(r.title ?? "") };
}

/** Click an element by CSS selector. */
export async function click(sessionId: string, selector: string): Promise<void> {
  await action(sessionId, "/v1/actions/click", { selector });
}

/** Type text into an element by CSS selector. */
export async function type(sessionId: string, selector: string, text: string): Promise<void> {
  await action(sessionId, "/v1/actions/type", { selector, text });
}

/**
 * Read the CURRENT page's text after navigate/click/type. anvil's /v1/scrape
 * always navigates (requires a url), so to read the live page we evaluate
 * document.body.innerText in the session via /v1/actions/evaluate.
 */
export async function readCurrent(sessionId: string): Promise<{ content: string; title: string; url: string }> {
  const script = "({content: document.body ? document.body.innerText : '', title: document.title, url: location.href})";
  const r = await action(sessionId, "/v1/actions/evaluate", { script });
  return {
    content: String((r as { content?: unknown }).content ?? ""),
    title: String((r as { title?: unknown }).title ?? ""),
    url: String((r as { url?: unknown }).url ?? ""),
  };
}

// ---- cookies (m29): let the agent act on a page the user is entitled to ----
// A cookie for anvil's /v1/cookies (puppeteer CookieParam shape). `domain` is required so a cookie
// is HOST-SCOPED — we never inject a cookie whose domain doesn't match the target host, so one
// site's session can't leak to another.
export interface AnvilCookie {
  name: string;
  value: string;
  domain: string;       // host the cookie belongs to (must match the page being visited)
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  expires?: number;
}

/** True if `cookie.domain` applies to `host` (exact host or a parent-domain cookie like ".x.com"). */
export function cookieMatchesHost(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith("." + d);
}

/** Inject cookies into a session before navigating. Only cookies whose domain matches `host` are
 * sent (cross-origin cookies are dropped, not forwarded) — the caller passes the target host so a
 * mismatched jar can't exfiltrate a session to another site. Returns how many were injected. */
export async function setCookies(sessionId: string, host: string, cookies: AnvilCookie[]): Promise<number> {
  const scoped = cookies.filter((c) => c.domain && cookieMatchesHost(c.domain, host));
  if (scoped.length === 0) return 0;
  const r = await action(sessionId, "/v1/cookies", { cookies: scoped });
  return Number((r as { injected?: unknown }).injected ?? scoped.length);
}

/** Read the session's current cookies (for debugging/inspection). anvil returns { cookies: [] }. */
export async function getCookies(sessionId: string): Promise<AnvilCookie[]> {
  const r = await withRetry(async () => {
    const res = await fetch(`${BASE}/v1/cookies`, {
      method: "GET",
      headers: { "X-Session-Id": sessionId, ...authHeaders() },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`anvil /v1/cookies failed: ${res.status}`);
    return (await res.json().catch(() => ({}))) as { cookies?: AnvilCookie[] };
  }, "/v1/cookies");
  return Array.isArray(r.cookies) ? r.cookies : [];
}

/**
 * Harvest anchor hrefs from a page. Creates a session, navigates, evaluates the
 * DOM for links, releases. Returns absolute URLs (best-effort, deduped, capped).
 * SSRF-guarded on the entry url; callers must still SSRF-filter harvested links.
 */
export async function discoverLinks(url: string, limit = 30): Promise<string[]> {
  const check = isUrlSafe(url);
  if (!check.safe) throw new Error(`Blocked URL: ${check.reason}`);
  const session = await createSession();
  try {
    await navigate(session.id, url, "domcontentloaded");
    await new Promise((r) => setTimeout(r, 600));
    const script = `Array.from(document.querySelectorAll('a[href]')).map(a=>a.href).filter(h=>/^https?:/.test(h)).slice(0, ${Math.max(1, Math.min(200, limit))})`;
    const r = await action(session.id, "/v1/actions/evaluate", { script });
    const links = Array.isArray(r) ? r : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of links) {
      const s = String(h).split("#")[0]!;
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out;
  } finally {
    await releaseSession(session.id);
  }
}

/**
 * Extract structured data blocks a text scrape misses: the page's JSON-LD
 * (<script type="application/ld+json">) plus key <meta> tags (og:*, twitter:*,
 * name/property + content). Many SPAs/product pages put the real data here rather
 * than in visible text. Creates a session, navigates, evaluates, releases. Returns a
 * single string (concatenated) — empty if none. SSRF-guarded.
 */
export async function extractStructured(url: string): Promise<string> {
  const check = isUrlSafe(url);
  if (!check.safe) throw new Error(`Blocked URL: ${check.reason}`);
  const session = await createSession();
  try {
    await navigate(session.id, url, "domcontentloaded");
    await new Promise((r) => setTimeout(r, 600));
    const script = `(() => {
      const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => s.textContent || "").join("\\n");
      const metas = Array.from(document.querySelectorAll('meta[property],meta[name]'))
        .map(m => { const k = m.getAttribute('property') || m.getAttribute('name'); const v = m.getAttribute('content'); return k && v ? k + ": " + v : ""; })
        .filter(Boolean).join("\\n");
      return (ld ? "JSON-LD:\\n" + ld + "\\n\\n" : "") + (metas ? "META:\\n" + metas : "");
    })()`;
    const r = await action(session.id, "/v1/actions/evaluate", { script });
    return typeof r === "string" ? r : String((r as { value?: unknown })?.value ?? "");
  } finally {
    await releaseSession(session.id);
  }
}

/**
 * Fetch a page's text: create a session, navigate (domcontentloaded — fast, and
 * avoids the networkidle2 hang that anvil's REST /v1/scrape forces with a 60s cap),
 * read the rendered text, release. SSRF-guarded first. Returns { content, title, url }.
 */
export async function scrape(
  url: string,
  _opts: { format?: "text" | "html"; waitForSelector?: string } = {}
): Promise<{ content: string; title: string; url: string }> {
  const check = isUrlSafe(url);
  if (!check.safe) throw new Error(`Blocked URL: ${check.reason}`);
  const session = await createSession();
  try {
    await navigate(session.id, url, "domcontentloaded");
    // brief settle for client-rendered content, then read the DOM text
    await new Promise((r) => setTimeout(r, 600));
    return await readCurrent(session.id);
  } finally {
    await releaseSession(session.id);
  }
}

/** Screenshot a URL: create a session, navigate, capture the viewport as JPEG bytes,
 * release. SSRF-guarded like scrape. Returns the raw image bytes (for Telegram sendPhoto). */
export async function screenshot(url: string): Promise<Uint8Array> {
  const check = isUrlSafe(url);
  if (!check.safe) throw new Error(`Blocked URL: ${check.reason}`);
  const session = await createSession();
  try {
    await navigate(session.id, url, "domcontentloaded");
    await new Promise((r) => setTimeout(r, 600)); // brief settle for client-rendered content
    const r = await fetch(`${BASE}/v1/screenshot?sessionId=${encodeURIComponent(session.id)}`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`anvil screenshot failed: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } finally {
    await releaseSession(session.id);
  }
}

/** Render a URL to PDF: create a session, navigate, POST /v1/pdf, release. SSRF-guarded like
 * scrape. Returns the raw PDF bytes (for Telegram sendDocument). */
export async function pdf(url: string): Promise<Uint8Array> {
  const check = isUrlSafe(url);
  if (!check.safe) throw new Error(`Blocked URL: ${check.reason}`);
  const session = await createSession();
  try {
    await navigate(session.id, url, "domcontentloaded");
    await new Promise((r) => setTimeout(r, 600)); // brief settle for client-rendered content
    const r = await fetch(`${BASE}/v1/pdf?sessionId=${encodeURIComponent(session.id)}`, {
      method: "POST",
      headers: authHeaders(),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`anvil pdf failed: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } finally {
    await releaseSession(session.id);
  }
}
