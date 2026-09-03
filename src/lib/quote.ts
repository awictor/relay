// Stock/equity quote (stock-quote-tool): "what's Tesla at?" / "AAPL price" used to degrade to a slow,
// flaky web_search + scrape that often mis-parsed the number. This hits a keyless quote API (Yahoo
// Finance chart JSON, no signup) for an instant symbol->price, mirroring the fx-conversion-tool. Pure
// parse/format helpers are exported + unit-tested; the network fetch takes an injectable getter so it
// runs offline in tests. Yahoo returns the currency + previous close, so we can show a $ sign + a
// day change % for free.

export interface Quote { symbol: string; price: number; currency?: string; changePct?: number; asOf?: string; exchange?: string; }

// A ticker is 1-12 chars: letters/digits, optional dotted exchange suffix (AAPL, BRK.B, VOD.L, SHOP.TO),
// optionally a leading ^ for an index (^GSPC) or a =X for FX Yahoo also serves. We uppercase + validate
// but pass the symbol through as-is (Yahoo resolves bare US tickers and dotted foreign ones directly).
export function normalizeSymbol(raw: string): string | null {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s) return null;
  if (!/^\^?[A-Z0-9]{1,6}([.\-=][A-Z0-9]{1,3})?$/.test(s)) return null;
  return s;
}

// Keyless quote API (no signup): Yahoo Finance chart endpoint returns JSON with a `meta` block carrying
// regularMarketPrice, currency, chartPreviousClose, regularMarketTime. Free, HTTPS. Exported so the tool
// builds the URL. range=1d/interval=1d is the smallest payload that still includes the meta block.
export function quoteUrl(symbol: string): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
}

/** Pull the latest price + currency + day-change out of a Yahoo chart JSON body, or null if absent/bad
 * (unknown symbol -> {chart:{result:null,error:{...}}}). asOf is a UTC YYYY-MM-DD HH:MM from the epoch
 * regularMarketTime. changePct is vs the previous close when both are present. */
export function parseQuote(body: string): Quote | null {
  try {
    const obj = JSON.parse(body) as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> | null; error?: unknown } };
    const meta = obj.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = Number(meta.regularMarketPrice);
    if (!Number.isFinite(price)) return null;
    const symbol = typeof meta.symbol === "string" ? meta.symbol : "";
    if (!symbol) return null;
    const prev = Number(meta.chartPreviousClose);
    const changePct = Number.isFinite(prev) && prev !== 0 ? ((price - prev) / prev) * 100 : undefined;
    const t = Number(meta.regularMarketTime);
    let asOf: string | undefined;
    if (Number.isFinite(t) && t > 0) {
      const d = new Date(t * 1000);
      asOf = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    }
    return {
      symbol,
      price,
      ...(typeof meta.currency === "string" ? { currency: meta.currency } : {}),
      ...(changePct !== undefined ? { changePct } : {}),
      ...(asOf ? { asOf } : {}),
      ...(typeof meta.fullExchangeName === "string" ? { exchange: meta.fullExchangeName } : {}),
    };
  } catch { return null; }
}

const CCY_SYMBOL: Record<string, string> = { USD: "$", GBP: "£", EUR: "€", JPY: "¥", CAD: "C$", AUD: "A$", INR: "₹" };

/** Format a quote into a short human line: "AAPL: $195.89 (▲0.42%, as of 2024-06-01 20:00 UTC)". Uses
 * the currency symbol when known (GBp/pence shown as a bare number), and a ▲/▼ + signed % day change. */
export function formatQuote(q: Quote): string {
  const sym = q.currency ? (CCY_SYMBOL[q.currency] ?? "") : "";
  const money = `${sym}${q.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const ccy = q.currency && !CCY_SYMBOL[q.currency] ? ` ${q.currency}` : "";
  const bits: string[] = [];
  if (q.changePct !== undefined) {
    const arrow = q.changePct > 0 ? "▲" : q.changePct < 0 ? "▼" : "";
    bits.push(`${arrow}${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%`);
  }
  if (q.asOf) bits.push(`as of ${q.asOf} UTC`);
  const tail = bits.length ? ` (${bits.join(", ")})` : "";
  return `${q.symbol}: ${money}${ccy}${tail}`;
}

/**
 * Fetch a live-ish quote for `symbol` from a keyless API. `fetchText` is injected (real guarded GET in
 * prod, a fake in tests) and returns the response body for the quote URL. Returns null on a bad symbol
 * or a fetch/parse failure — the caller falls back to web_search.
 */
export async function getQuote(
  symbol: string,
  fetchText: (url: string) => Promise<string>,
): Promise<Quote | null> {
  const s = normalizeSymbol(symbol);
  if (!s) return null;
  try {
    const body = await fetchText(quoteUrl(s));
    return parseQuote(body);
  } catch { return null; }
}
