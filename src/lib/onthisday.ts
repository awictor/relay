// "On this day" in history (on-this-day-tool): "what happened on this day?", "anything happen on July 4
// in history?" is a delightful everyday ask with no home. This hits the KEYLESS Wikimedia On-This-Day feed
// (no signup) for notable events on a given month/day, newest-first, with a citation. Pure parse/format
// helpers exported + unit-tested; the network fetch is injected. Mirrors wikifact/dictionary/holidays.

export interface OnThisDayEvent { year: number; text: string; url?: string; }

// Keyless Wikimedia feed: notable "selected" events for MM/DD. Exported so the tool builds the URL.
export function onThisDayUrl(month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/selected/${mm}/${dd}`;
}

/** Parse the feed body into events (year + text + best page URL), newest year first, or [] on bad input.
 * The feed shape: { selected: [ { year, text, pages: [ { content_urls: { desktop: { page } } } ] } ] }.
 * Exported for tests. */
export function parseOnThisDay(body: string): OnThisDayEvent[] {
  try {
    const j = JSON.parse(body) as { selected?: unknown; events?: unknown };
    const arr = Array.isArray(j.selected) ? j.selected : Array.isArray(j.events) ? j.events : [];
    const out: OnThisDayEvent[] = [];
    for (const e of arr as Array<{ year?: unknown; text?: unknown; pages?: Array<{ content_urls?: { desktop?: { page?: string } } }> }>) {
      const year = typeof e.year === "number" ? e.year : Number(e.year);
      const text = String(e.text ?? "").trim();
      if (!text || !Number.isFinite(year)) continue;
      const url = e.pages?.[0]?.content_urls?.desktop?.page;
      out.push({ year, text, ...(url ? { url } : {}) });
    }
    // Newest first — a recent event is more relatable than an ancient one for a "what happened today" ask.
    out.sort((a, b) => b.year - a.year);
    return out;
  } catch { return []; }
}

const MO = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Month-name -> 1-12 (+ common abbreviations), for parsing an explicit "July 4" out of the request.
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11,
  november: 11, dec: 12, december: 12,
};

/** Pull an explicit month/day out of the request ("on July 4", "what happened on 12/25"), or null when
 * none is named (the caller then uses today's date). Exported for tests. */
export function parseMonthDay(text: string): { month: number; day: number } | null {
  const t = text.toLowerCase();
  // "July 4" / "July 4th" / "4 July"
  let m = t.match(/\b([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m && MONTHS[m[1]!]) return { month: MONTHS[m[1]!]!, day: +m[2]! };
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\b/);
  if (m && MONTHS[m[2]!]) return { month: MONTHS[m[2]!]!, day: +m[1]! };
  // "12/25" (M/D). If the FIRST number can't be a month (>12) but the second can, read it as D/M — the
  // unambiguous European form "25/12" = Dec 25 (onthisday-daymonth-order). US M/D is the default when both
  // are ≤12 (12/11 stays Dec 11), since this bot's phrasing is US-leaning; a >12 first number is the only
  // case a swap is certain, so it never mis-reads an ambiguous date.
  m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) {
    let a = +m[1]!, b = +m[2]!;
    if (a > 12 && b >= 1 && b <= 12) { const tmp = a; a = b; b = tmp; } // D/M -> M/D
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) return { month: a, day: b };
  }
  return null;
}

/** Format up to `limit` events into a short, phone-friendly list. Exported. */
export function formatOnThisDay(month: number, day: number, events: OnThisDayEvent[], limit = 5): string {
  const head = `📅 On ${MO[month - 1]} ${day} in history:`;
  const lines = events.slice(0, limit).map((e) => `• ${e.year}: ${e.text}`);
  return `${head}\n${lines.join("\n")}`;
}

/**
 * Answer an "on this day" request. Uses an explicit month/day from the text if named, else `today`
 * (the user's local {month,day}). `fetchText` is injected. Returns a formatted list, or null when the
 * feed is empty / fetch fails. Exported for the tool.
 */
export async function runOnThisDay(
  text: string,
  today: { month: number; day: number },
  fetchText: (url: string) => Promise<string>,
): Promise<string | null> {
  const md = parseMonthDay(text) ?? today;
  if (md.month < 1 || md.month > 12 || md.day < 1 || md.day > 31) return null;
  const events = parseOnThisDay(await fetchText(onThisDayUrl(md.month, md.day)).catch(() => ""));
  if (!events.length) return null;
  return formatOnThisDay(md.month, md.day, events);
}
