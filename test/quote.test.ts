import { describe, it, expect } from "vitest";
import { normalizeSymbol, quoteUrl, parseQuote, formatQuote, getQuote } from "../src/lib/quote.js";

// Minimal Yahoo chart JSON with a meta block. time 1717272000 = 2024-06-01 20:00 UTC.
const yahoo = (over: Record<string, unknown> = {}) => JSON.stringify({
  chart: { result: [{ meta: { symbol: "AAPL", currency: "USD", regularMarketPrice: 195.89, chartPreviousClose: 195.07, regularMarketTime: 1717272000, fullExchangeName: "NasdaqGS", ...over } }], error: null },
});
const yahooError = JSON.stringify({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } });

describe("normalizeSymbol", () => {
  it("uppercases a bare ticker", () => {
    expect(normalizeSymbol("aapl")).toBe("AAPL");
    expect(normalizeSymbol("TSLA")).toBe("TSLA");
  });
  it("keeps a dotted exchange suffix + index caret", () => {
    expect(normalizeSymbol("vod.l")).toBe("VOD.L");
    expect(normalizeSymbol("shop.to")).toBe("SHOP.TO");
    expect(normalizeSymbol("brk.b")).toBe("BRK.B");
    expect(normalizeSymbol("^gspc")).toBe("^GSPC");
  });
  it("rejects junk / empty / too-long", () => {
    expect(normalizeSymbol("")).toBeNull();
    expect(normalizeSymbol("not a ticker")).toBeNull();
    expect(normalizeSymbol("toolongsymbol")).toBeNull();
    expect(normalizeSymbol("$$$")).toBeNull();
  });
});

describe("quoteUrl", () => {
  it("builds the keyless Yahoo chart endpoint", () => {
    expect(quoteUrl("AAPL")).toBe("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d");
  });
  it("url-encodes a caret index symbol", () => {
    expect(quoteUrl("^GSPC")).toBe("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d");
  });
});

describe("parseQuote", () => {
  it("pulls price, currency, change%, and an as-of timestamp", () => {
    const q = parseQuote(yahoo());
    expect(q?.symbol).toBe("AAPL");
    expect(q?.price).toBe(195.89);
    expect(q?.currency).toBe("USD");
    expect(q?.changePct).toBeCloseTo(0.42, 1);
    expect(q?.asOf).toBe("2024-06-01 20:00");
    expect(q?.exchange).toBe("NasdaqGS");
  });
  it("omits change% when there's no previous close", () => {
    const q = parseQuote(yahoo({ chartPreviousClose: undefined }));
    expect(q?.changePct).toBeUndefined();
  });
  it("returns null for an unknown symbol (Yahoo error body)", () => {
    expect(parseQuote(yahooError)).toBeNull();
  });
  it("returns null on malformed / empty / non-JSON", () => {
    expect(parseQuote("")).toBeNull();
    expect(parseQuote("not json")).toBeNull();
    expect(parseQuote(JSON.stringify({ chart: { result: [{ meta: {} }] } }))).toBeNull(); // no price
  });
});

describe("formatQuote", () => {
  it("uses a $ + ▲ up-arrow for a US gainer with an as-of time", () => {
    expect(formatQuote({ symbol: "AAPL", price: 195.89, currency: "USD", changePct: 0.42, asOf: "2024-06-01 20:00" }))
      .toBe("AAPL: $195.89 (▲+0.42%, as of 2024-06-01 20:00 UTC)");
  });
  it("uses a ▼ down-arrow for a loser", () => {
    expect(formatQuote({ symbol: "TSLA", price: 170.00, currency: "USD", changePct: -1.25 }))
      .toBe("TSLA: $170.00 (▼-1.25%)");
  });
  it("shows an unknown currency as a code suffix (no symbol)", () => {
    expect(formatQuote({ symbol: "VOD.L", price: 72.5, currency: "GBp" })).toBe("VOD.L: 72.50 GBp");
  });
});

describe("getQuote", () => {
  it("fetches + parses a live-ish quote", async () => {
    let hitUrl = "";
    const q = await getQuote("aapl", async (u) => { hitUrl = u; return yahoo(); });
    expect(hitUrl).toBe(quoteUrl("AAPL"));
    expect(q?.price).toBe(195.89);
    expect(q?.symbol).toBe("AAPL");
  });
  it("returns null for a bad symbol without fetching", async () => {
    let fetched = false;
    const q = await getQuote("not a ticker", async () => { fetched = true; return ""; });
    expect(q).toBeNull();
    expect(fetched).toBe(false);
  });
  it("returns null on a fetch throw", async () => {
    const q = await getQuote("AAPL", async () => { throw new Error("network down"); });
    expect(q).toBeNull();
  });
});
