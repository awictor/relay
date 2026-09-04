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
  // m29 cookies-2: seed any env-jar cookies for THIS host before navigating, so the agent can read a
  // page the operator is entitled to. Lazy import breaks the anvil<->cookie-jar cycle. Best-effort:
  // a cookie-seed failure must not block the navigation (the page may just be public).
  try {
    const host = new URL(url).hostname;
    const { cookiesForHost } = await import("./lib/cookie-jar.js");
    const jar = cookiesForHost(host);
    if (jar.length) await setCookies(sessionId, host, jar);
  } catch { /* best-effort seeding */ }
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

// Set a <select> dropdown, checkbox, or radio (select-dropdown-support) — the form controls click/type
// can't drive. In-page: for a <select>, match `value` against an option's value OR its visible text
// (case-insensitive), set + fire change; for a checkbox/radio, interpret the value as on/off (true/yes/
// on/checked/1 -> checked) and click if it needs toggling so listeners fire; other inputs fall back to a
// value set + input/change. Returns an outcome string. Never throws inside the page.
const SET_FIELD_SCRIPT = (selector: string, value: string) => `(() => {
  try {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'not-found';
    const val = ${JSON.stringify(value)};
    const fire = (t) => el.dispatchEvent(new Event(t, { bubbles: true }));
    const tag = (el.tagName || '').toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'select') {
      const opts = Array.from(el.options);
      const want = val.trim().toLowerCase();
      const hit = opts.find(o => (o.value||'').trim().toLowerCase() === want) || opts.find(o => (o.textContent||'').trim().toLowerCase() === want) || opts.find(o => (o.textContent||'').trim().toLowerCase().includes(want));
      if (!hit) return 'no-option';
      el.value = hit.value; fire('input'); fire('change');
      return 'select-set';
    }
    if (type === 'checkbox' || type === 'radio') {
      const on = /^(1|true|yes|on|checked|select|check)$/i.test(val.trim());
      if (el.checked !== on) el.click();  // click so frameworks see the toggle
      return 'checkable-' + (el.checked ? 'on' : 'off');
    }
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, val); else el.value = val;
    fire('input'); fire('change');
    return 'value-set';
  } catch (e) { return 'error:' + (e && e.message || e); }
})()`;

/** Set a form control that click/type can't: a <select> dropdown (match by option value or visible
 * text), a checkbox/radio (on/off), or any input's value (select-dropdown-support). Runs in the current
 * session's page — requires a prior navigate/browse. Returns the in-page outcome ("select-set",
 * "checkable-on", "value-set", "no-option", "not-found", ...) so the caller can report honestly. */
export async function setField(sessionId: string, selector: string, value: string): Promise<string> {
  const r = await action(sessionId, "/v1/actions/evaluate", { script: SET_FIELD_SCRIPT(selector, value) });
  return typeof r === "string" ? r : String((r as { result?: unknown }).result ?? "");
}

// List the page's real interactive controls so a wrong-selector miss can self-correct
// (selector-not-found-candidates). kind="click" -> visible buttons/links; kind="field" -> inputs/selects/
// textareas. Each gets a STABLE selector (id > name > a nth-of-type path) + its visible text/label, capped.
// Runs in the page; returns [] on any error.
const DESCRIBE_CONTROLS_SCRIPT = (kind: string, cap: number) => `(() => {
  try {
    const kind = ${JSON.stringify(kind)};
    const sel = kind === 'field'
      ? 'input:not([type=hidden]), select, textarea'
      : 'button, a[href], [role=button], input[type=button], input[type=submit]';
    const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    const pathOf = (el) => {
      if (el.id) return '#' + cssEsc(el.id);
      const name = el.getAttribute && el.getAttribute('name');
      if (name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
      // nth-of-type path from the nearest id-anchored ancestor, else from body
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
        if (node.id) { parts.unshift('#' + cssEsc(node.id)); break; }
        const tag = node.tagName.toLowerCase();
        const sibs = node.parentNode ? Array.from(node.parentNode.children).filter((c) => c.tagName === node.tagName) : [node];
        const idx = sibs.indexOf(node) + 1;
        parts.unshift(sibs.length > 1 ? tag + ':nth-of-type(' + idx + ')' : tag);
        node = node.parentNode;
      }
      return parts.join(' > ');
    };
    const out = [];
    const seen = new Set();
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;                 // skip hidden
      const text = ((el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      const selector = pathOf(el);
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);
      out.push({ selector, text });
      if (out.length >= ${cap}) break;
    }
    return out;
  } catch (e) { return []; }
})()`;

