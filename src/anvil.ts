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

// ---- persistent-session actions (multi-step browsing) ---------------------
// These target an existing session via X-Session-Id, so an agent can navigate,
// then click/type, then read — across several tool calls on the same page.

async function action(sessionId: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sessionId, ...authHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`anvil ${path} failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
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
