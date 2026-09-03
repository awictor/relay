// Currency conversion (fx-conversion-tool): "200 USD in EUR right now" was improvised via a slow
// web_search + scrape that often returned a stale/mis-parsed number. This hits a keyless FX rate API
// directly for an instant, correct answer. Pure parse/format helpers are exported + unit-tested; the
// network fetch takes an injectable getter so it runs offline in tests.

/** Normalize a currency code (or a common symbol/word) to a 3-letter ISO code, or null. */
const SYMBOLS: Record<string, string> = { "$": "USD", "us$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "dollar": "USD", "dollars": "USD", "usd": "USD", "euro": "EUR", "euros": "EUR", "pound": "GBP", "pounds": "GBP", "yen": "JPY", "rupee": "INR", "rupees": "INR" };
export function normalizeCurrency(code: string): string | null {
  const c = String(code ?? "").trim().toLowerCase();
  if (!c) return null;
  if (SYMBOLS[c]) return SYMBOLS[c]!;
  if (/^[a-z]{3}$/.test(c)) return c.toUpperCase();
  return null;
}

export interface Conversion { amount: number; from: string; to: string; rate: number; result: number; asOf?: string; }

/** Render a rate at ADAPTIVE precision so a tiny inverse rate (e.g. IDR->USD ~0.0000238) doesn't show
 * as "0.0000". Uses enough decimals to keep ~4 significant figures for sub-1 rates. */
function fmtRate(r: number): string {
  const a = Math.abs(r);
  if (a === 0) return "0";
  if (a >= 1) return r.toFixed(4);
  const decimals = Math.min(10, Math.max(4, 3 - Math.floor(Math.log10(a))));
  return r.toFixed(decimals);
}

/** Format a conversion into a short human line: "200 USD = 184.60 EUR (rate 0.9230, as of 2024-06-01)".
 * Says "as of <date>" (the source refreshes ~daily) rather than claiming "live" — it's a money figure. */
export function formatConversion(c: Conversion): string {
  const money = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const asOf = c.asOf ? `, as of ${c.asOf}` : "";
  return `${money(c.amount)} ${c.from} = ${money(c.result)} ${c.to} (rate ${fmtRate(c.rate)}${asOf})`;
}

// Keyless FX rate API (no signup): open.er-api.com returns { result:"success", rates:{ EUR:0.92, ... } }
// based on the `from` currency. Free, generous limits, HTTPS. Exported for the tool to build the URL.
export function fxUrl(from: string): string {
  return `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;
}

/** Pull the target rate + the source's last-update date out of an open.er-api.com response body, or
 * null if absent/bad. `asOf` is a short YYYY-MM-DD (the API's time_last_update_utc), or undefined. */
export function parseFx(body: string, to: string): { rate: number; asOf?: string } | null {
  try {
    const obj = JSON.parse(body) as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string };
    if (obj.result && obj.result !== "success") return null;
    const rate = obj.rates?.[to];
    if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
    // time_last_update_utc is like "Sat, 01 Jun 2024 00:00:01 +0000" — pull the date part.
    let asOf: string | undefined;
    const m = obj.time_last_update_utc?.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
    if (m) asOf = `${m[3]}-${MONTHS[m[2]!] ?? "??"}-${m[1]!.padStart(2, "0")}`;
    return { rate, asOf };
  } catch { return null; }
}
const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

/** Back-compat: just the rate (older callers/tests). */
export function parseFxRate(body: string, to: string): number | null {
  return parseFx(body, to)?.rate ?? null;
}

/**
 * Convert `amount` from -> to using a keyless FX API. `fetchText` is injected (real guarded GET in prod,
 * a fake in tests) and returns the response body for the fx URL. Returns null when a currency code is
 * invalid or the rate can't be fetched — the caller falls back to telling the user / a web search.
 */
export async function convertCurrency(
  amount: number,
  from: string,
  to: string,
  fetchText: (url: string) => Promise<string>,
): Promise<Conversion | null> {
  const f = normalizeCurrency(from), t = normalizeCurrency(to);
  if (!f || !t) return null;
  const amt = Number.isFinite(amount) ? amount : 1;
  if (f === t) return { amount: amt, from: f, to: t, rate: 1, result: amt };
  try {
    const body = await fetchText(fxUrl(f));
    const parsed = parseFx(body, t);
    if (!parsed) return null;
    return { amount: amt, from: f, to: t, rate: parsed.rate, result: amt * parsed.rate, ...(parsed.asOf ? { asOf: parsed.asOf } : {}) };
  } catch { return null; }
}
