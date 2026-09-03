// Crypto price (crypto-quote-tool): "price of bitcoin" / "what's ETH at" is Relay's MOST-promoted first
// errand (it's the literal /start + README example "save btc: check the price of bitcoin"), yet get_quote
// is equities-only and rejected crypto, so the flagship demo fell to a slow, flaky web_search+scrape.
// This hits the keyless CoinGecko API (no signup) for an instant price + 24h change, mirroring get_quote/
// convert_currency. Pure parse/format helpers exported + unit-tested; the network fetch is injected.

export interface CryptoQuote { id: string; symbol: string; usd: number; change24h?: number; }

// The common coins by ticker/name -> CoinGecko id, so the everyday "btc"/"bitcoin"/"eth" cases skip the
// search round-trip. Anything not here falls back to the search endpoint (resolveId). Lowercased keys.
const COMMON: Record<string, string> = {
  btc: "bitcoin", bitcoin: "bitcoin",
  eth: "ethereum", ethereum: "ethereum", ether: "ethereum",
  sol: "solana", solana: "solana",
  xrp: "ripple", ripple: "ripple",
  doge: "dogecoin", dogecoin: "dogecoin",
  ada: "cardano", cardano: "cardano",
  bnb: "binancecoin",
  usdt: "tether", tether: "tether", usdc: "usd-coin",
  ltc: "litecoin", litecoin: "litecoin",
  dot: "polkadot", polkadot: "polkadot",
  matic: "matic-network", polygon: "matic-network",
  avax: "avalanche-2", avalanche: "avalanche-2",
  link: "chainlink", chainlink: "chainlink",
  trx: "tron", tron: "tron", ton: "the-open-network",
  shib: "shiba-inu", "shiba inu": "shiba-inu",
  bch: "bitcoin-cash", xlm: "stellar", atom: "cosmos", uni: "uniswap",
};

/** Normalize a user's coin word to a lookup key (lowercased, trimmed, strip a leading $). */
export function normalizeCoin(raw: string): string {
  return String(raw ?? "").trim().toLowerCase().replace(/^\$/, "");
}

/** A known CoinGecko id for a common coin word, or null (caller then searches). Exported for tests. */
export function commonCoinId(raw: string): string | null {
  const k = normalizeCoin(raw);
  return k && COMMON[k] ? COMMON[k]! : null;
}

// CoinGecko keyless endpoints (no signup). search resolves an unknown symbol/name -> a coin id; price
// returns { <id>: { usd, usd_24h_change } }. Exported so the tool builds the URLs.
export function searchUrl(query: string): string {
  return `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`;
}
export function priceUrl(id: string): string {
  return `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true`;
}

/** Pull the FIRST coin's {id, symbol} out of a CoinGecko search response, or null. The API orders by
 * market-cap rank, so the top hit for "btc" is Bitcoin, not a scam clone. Exported for tests. */
export function parseSearchId(body: string): { id: string; symbol: string } | null {
  try {
    const obj = JSON.parse(body) as { coins?: Array<{ id?: string; symbol?: string }> };
    const c = obj.coins?.[0];
    if (!c?.id) return null;
    return { id: c.id, symbol: (c.symbol || c.id).toUpperCase() };
  } catch { return null; }
}

/** Pull the USD price + 24h change for `id` out of a simple/price response, or null. Exported for tests. */
export function parsePrice(body: string, id: string, symbol: string): CryptoQuote | null {
  try {
    const obj = JSON.parse(body) as Record<string, { usd?: number; usd_24h_change?: number }>;
    const row = obj[id];
    if (!row || typeof row.usd !== "number" || !Number.isFinite(row.usd)) return null;
    return { id, symbol, usd: row.usd, ...(typeof row.usd_24h_change === "number" ? { change24h: row.usd_24h_change } : {}) };
  } catch { return null; }
}

/** Format a crypto quote into a short human line: "BTC: $77,706 (▲+0.05% 24h)". */
export function formatCrypto(q: CryptoQuote): string {
  const price = q.usd >= 1
    ? `$${q.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
    : `$${q.usd.toLocaleString("en-US", { maximumFractionDigits: 8 })}`; // sub-$1 coins need more precision
  let chg = "";
  if (q.change24h !== undefined) {
    const arrow = q.change24h > 0 ? "▲" : q.change24h < 0 ? "▼" : "";
    chg = ` (${arrow}${q.change24h >= 0 ? "+" : ""}${q.change24h.toFixed(2)}% 24h)`;
  }
  return `${q.symbol}: ${price}${chg}`;
}

/**
 * Fetch a crypto price by coin word (ticker or name). `fetchText` is injected (guarded GET in prod, a
 * fake in tests). Resolves a common coin locally, else searches CoinGecko for the id, then fetches the
 * price. Returns null on an unknown coin / fetch failure — the caller falls back to web_search.
 */
export async function getCryptoQuote(
  coin: string,
  fetchText: (url: string) => Promise<string>,
): Promise<CryptoQuote | null> {
  const word = normalizeCoin(coin);
  if (!word) return null;
  try {
    let id = commonCoinId(word);
    let symbol = word.toUpperCase();
    if (!id) {
      const found = parseSearchId(await fetchText(searchUrl(word)));
      if (!found) return null;
      id = found.id; symbol = found.symbol;
    } else {
      symbol = (word.length <= 5 ? word : id).toUpperCase(); // prefer a ticker the user typed
    }
    return parsePrice(await fetchText(priceUrl(id)), id, symbol);
  } catch { return null; }
}
