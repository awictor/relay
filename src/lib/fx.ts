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

export interface Conversion { amount: number; from: string; to: string; rate: number; result: number; }

/** Format a conversion into a short human line: "200 USD = 184.60 EUR (rate 0.9230)". */
export function formatConversion(c: Conversion): string {
  const money = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return `${money(c.amount)} ${c.from} = ${money(c.result)} ${c.to} (rate ${c.rate.toFixed(4)})`;
}

// Keyless FX rate API (no signup): open.er-api.com returns { result:"success", rates:{ EUR:0.92, ... } }
// based on the `from` currency. Free, generous limits, HTTPS. Exported for the tool to build the URL.
export function fxUrl(from: string): string {
  return `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;
}

/** Pull the target rate out of an open.er-api.com response body (JSON text), or null if absent/bad. */
export function parseFxRate(body: string, to: string): number | null {
  try {
    const obj = JSON.parse(body) as { result?: string; rates?: Record<string, number> };
    if (obj.result && obj.result !== "success") return null;
    const rate = obj.rates?.[to];
    return typeof rate === "number" && Number.isFinite(rate) ? rate : null;
  } catch { return null; }
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
    const rate = parseFxRate(body, t);
    if (rate === null) return null;
    return { amount: amt, from: f, to: t, rate, result: amt * rate };
  } catch { return null; }
}
