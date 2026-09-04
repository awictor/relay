import { describe, it, expect } from "vitest";
import { parseChartRequest, chartUrl, renderChart } from "../src/lib/chart.js";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const series = (n: number) => Array.from({ length: n }, (_, i) => ({ t: NOW - (n - 1 - i) * DAY, v: 100 + i }));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]); // valid PNG signature + pad

describe("parseChartRequest", () => {
  it("parses chart/graph/plot asks into a watch name", () => {
    expect(parseChartRequest("chart btc", NOW)).toEqual({ name: "btc" });
    expect(parseChartRequest("graph my btc watch", NOW)).toEqual({ name: "btc" });
    expect(parseChartRequest("plot eth", NOW)).toEqual({ name: "eth" });
    expect(parseChartRequest("show me a chart of gold", NOW)).toEqual({ name: "gold" });
  });
  it("captures a lookback window", () => {
    const r = parseChartRequest("chart btc this week", NOW)!;
    expect(r.name).toBe("btc");
    expect(r.sinceMs).toBe(NOW - 7 * DAY);
  });
  it("parses the noun-first ordering 'btc chart' / 'my weight graph' (chart-noun-first)", () => {
    expect(parseChartRequest("btc chart", NOW)).toEqual({ name: "btc" });
    expect(parseChartRequest("my weight graph", NOW)).toEqual({ name: "weight" });
    // noun-first still captures a trailing window
    expect(parseChartRequest("eth chart this week", NOW)).toEqual({ name: "eth", sinceMs: NOW - 7 * DAY });
  });
  it("does NOT match a bare text-trend ask (no chart word) so watchTrend still handles it", () => {
    expect(parseChartRequest("how has btc moved this week", NOW)).toBeNull();
    expect(parseChartRequest("btc trend", NOW)).toBeNull();
    expect(parseChartRequest("what's the weather", NOW)).toBeNull();
  });
});

describe("chartUrl", () => {
  it("builds a quickchart.io URL from >=2 points, embedding the name + values", () => {
    const u = chartUrl("btc", series(3))!;
    expect(u.startsWith("https://quickchart.io/chart?")).toBe(true);
    const cfg = JSON.parse(decodeURIComponent(u.split("c=")[1]!));
    expect(cfg.type).toBe("line");
    expect(cfg.data.datasets[0].label).toBe("btc");
    expect(cfg.data.datasets[0].data).toEqual([100, 101, 102]);
    expect(cfg.data.labels).toHaveLength(3);
  });
  it("returns null with fewer than 2 points (nothing to plot)", () => {
    expect(chartUrl("btc", series(1))).toBeNull();
    expect(chartUrl("btc", [])).toBeNull();
  });
  it("filters to the lookback window", () => {
    const pts = series(10); // 10 daily points
    const u = chartUrl("btc", pts, NOW - 3 * DAY)!;
    const cfg = JSON.parse(decodeURIComponent(u.split("c=")[1]!));
    expect(cfg.data.datasets[0].data.length).toBeLessThanOrEqual(4); // only the last ~3-4 days
  });
});

describe("renderChart", () => {
  it("fetches the URL + returns PNG bytes when the render is a valid PNG", async () => {
    let seen = "";
    const png = await renderChart("btc", series(3), async (u) => { seen = u; return PNG; });
    expect(seen).toContain("quickchart.io");
    expect(png).toBe(PNG);
  });
  it("returns null when the response isn't a PNG (an error page)", async () => {
    const notPng = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]); // "<html"
    expect(await renderChart("btc", series(3), async () => notPng)).toBeNull();
  });
  it("returns null with <2 points (no fetch) and on a fetch throw", async () => {
    let fetched = false;
    expect(await renderChart("btc", series(1), async () => { fetched = true; return PNG; })).toBeNull();
    expect(fetched).toBe(false);
    expect(await renderChart("btc", series(3), async () => { throw new Error("net"); })).toBeNull();
  });
});
