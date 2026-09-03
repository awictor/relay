import { describe, it, expect } from "vitest";
import { normalizeCoin, commonCoinId, searchUrl, priceUrl, parseSearchId, parsePrice, formatCrypto, getCryptoQuote } from "../src/lib/crypto.js";

describe("commonCoinId / normalizeCoin", () => {
  it("resolves common tickers + names to CoinGecko ids", () => {
    expect(commonCoinId("btc")).toBe("bitcoin");
    expect(commonCoinId("BITCOIN")).toBe("bitcoin");
    expect(commonCoinId("$eth")).toBe("ethereum");
    expect(commonCoinId("doge")).toBe("dogecoin");
  });
  it("null for an unknown coin (caller then searches)", () => {
    expect(commonCoinId("obscuretoken")).toBeNull();
    expect(commonCoinId("")).toBeNull();
  });
});

describe("parseSearchId", () => {
  it("takes the top (highest market-cap) hit", () => {
    const body = JSON.stringify({ coins: [{ id: "bitcoin", symbol: "btc" }, { id: "bitget-wrapped-btc", symbol: "wbtc" }] });
    expect(parseSearchId(body)).toEqual({ id: "bitcoin", symbol: "BTC" });
  });
  it("null on no hits / bad json", () => {
    expect(parseSearchId(JSON.stringify({ coins: [] }))).toBeNull();
    expect(parseSearchId("nope")).toBeNull();
  });
});

describe("parsePrice", () => {
  it("pulls usd + 24h change for the id", () => {
    const body = JSON.stringify({ bitcoin: { usd: 77706, usd_24h_change: 0.0535 } });
    expect(parsePrice(body, "bitcoin", "BTC")).toEqual({ id: "bitcoin", symbol: "BTC", usd: 77706, change24h: 0.0535 });
  });
  it("null when the id isn't in the response / no usd", () => {
    expect(parsePrice(JSON.stringify({ ethereum: { usd: 2401 } }), "bitcoin", "BTC")).toBeNull();
    expect(parsePrice(JSON.stringify({ bitcoin: {} }), "bitcoin", "BTC")).toBeNull();
  });
});

describe("formatCrypto", () => {
  it("formats a gainer with ▲ + 24h change", () => {
    expect(formatCrypto({ id: "bitcoin", symbol: "BTC", usd: 77706, change24h: 0.05 })).toBe("BTC: $77,706 (▲+0.05% 24h)");
  });
  it("formats a loser with ▼", () => {
    expect(formatCrypto({ id: "ethereum", symbol: "ETH", usd: 2401.38, change24h: -0.82 })).toBe("ETH: $2,401.38 (▼-0.82% 24h)");
  });
  it("uses more precision for a sub-$1 coin", () => {
    expect(formatCrypto({ id: "shiba-inu", symbol: "SHIB", usd: 0.0000234 })).toMatch(/SHIB: \$0\.0000234/);
  });
});

describe("getCryptoQuote (injected fetch)", () => {
  it("resolves a common coin locally (no search) then fetches the price", async () => {
    const calls: string[] = [];
    const fetchText = async (url: string) => {
      calls.push(url);
      return JSON.stringify({ bitcoin: { usd: 77706, usd_24h_change: 0.05 } });
    };
    const q = await getCryptoQuote("btc", fetchText);
    expect(q?.usd).toBe(77706);
    expect(q?.symbol).toBe("BTC");
    expect(calls).toHaveLength(1);                 // no search round-trip for a common coin
    expect(calls[0]).toContain("simple/price?ids=bitcoin");
  });
  it("searches for an unknown coin, then fetches its price", async () => {
    const calls: string[] = [];
    const fetchText = async (url: string) => {
      calls.push(url);
      if (url.includes("/search")) return JSON.stringify({ coins: [{ id: "pepe", symbol: "pepe" }] });
      return JSON.stringify({ pepe: { usd: 0.0000089, usd_24h_change: 3.1 } });
    };
    const q = await getCryptoQuote("pepe", fetchText);
    expect(q?.id).toBe("pepe");
    expect(q?.usd).toBe(0.0000089);
    expect(calls[0]).toContain("/search");
    expect(calls[1]).toContain("simple/price?ids=pepe");
  });
  it("null on an unknown coin / fetch failure", async () => {
    expect(await getCryptoQuote("nonesuchcoin", async () => JSON.stringify({ coins: [] }))).toBeNull();
    expect(await getCryptoQuote("btc", async () => { throw new Error("net"); })).toBeNull();
    expect(await getCryptoQuote("", async () => "")).toBeNull();
  });
});
