import { describe, it, expect } from "vitest";
import { normalizeCurrency, formatConversion, fxUrl, parseFxRate, parseFx, convertCurrency } from "../src/lib/fx.js";

describe("normalizeCurrency (fx-conversion-tool)", () => {
  it("maps codes, symbols, and words to ISO codes", () => {
    expect(normalizeCurrency("usd")).toBe("USD");
    expect(normalizeCurrency("EUR")).toBe("EUR");
    expect(normalizeCurrency("$")).toBe("USD");
    expect(normalizeCurrency("£")).toBe("GBP");
    expect(normalizeCurrency("euros")).toBe("EUR");
  });
  it("null for junk", () => {
    expect(normalizeCurrency("dollarsss")).toBeNull();
    expect(normalizeCurrency("")).toBeNull();
    expect(normalizeCurrency("US")).toBeNull();
  });
});

describe("parseFxRate", () => {
  it("pulls the target rate from an open.er-api success body", () => {
    const body = JSON.stringify({ result: "success", rates: { EUR: 0.923, GBP: 0.79 } });
    expect(parseFxRate(body, "EUR")).toBe(0.923);
  });
  it("null on failure result / missing rate / bad json", () => {
    expect(parseFxRate(JSON.stringify({ result: "error" }), "EUR")).toBeNull();
    expect(parseFxRate(JSON.stringify({ result: "success", rates: {} }), "EUR")).toBeNull();
    expect(parseFxRate("not json", "EUR")).toBeNull();
  });
});

describe("parseFx (fx-live-claim-timestamp)", () => {
  it("returns rate + a YYYY-MM-DD asOf from time_last_update_utc", () => {
    const body = JSON.stringify({ result: "success", rates: { EUR: 0.923 }, time_last_update_utc: "Sat, 01 Jun 2024 00:00:01 +0000" });
    expect(parseFx(body, "EUR")).toEqual({ rate: 0.923, asOf: "2024-06-01" });
  });
  it("rate with no date -> asOf undefined; bad -> null", () => {
    expect(parseFx(JSON.stringify({ result: "success", rates: { EUR: 0.9 } }), "EUR")).toEqual({ rate: 0.9, asOf: undefined });
    expect(parseFx(JSON.stringify({ result: "error" }), "EUR")).toBeNull();
  });
});

describe("formatConversion", () => {
  it("renders a short human line (no date when absent)", () => {
    expect(formatConversion({ amount: 200, from: "USD", to: "EUR", rate: 0.923, result: 184.6 }))
      .toBe("200 USD = 184.60 EUR (rate 0.9230)");
  });
  it("includes the as-of date when present (not claiming 'live')", () => {
    expect(formatConversion({ amount: 200, from: "USD", to: "EUR", rate: 0.923, result: 184.6, asOf: "2024-06-01" }))
      .toBe("200 USD = 184.60 EUR (rate 0.9230, as of 2024-06-01)");
  });
  it("renders a tiny inverse rate at adaptive precision, not 0.0000", () => {
    const line = formatConversion({ amount: 1000, from: "IDR", to: "USD", rate: 0.0000238, result: 0.0238 });
    expect(line).toMatch(/rate 0\.0000238/); // ~4 sig figs, not "0.0000"
  });
});

describe("convertCurrency", () => {
  const fakeFetch = (rate: number) => async (url: string) => {
    expect(url).toBe(fxUrl("USD"));
    return JSON.stringify({ result: "success", rates: { EUR: rate } });
  };
  it("converts via the injected fetch", async () => {
    const c = await convertCurrency(200, "usd", "€", fakeFetch(0.923));
    expect(c).toEqual({ amount: 200, from: "USD", to: "EUR", rate: 0.923, result: 200 * 0.923 });
  });
  it("defaults amount to 1 + short-circuits same currency (no fetch)", async () => {
    const c = await convertCurrency(NaN, "USD", "USD", async () => { throw new Error("should not fetch"); });
    expect(c).toEqual({ amount: 1, from: "USD", to: "USD", rate: 1, result: 1 });
  });
  it("null on bad code / fetch failure", async () => {
    expect(await convertCurrency(1, "xxx", "EUR", async () => "")).toBeNull();
    expect(await convertCurrency(1, "USD", "EUR", async () => { throw new Error("net"); })).toBeNull();
  });
});