/** List the page's visible interactive controls for the OPEN session — buttons/links (kind="click") or
 * inputs/selects (kind="field") — as [{selector,text}] with a stable selector each. Feeds a not-found
 * click/set_field/type back the page's REAL elements so the agent retries with a real selector instead of
 * re-guessing (selector-not-found-candidates). Requires a prior browse; capped (~12). Returns [] on error. */
export async function describeControls(sessionId: string, kind: "click" | "field", cap = 12): Promise<Array<{ selector: string; text: string }>> {
  const r = await action(sessionId, "/v1/actions/evaluate", { script: DESCRIBE_CONTROLS_SCRIPT(kind, Math.max(1, Math.min(30, cap))) });
  const arr = Array.isArray(r) ? r : (r as { result?: unknown }).result;
  return Array.isArray(arr) ? arr.filter((x): x is { selector: string; text: string } => !!x && typeof (x as { selector?: unknown }).selector === "string") : [];
}

// One presence check in the page: true if `target` matches a CSS selector with an element, OR (when it
// isn't valid CSS / matches nothing) if the body's text contains it (case-insensitive). Lets wait_for
// take either a selector (".results .item") or a phrase ("In stock") without the caller knowing which.
const PRESENCE_SCRIPT = (target: string) => `(() => {
  try {
    const t = ${JSON.stringify(target)};
    try { if (document.querySelector(t)) return true; } catch (e) { /* not a valid selector — fall through to text */ }
    return (document.body ? document.body.innerText : '').toLowerCase().includes(t.toLowerCase());
  } catch (e) { return false; }
})()`;

/** Wait until `target` (a CSS selector OR a text phrase) appears on the current session's page, polling
 * until present or `timeoutMs` (wait-for-selector). Closes the read-too-early race after a click /
 * set_field / site_search on a slow SPA/AJAX page, where the fixed sleeps could read a stale/empty page.
 * Requires a prior browse. Returns true if it appeared, false on timeout (the caller still reads + reports
 * honestly). Polls ~every 400ms; timeout clamped 1-30s. */
