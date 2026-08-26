// m29 cookies-2: an OPT-IN, env-seeded per-host cookie jar. An operator who wants the agent to read
// a page they're entitled to (e.g. a logged-in dashboard) puts cookies in a gitignored JSON file and
// points RELAY_COOKIES at it. When the agent navigates to a matching host, those cookies are seeded
// into the anvil session first — host-scoped (never cross-origin) and with values redacted from every
// log/reply. Default (no file) = nothing changes; the agent stays logged-out on public pages.
//
// File shape (RELAY_COOKIES, gitignored): { "cookies": [ { name, value, domain, path?, secure? }, ... ] }
import { readFileSync, existsSync } from "fs";
import type { AnvilCookie } from "../anvil.js";
import { cookieMatchesHost } from "../anvil.js";

let loaded: AnvilCookie[] | null = null;

/** Load + cache the cookie jar from RELAY_COOKIES (empty if unset/absent/corrupt — never throws). */
export function loadCookieJar(file = process.env.RELAY_COOKIES): AnvilCookie[] {
  if (loaded) return loaded;
  loaded = readJar(file);
  return loaded;
}

/** Testable pure read: parse a jar file to a cookie array; [] on any problem. */
export function readJar(file: string | undefined): AnvilCookie[] {
  if (!file || !existsSync(file)) return [];
  try {
    const obj = JSON.parse(readFileSync(file, "utf8"));
    const arr = Array.isArray(obj?.cookies) ? obj.cookies : [];
    return arr.filter((c: unknown): c is AnvilCookie =>
      !!c && typeof (c as AnvilCookie).name === "string" && typeof (c as AnvilCookie).value === "string" && typeof (c as AnvilCookie).domain === "string");
  } catch {
    return [];
  }
}

/** Cookies from the jar that apply to `host` (host-scoped — never returns another host's cookies). */
export function cookiesForHost(host: string, jar: AnvilCookie[] = loadCookieJar()): AnvilCookie[] {
  return jar.filter((c) => cookieMatchesHost(c.domain, host));
}

/** Redact cookie VALUES from a free-text string (logs/replies). Given the jar's values, replace each
 * with [redacted-cookie] so a seeded session cookie can't leak even if it lands in scraped text. */
export function redactCookieValues(text: string, jar: AnvilCookie[] = loadCookieJar()): string {
  let out = text;
  for (const c of jar) {
    if (c.value && c.value.length >= 4) {
      out = out.split(c.value).join("[redacted-cookie]");
    }
  }
  return out;
}

/** Test hook: reset the cached jar so a test can re-load with a different file. */
export function _resetCookieJarCache(): void { loaded = null; }
