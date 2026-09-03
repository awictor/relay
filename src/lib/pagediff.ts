// Watch-any-page (watch-any-page-diff): "watch policy: https://site/terms" tells Relay to ping when THAT
// page changes — restocks, price drops with no fixed number, status/policy/appointment pages that the
// numeric-threshold + feed watches can't cover. The page's visible text is snapshotted; each check
// re-fetches, and on a real change the notification shows the added/removed lines (a "what changed"
// diff), not just "it changed". Pure normalize + diff helpers; the fetch is injected in the runner.

// Cap the stored/compared page text so a huge page (long terms/search-results, hundreds of KB) can't
// bloat the shared alerts store + break every user's persist (page-diff-snapshot-cap). ~16KB of visible
// text is plenty to detect a real content change.
const MAX_PAGE_TEXT = 16_000;

/** Reduce raw page text/HTML to its stable, comparable content: strip tags, collapse whitespace, drop
 * blank lines. Volatile cruft (scripts/styles) is removed so a page's real content change fires but a
 * re-render with the same text doesn't. Capped to MAX_PAGE_TEXT chars. Exported for tests. */
export function pageText(raw: string): string {
  const out = String(raw ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")        // tags -> line breaks so block content stays on its own line
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return out.length > MAX_PAGE_TEXT ? out.slice(0, MAX_PAGE_TEXT) : out;
}

/** A page snapshot with VOLATILE tokens masked, for change comparison only (page-diff-flap-guard). A
 * page that legitimately re-renders every load — an embedded CSRF/nonce, a rotating session id, a
 * timestamp, "3 minutes ago" — otherwise diffs as a change on EVERY fetch and pings forever. Masking
 * these before comparing means only a REAL content change registers. Not shown to the user (the diff
 * still displays the real lines); only pageKey uses this. Exported for tests. */
export function stableText(raw: string): string {
  return pageText(raw)
    .replace(/\b[0-9a-f]{16,}\b/gi, "§")                         // long hex tokens (nonces, session ids)
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2})?\b/gi, "§") // ISO timestamps
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, "§")  // clock times
    .replace(/\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi, "§") // "3 minutes ago"
    .replace(/\b\d{10,}\b/g, "§");                               // long digit runs (epoch ms, ids)
}

/** A stable comparison key for a page snapshot: normalized text with volatile tokens masked, lowercased.
 * Two fetches differing only in whitespace/case OR in a nonce/timestamp/"N ago" compare equal, so a page
 * that re-renders every load doesn't flap (page-diff-flap-guard). A real content change differs. Tests. */
export function pageKey(raw: string): string {
  return stableText(raw).toLowerCase();
}

export interface PageDiff { changed: boolean; added: string[]; removed: string[] }

/** Diff two page snapshots (raw text/HTML) into added + removed content lines. Line-set based (order-
 * independent) so a reordered nav doesn't read as a change, only genuinely new/gone lines do. `changed`
 * is true iff there's any add or remove. Exported for tests. */
export function diffPages(prevRaw: string, nextRaw: string): PageDiff {
  const prev = new Set(pageText(prevRaw).split("\n").map((l) => l.toLowerCase()));
  const next = new Set(pageText(nextRaw).split("\n").map((l) => l.toLowerCase()));
  const prevLines = pageText(prevRaw).split("\n");
  const nextLines = pageText(nextRaw).split("\n");
  // Report in original (non-lowercased) form, de-duped, preserving first-seen order.
  const seenAdd = new Set<string>(), seenRem = new Set<string>();
  const added = nextLines.filter((l) => { const k = l.toLowerCase(); if (prev.has(k) || seenAdd.has(k)) return false; seenAdd.add(k); return true; });
  const removed = prevLines.filter((l) => { const k = l.toLowerCase(); if (next.has(k) || seenRem.has(k)) return false; seenRem.add(k); return true; });
  return { changed: added.length > 0 || removed.length > 0, added, removed };
}

/** Format a page-change notification: a short "what changed" summary (added/removed lines, capped). */
export function formatPageDiff(name: string, d: PageDiff): string {
  const cap = (arr: string[], n: number) => arr.slice(0, n).map((l) => `• ${l.slice(0, 120)}`);
  const parts: string[] = [`🔔 ${name} changed:`];
  if (d.added.length) parts.push(`Added:\n${cap(d.added, 5).join("\n")}${d.added.length > 5 ? `\n…+${d.added.length - 5} more` : ""}`);
  if (d.removed.length) parts.push(`Removed:\n${cap(d.removed, 5).join("\n")}${d.removed.length > 5 ? `\n…+${d.removed.length - 5} more` : ""}`);
  if (!d.added.length && !d.removed.length) parts.push("(the page content changed)");
  return parts.join("\n");
}

/** Is a watch task a bare URL (a page-diff watch), and if so its URL? "https://x.com/p" or "watch this
 * page: <url>" both reduce to the URL. Returns the http(s) URL or null. Exported for tests. */
export function pageWatchUrl(task: string): string | null {
  const t = task.trim();
  // Accept a task that is ESSENTIALLY just a URL (optionally prefixed with "this page"/"the page"/"page").
  const m = t.match(/^(?:(?:this|the)\s+page\s*:?\s*|page\s*:?\s*|watch\s+)?(https?:\/\/\S+)\s*$/i);
  return m ? m[1]! : null;
}
