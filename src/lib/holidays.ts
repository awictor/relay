// Public-holidays tool (holidays-tool): "is today a holiday?", "when's the next public holiday?",
// "what are the holidays this year in the UK?" are common everyday asks with no home — date_math only
// knows a handful of US holidays by NAME for date math, not "is it a holiday" / "next holiday" / a full
// country list. This hits the keyless nager.date API (no signup, HTTPS) for an instant, correct answer.
// Pure parse/format helpers exported + unit-tested; the network fetch is injected so it runs offline.

// A holiday record as the API returns it (subset we use).
export interface Holiday { date: string; localName: string; name: string; }

// Map common country names/adjectives -> ISO-3166 alpha-2 (nager.date's country code). Covers the
// countries a texting user is likely to name; an unrecognized name falls back to null and the tool asks.
const COUNTRY_CODES: Record<string, string> = {
  us: "US", usa: "US", "united states": "US", america: "US", american: "US",
  uk: "GB", "united kingdom": "GB", britain: "GB", "great britain": "GB", british: "GB", england: "GB", gb: "GB",
  canada: "CA", canadian: "CA", ca: "CA",
  australia: "AU", australian: "AU", au: "AU",
  ireland: "IE", irish: "IE", ie: "IE",
  germany: "DE", german: "DE", de: "DE",
  france: "FR", french: "FR", fr: "FR",
  spain: "ES", spanish: "ES", es: "ES",
  italy: "IT", italian: "IT", it: "IT",
  netherlands: "NL", dutch: "NL", nl: "NL",
  india: "IN", indian: "IN", in: "IN",
  mexico: "MX", mexican: "MX", mx: "MX",
  brazil: "BR", brazilian: "BR", br: "BR",
  japan: "JP", japanese: "JP", jp: "JP",
  "new zealand": "NZ", nz: "NZ",
};

/** Resolve a free-text country name/adjective/code to an ISO-3166 alpha-2 code, or null. A bare 2-letter
 * token is accepted as-is (uppercased) so an unlisted valid code still works. Exported for tests. */
export function resolveCountryCode(raw: string | undefined): string | null {
  const c = String(raw ?? "").trim().toLowerCase();
  if (!c) return null;
  if (COUNTRY_CODES[c]) return COUNTRY_CODES[c]!;
  if (/^[a-z]{2}$/.test(c)) return c.toUpperCase();
  return null;
}

/** Parse a JSON body into a Holiday[] (nager.date shape), or [] on bad/empty input. Exported. */
export function parseHolidays(body: string): Holiday[] {
  try {
    const arr = JSON.parse(body) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((h): h is { date: string; localName?: string; name?: string } => !!h && typeof (h as { date?: unknown }).date === "string")
      .map((h) => ({ date: h.date, localName: String(h.localName ?? h.name ?? "").trim(), name: String(h.name ?? h.localName ?? "").trim() }));
  } catch { return []; }
}

// nager.date endpoints (keyless). NextPublicHolidays returns the upcoming holidays for a country;
// PublicHolidays/{year}/{cc} returns a whole year's list. Exported so the tool builds the URL.
export function nextHolidaysUrl(cc: string): string {
  return `https://date.nager.at/api/v3/NextPublicHolidays/${encodeURIComponent(cc)}`;
}
export function yearHolidaysUrl(year: number, cc: string): string {
  return `https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(cc)}`;
}

// A readable date "Monday, September 7, 2026" from a YYYY-MM-DD (UTC-anchored so no TZ drift).
const WK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MO = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function humanDate(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return `${WK[d.getUTCDay()]}, ${MO[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function daysUntil(ymd: string, todayYmd: string): number {
  const a = Date.parse(ymd + "T00:00:00Z"), b = Date.parse(todayYmd + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((a - b) / 86_400_000);
}

export type HolidayIntent = "is-today" | "next" | "list";

/** Classify a holiday question. "is it a holiday (today)" -> is-today; "holidays this year / in 2026 /
 * all holidays" -> list; else (next holiday / when's the next) -> next. Exported for tests. */
export function parseHolidayIntent(text: string): HolidayIntent {
  const t = text.toLowerCase();
  if (/\b(is (it|today)|are we|today)\b.*\bholiday\b|\bholiday\b.*\btoday\b/.test(t)) return "is-today";
  if (/\b(all|list|which|what)\b.*\bholidays\b|\bholidays\b.*\b(this year|in \d{4}|for \d{4}|202\d)\b|\bpublic holidays\b/.test(t)) return "list";
  return "next";
}

/**
 * Answer a holiday question. `fetchText` is injected (guarded GET in prod, fake in tests). `today` is the
 * user's local YYYY-MM-DD (for is-today + days-until). Returns a formatted line, or null when the country
 * can't be resolved (caller asks) or the fetch fails. Country defaults to US when none is named.
 */
export async function runHolidays(
  text: string,
  countryRaw: string | undefined,
  today: string,
  fetchText: (url: string) => Promise<string>,
): Promise<string | null> {
  const cc = resolveCountryCode(countryRaw) ?? "US";
  const intent = parseHolidayIntent(text);
  const year = Number(today.slice(0, 4)) || new Date().getUTCFullYear();

  if (intent === "list") {
    const yr = (text.match(/\b(20\d{2})\b/) || [])[1];
    const y = yr ? Number(yr) : year;
    const list = parseHolidays(await fetchText(yearHolidaysUrl(y, cc)).catch(() => ""));
    if (!list.length) return null;
    const shown = list.slice(0, 20).map((h) => `• ${h.date} — ${h.localName}`);
    const more = list.length > shown.length ? `\n…and ${list.length - shown.length} more` : "";
    return `Public holidays in ${cc} for ${y} (${list.length}):\n${shown.join("\n")}${more}`;
  }

  // is-today / next both come from the upcoming list (+ this year for an is-today match).
  const next = parseHolidays(await fetchText(nextHolidaysUrl(cc)).catch(() => ""));
  if (intent === "is-today") {
    const hit = next.find((h) => h.date === today);
    // NextPublicHolidays excludes today if it already passed midnight in some tz; also check this year's list.
    if (hit) return `Yes — today (${humanDate(today)}) is ${hit.localName} in ${cc}.`;
    const yearList = parseHolidays(await fetchText(yearHolidaysUrl(year, cc)).catch(() => ""));
    const todayHit = yearList.find((h) => h.date === today);
    if (todayHit) return `Yes — today (${humanDate(today)}) is ${todayHit.localName} in ${cc}.`;
    const upcoming = next[0];
    const tail = upcoming ? ` The next one is ${upcoming.localName} on ${humanDate(upcoming.date)} (in ${daysUntil(upcoming.date, today)} days).` : "";
    return `No — today (${humanDate(today)}) isn't a public holiday in ${cc}.${tail}`;
  }
  // next
  const up = next[0];
  if (!up) return null;
  const d = daysUntil(up.date, today);
  const when = Number.isNaN(d) ? "" : d === 0 ? " (today)" : d === 1 ? " (tomorrow)" : ` (in ${d} days)`;
  return `The next public holiday in ${cc} is ${up.localName} on ${humanDate(up.date)}${when}.`;
}