export async function waitFor(sessionId: string, target: string, timeoutMs = 8000): Promise<boolean> {
  const budget = Math.max(1000, Math.min(30000, timeoutMs));
  const started = Date.now();
  const script = PRESENCE_SCRIPT(target);
  for (;;) {
    let present = false;
    try { const r = await action(sessionId, "/v1/actions/evaluate", { script }); present = (r as unknown) === true; } catch { present = false; }
    if (present) return true;
    if (Date.now() - started >= budget) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
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
 * Best-effort dismiss cookie/consent/GDPR interstitials before reading (cookie-consent-dismiss).
 * On most news/EU pages the only thing in innerText ~600ms after load is the consent modal, so a
 * plain scrape would "summarize" the banner. Clicks a common Accept/Agree/OK control (matched by
 * button text + a few known ids/attrs), else removes fixed full-screen overlays. Runs in the page
 * via evaluate; never throws (swallows any error) so a normal page is unaffected.
 */
export async function dismissConsent(sessionId: string): Promise<void> {
  const script = `(() => {
    const wants = /^(accept all|accept|agree|i agree|got it|allow all|ok|continue|yes, i agree|accept cookies)$/i;
    const btns = Array.from(document.querySelectorAll('button, a[role=button], [role=button], input[type=button], input[type=submit]'));
    for (const b of btns) {
      const t = (b.innerText || b.textContent || b.value || '').trim();
      if (wants.test(t)) { try { b.click(); return 'clicked'; } catch (e) {} }
    }
    for (const sel of ['#onetrust-accept-btn-handler','[aria-label*="accept" i]','[data-testid*="accept" i]','.cookie-accept','#accept-cookies']) {
      const el = document.querySelector(sel); if (el) { try { el.click(); return 'clicked-sel'; } catch (e) {} }
    }
    // Fallback: strip fixed full-viewport overlays that would otherwise BE the innerText.
    let removed = 0;
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const s = getComputedStyle(el);
      if ((s.position === 'fixed' || s.position === 'sticky') && el.offsetHeight > window.innerHeight * 0.5 && el.offsetWidth > window.innerWidth * 0.5) {
        el.remove(); removed++;
      }
    }
    return 'removed:' + removed;
  })()`;
  try { await action(sessionId, "/v1/actions/evaluate", { script }); } catch { /* best-effort */ }
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

// Find a page's search box, type the query into it, and submit — all in the page (site-search-tool).
// Locates the input by common search-box signals (type=search, name/id/aria containing "search"/"q",
// role=searchbox, a placeholder mentioning search); sets its value + fires input/change so React-style
// listeners see it; submits via the enclosing <form>, else clicks a nearby submit/search button, else
// dispatches an Enter keydown. Returns whether it found + submitted a box. Never throws.
const SITE_SEARCH_SCRIPT = (q: string) => `(() => {
  try {
    const query = ${JSON.stringify(q)};
    const inputs = Array.from(document.querySelectorAll('input:not([type=hidden]), textarea'));
    const score = (el) => {
      const a = ((el.getAttribute('type')||'') + ' ' + (el.getAttribute('name')||'') + ' ' + (el.id||'') + ' ' + (el.getAttribute('aria-label')||'') + ' ' + (el.getAttribute('placeholder')||'') + ' ' + (el.getAttribute('role')||'')).toLowerCase();
      let s = 0;
      if (/\\bsearch\\b|searchbox/.test(a)) s += 3;
      if (el.getAttribute('type') === 'search') s += 3;
      if (/(^|[^a-z])q($|[^a-z])/.test((el.getAttribute('name')||'') + ' ' + (el.id||''))) s += 2;
      if (/find|query|keyword/.test(a)) s += 1;
      const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) s -= 5; // hidden
      return s;
    };
    const box = inputs.map((el) => [el, score(el)]).filter(([,s]) => s > 0).sort((a,b) => b[1]-a[1])[0]?.[0];
    if (!box) return 'no-search-box';
    box.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')?.set;
    if (setter) setter.call(box, query); else box.value = query;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const form = box.closest('form');
    if (form) { if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit(); return 'submitted-form'; }
    const btn = document.querySelector('button[type=submit], input[type=submit], [aria-label*="search" i], button.search');
    if (btn) { btn.click(); return 'clicked-submit'; }
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return 'pressed-enter';
  } catch (e) { return 'error:' + (e && e.message || e); }
})()`;

/** Search WITHIN a site (site-search-tool): navigate to the site, find its search box, type the query,
 * submit, wait for results to load, and read the results page text. Saves the agent the fragile
 * browse->guess-selector->type->find-submit->click dance. Returns the results-page text + title + final
 * url + whether a search box was found. Falls back to reading the landing page (found:false) when no
 * search box is detected, so the caller can decide to try a Google "site:" query instead. */
export async function siteSearch(url: string, query: string): Promise<{ content: string; title: string; url: string; found: boolean }> {
  const check = isUrlSafe(url);
  if (!check.safe) throw new Error(`Blocked URL: ${check.reason}`);
  const session = await createSession();
  try {
    await navigate(session.id, url, "domcontentloaded");
    await new Promise((r) => setTimeout(r, 600));
    await dismissConsent(session.id);
    await new Promise((r) => setTimeout(r, 200));
    let outcome = "";
    try { const r = await action(session.id, "/v1/actions/evaluate", { script: SITE_SEARCH_SCRIPT(query) }); outcome = typeof r === "string" ? r : String((r as { result?: unknown }).result ?? ""); } catch { outcome = "error"; }
    const found = /^(submitted-form|clicked-submit|pressed-enter)$/.test(outcome);
    // Give the results navigation/XHR time to render before reading.
    await new Promise((r) => setTimeout(r, found ? 1500 : 300));
    const read = await readCurrent(session.id);
    return { content: read.content, title: read.title, url: read.url || url, found };
  } finally {
    await releaseSession(session.id);
  }
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

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Unwrap a Bing `/ck/a?...&u=a1<base64url>` redirect to the real target URL. Returns the input
 * unchanged if it isn't a wrapped link. Exported for tests. */
export function unwrapBingUrl(href: string): string {
  try {
    const u = new URL(href);
    if (!/(^|\.)bing\.com$/i.test(u.hostname) || !u.pathname.startsWith("/ck/")) return href;
    const raw = u.searchParams.get("u") || "";
    const b64 = raw.startsWith("a1") ? raw.slice(2) : raw; // Bing prefixes the base64url with "a1"
    if (!b64) return href;
    const norm = b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4);
    const decoded = Buffer.from(norm, "base64").toString("utf8");
    return /^https?:/.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

/**
 * General web search (no URL needed). Drives anvil to Bing's HTML results (no API key, free, and —
 * unlike DuckDuckGo's html/lite endpoints — it doesn't CAPTCHA a real headless Chrome) and parses
 * the organic result rows into {title,url,snippet}. Bing wraps result links in a /ck/a redirect;
 * unwrapBingUrl() recovers the real https target so callers get a clean URL to scrape/extract next.
 * Creates a session, navigates, evaluates, releases.
 */
// Unwrap a DuckDuckGo html-endpoint result link (`//duckduckgo.com/l/?uddg=<urlencoded>`) to the real
// target. Returns the input unchanged if it isn't a wrapped link. Exported for tests.
export function unwrapDuckUrl(href: string): string {
  try {
    const h = href.startsWith("//") ? "https:" + href : href;
    const u = new URL(h);
    if (!/(^|\.)duckduckgo\.com$/i.test(u.hostname) || !u.pathname.startsWith("/l/")) return h;
    const target = u.searchParams.get("uddg");
    return target && /^https?:/.test(target) ? target : h;
  } catch {
    return href;
  }
}

// Collect + clean rows from a search-provider evaluate result into SearchResults, unwrapping redirect
// links via `unwrap`, de-duping, SSRF-filtering, capping. Shared by the Bing + DuckDuckGo paths.
function collectResults(rows: unknown, unwrap: (h: string) => string, cap: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const real = unwrap(String((row as { url?: unknown }).url ?? ""));
    if (!real || seen.has(real) || !isUrlSafe(real).safe) continue;
    seen.add(real);
    out.push({
      title: String((row as { title?: unknown }).title ?? "").slice(0, 200),
      url: real,
      snippet: String((row as { snippet?: unknown }).snippet ?? "").slice(0, 300),
    });
    if (out.length >= cap) break;
  }
  return out;
}

// Bing organic-results scrape (primary). <li class="b_algo"> rows with an <h2><a> + .b_caption p.
async function searchBing(query: string, cap: number): Promise<SearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  if (!isUrlSafe(url).safe) return [];
  const session = await createSession();
  try {
    await navigate(session.id, url, "domcontentloaded");
    await new Promise((r) => setTimeout(r, 700));
    const script = `(() => {
      const out = [];
      for (const el of Array.from(document.querySelectorAll('li.b_algo')).slice(0, ${cap * 2})) {
        const a = el.querySelector('h2 a');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        if (!/^https?:/.test(href)) continue;
        const sn = el.querySelector('.b_caption p') || el.querySelector('p');
        out.push({ title: (a.textContent||'').trim(), url: href, snippet: (sn?sn.textContent:'').trim() });
      }
      return out;
    })()`;
    const r = await action(session.id, "/v1/actions/evaluate", { script });
    return collectResults(r, unwrapBingUrl, cap);
  } finally {
    await releaseSession(session.id);
  }
}

// DuckDuckGo no-JS HTML endpoint (fallback). Rows are .result with a .result__a title link (a
// //duckduckgo.com/l/?uddg= redirect) + a .result__snippet. Used only when Bing returns nothing (a
// bot-check / markup change) so the headline "ask anything" errand isn't a single point of failure.
async function searchDuck(query: string, cap: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  if (!isUrlSafe(url).safe) return [];
  const session = await createSession();
  try {
    await navigate(session.id, url, "domcontentloaded");
    await new Promise((r) => setTimeout(r, 500));
    const script = `(() => {
      const out = [];
      for (const el of Array.from(document.querySelectorAll('.result, .web-result')).slice(0, ${cap * 2})) {
        const a = el.querySelector('a.result__a') || el.querySelector('h2 a');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        const sn = el.querySelector('.result__snippet') || el.querySelector('p');
        out.push({ title: (a.textContent||'').trim(), url: href, snippet: (sn?sn.textContent:'').trim() });
      }
      return out;
    })()`;
    const r = await action(session.id, "/v1/actions/evaluate", { script });
    return collectResults(r, unwrapDuckUrl, cap);
  } finally {
    await releaseSession(session.id);
  }
}

/**
 * General web search (no URL needed). Primary provider is Bing (no key, free, headless-friendly); when
 * it returns NOTHING (a bot-check or markup change would otherwise make the headline "ask anything"
 * errand fail cold) we fall back to DuckDuckGo's no-JS HTML endpoint — so one provider breaking doesn't
 * sink the first errand. Each provider drives its own anvil session; results are unwrapped + deduped +
 * SSRF-filtered by collectResults.
 */
export async function webSearch(query: string, limit = 6): Promise<SearchResult[]> {
  const q = String(query).trim().slice(0, 300);
  if (!q) return [];
  const cap = Math.max(1, Math.min(20, limit));
  const primary = await searchBing(q, cap).catch(() => [] as SearchResult[]);
  if (primary.length) return primary;
  // Bing came back empty — try the fallback before giving up.
  return await searchDuck(q, cap).catch(() => [] as SearchResult[]);
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
    // brief settle for client-rendered content, dismiss any cookie/consent overlay (so we read the
    // article not the banner), a short re-settle, then read the DOM text.
    await new Promise((r) => setTimeout(r, 600));
    await dismissConsent(session.id);
    await new Promise((r) => setTimeout(r, 200));
    return await readCurrent(session.id);
  } finally {
    await releaseSession(session.id);
  }
}

// Find the "next page" URL on the current page (multi-page-browse). Looks, in order, for: a
// <link rel=next> / <a rel=next>; then an anchor whose visible text or aria-label matches a
// next/more/older pager word (NOT "previous"); returns an absolute http(s) URL or "". Runs in the
// page via evaluate. Kept in-page (not a Relay-side heuristic) so it sees the rendered DOM + resolves
// hrefs against the live location. Exported for the paged scrape; safe to call on any page.
const NEXT_PAGE_SCRIPT = `(() => {
  const abs = (h) => { try { return new URL(h, location.href).href; } catch (e) { return ''; } };
  const rel = document.querySelector('link[rel~="next" i], a[rel~="next" i]');
  if (rel && rel.href) return abs(rel.getAttribute('href') || rel.href);
  const wants = /^(next|next page|more|show more|load more|older|older posts|next »|next ›)$/i;
  const cands = Array.from(document.querySelectorAll('a[href]'));
  for (const a of cands) {
    let label = ((a.innerText || a.textContent || '') + ' ' + (a.getAttribute('aria-label') || '') + ' ' + (a.getAttribute('title') || '')).replace(/\\s+/g, ' ').trim();
    if (/prev|previous|back|‹|«/i.test(label)) continue;         // never a "previous" control
    // Strip trailing/leading arrow glyphs a pager appends ("Next →", "Next »", "› Next") so the label
    // matches the wants list; a bare arrow ("›"/"»"/">"/">>") on its own still counts as next.
    const bare = label.replace(/[\\u2192\\u00bb\\u203a>\\u2794\\u279c\\u2b95→»›]+/g, '').trim();
    const isArrowOnly = label !== '' && bare === '';
    if (isArrowOnly || wants.test(bare)) { const h = a.getAttribute('href'); if (h && !/^javascript:/i.test(h)) return abs(h); }
  }
  return '';
})()`;

/** Scrape a listing/article across pagination: read the entry page, follow a detected "next" link
 * up to `maxPages` (default 3, hard-capped 5) under a wall-clock budget, and return the concatenated
 * text of each page (labeled) plus the list of URLs visited (multi-page-browse). One session is reused
 * across the whole crawl. Stops early when no next link is found, a page repeats (loop guard), a next
 * URL fails the SSRF check, or the time budget is hit. Falls back to a single page's text if nothing
 * paginates — so a caller can always use it where scrape() would work. */
export async function scrapePaged(
  url: string,
  maxPages = 3,
  opts: { budgetMs?: number } = {}
): Promise<{ content: string; title: string; url: string; pages: number; urls: string[] }> {
  const check = isUrlSafe(url);
  if (!check.safe) throw new Error(`Blocked URL: ${check.reason}`);
  const cap = Math.max(1, Math.min(5, maxPages));
  const budgetMs = opts.budgetMs ?? 45000;
  const started = Date.now();
  const session = await createSession();
  try {
    const seen = new Set<string>();
    const parts: string[] = [];
    const urls: string[] = [];
    let title = "";
    let current = url;
    for (let page = 1; page <= cap; page++) {
      const key = current.split("#")[0]!;
      if (seen.has(key)) break;                       // loop guard — a pager that points back at itself
      seen.add(key);
      await navigate(session.id, current, "domcontentloaded");
      await new Promise((r) => setTimeout(r, 600));
      if (page === 1) await dismissConsent(session.id); // consent modal only shows on the first landing
      await new Promise((r) => setTimeout(r, 200));
      const read = await readCurrent(session.id);
      if (page === 1) title = read.title;
      urls.push(read.url || current);
      parts.push(cap > 1 ? `--- page ${page} ---\n${read.content}` : read.content);
      if (page >= cap || Date.now() - started > budgetMs) break;
      // Find the next page IN the rendered DOM; stop if none / unsafe / already seen.
      let next = "";
      try { const r = await action(session.id, "/v1/actions/evaluate", { script: NEXT_PAGE_SCRIPT }); next = typeof r === "string" ? r : ""; } catch { next = ""; }
      if (!next || !isUrlSafe(next).safe || seen.has(next.split("#")[0]!)) break;
      current = next;
    }
    return { content: parts.join("\n\n"), title, url: urls[0] ?? url, pages: parts.length, urls };
  } finally {
    await releaseSession(session.id);
  }
}

// Scroll the page to its current bottom (to trigger an infinite-scroll feed to load more), then report
// the new scrollHeight so the caller can tell whether more content appeared. Runs in the page.
const SCROLL_STEP_SCRIPT = "(() => { window.scrollTo(0, document.body.scrollHeight); return document.body.scrollHeight; })()";

// Click a visible "Load more" / "Show more" / "See more" BUTTON (or button-like anchor) that fetches +
// appends items (load-more-button) — a pattern that is NEITHER a pagination link nor pure scroll. Matches
// on button text, skips a disabled/hidden control, clicks the first match, and returns whether it clicked.
// Runs in the page; never throws (returns false on any error).
const LOAD_MORE_CLICK_SCRIPT = `(() => {
  try {
    const wants = /^(load more|show more|see more|view more|more results|more|load more results|show \\d+ more)$/i;
    const els = Array.from(document.querySelectorAll('button, a[role=button], [role=button], input[type=button], input[type=submit]'));
    for (const el of els) {
      const t = ((el.innerText || el.textContent || el.value || '') + '').replace(/\\s+/g, ' ').trim();
      if (!wants.test(t)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;   // hidden control
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    }
    return false;
  } catch (e) { return false; }
})()`;

/** Scrape an INFINITE-SCROLL feed: navigate, then repeatedly scroll to the bottom (letting lazy content
 * load) until the page stops growing, a scroll cap is hit, or a wall-clock budget expires — THEN read the
 * fully-expanded text (browse-infinite-scroll). When a scroll doesn't grow the page, it also tries clicking
 * a "Load more"/"Show more" BUTTON that fetches+appends items (load-more-button) before giving up. For
 * feeds/listings that load on scroll or a load-more click rather than a pagination link (where scrapePaged
 * finds no "next"). One session; `maxScrolls` (each = one scroll OR one load-more click) capped 1-10
 * (default 5). Returns the text + how many rounds loaded new content. Safe on any page (stops at once when
 * nothing grows). */
export async function scrapeScroll(
  url: string,
  maxScrolls = 5,
  opts: { budgetMs?: number } = {}
): Promise<{ content: string; title: string; url: string; scrolls: number }> {
  const check = isUrlSafe(url);
  if (!check.safe) throw new Error(`Blocked URL: ${check.reason}`);
  const cap = Math.max(1, Math.min(10, maxScrolls));
  const budgetMs = opts.budgetMs ?? 45000;
  const started = Date.now();
  const session = await createSession();
  try {
    await navigate(session.id, url, "domcontentloaded");
    await new Promise((r) => setTimeout(r, 600));
    await dismissConsent(session.id);
    await new Promise((r) => setTimeout(r, 200));
    let lastHeight = 0;
    let productiveScrolls = 0;
    for (let i = 0; i < cap; i++) {
      if (Date.now() - started > budgetMs) break;
      let height = 0;
      try { const r = await action(session.id, "/v1/actions/evaluate", { script: SCROLL_STEP_SCRIPT }); height = Number(r) || 0; } catch { break; }
      await new Promise((r) => setTimeout(r, 900)); // let lazy content fetch + render
      if (height <= lastHeight) {
        // Scroll alone didn't grow the page — many listings gate "more" behind a "Load more" BUTTON that
        // fetches + appends on click (load-more-button). Try clicking it, then re-measure; only stop if
        // that ALSO doesn't grow the page (so a pure-scroll feed still stops immediately, unchanged).
        let clicked = false;
        try { const c = await action(session.id, "/v1/actions/evaluate", { script: LOAD_MORE_CLICK_SCRIPT }); clicked = (c as unknown) === true; } catch { clicked = false; }
        if (!clicked) break;                           // no scroll growth AND no load-more button -> done
        await new Promise((r) => setTimeout(r, 1000)); // let the click's fetch append
        let h2 = 0;
        try { const r = await action(session.id, "/v1/actions/evaluate", { script: "document.body.scrollHeight" }); h2 = Number(r) || 0; } catch { h2 = 0; }
        if (h2 <= lastHeight) break;                   // button click didn't add content -> done
        lastHeight = h2;
        productiveScrolls++;
        continue;
      }
      lastHeight = height;
      productiveScrolls++;
    }
    const read = await readCurrent(session.id);
    return { content: read.content, title: read.title, url: read.url || url, scrolls: productiveScrolls };
  } finally {
    await releaseSession(session.id);
  }
}

/** Screenshot a URL: create a session, navigate, capture bytes, release. SSRF-guarded like scrape.
 * `fullPage` captures the whole scrollable page (anvil's ?fullPage=true) instead of just the viewport
 * fold (full-page-screenshot) — for "screenshot the WHOLE page". A full-page capture of a long page can
 * be large + slow, so the timeout is bumped for it. Returns the raw image bytes (for Telegram sendPhoto). */
export async function screenshot(url: string, fullPage = false): Promise<Uint8Array> {
  const check = isUrlSafe(url);
  if (!check.safe) throw new Error(`Blocked URL: ${check.reason}`);
  const session = await createSession();
  try {
    await navigate(session.id, url, "domcontentloaded");
    await new Promise((r) => setTimeout(r, 600)); // brief settle for client-rendered content
    const q = `?sessionId=${encodeURIComponent(session.id)}${fullPage ? "&fullPage=true" : ""}`;
    const r = await fetch(`${BASE}/v1/screenshot${q}`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(fullPage ? 35000 : 20000), // a tall full-page render takes longer
    });
    if (!r.ok) throw new Error(`anvil screenshot failed: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } finally {
    await releaseSession(session.id);
  }
}

/** Screenshot the CURRENT page of an ALREADY-OPEN session — no navigate, no new session, no release
 * (screenshot-current-session). Lets the user SEE the live state of a carried browse session (applied
 * filters, current results) mid-thread so they can direct the next step, instead of re-navigating a fresh
 * URL (which would lose that state). The caller owns the session lifecycle. `fullPage` as in screenshot(). */
export async function screenshotCurrent(sessionId: string, fullPage = false): Promise<Uint8Array> {
  const q = `?sessionId=${encodeURIComponent(sessionId)}${fullPage ? "&fullPage=true" : ""}`;
  const r = await fetch(`${BASE}/v1/screenshot${q}`, {
    method: "GET",
    headers: authHeaders(),
    signal: AbortSignal.timeout(fullPage ? 35000 : 20000),
  });
  if (!r.ok) throw new Error(`anvil screenshot failed: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
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
