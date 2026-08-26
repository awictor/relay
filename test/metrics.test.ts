import { describe, it, expect } from "vitest";
import { Metrics } from "../src/lib/metrics.js";

describe("Metrics", () => {
  it("counts turns, ok/fail, avg steps, and tool histogram", () => {
    const m = new Metrics();
    m.record({ steps: 2, tools: ["scrape"], elapsedMs: 100, ok: true });
    m.record({ steps: 4, tools: ["scrape", "extract"], elapsedMs: 300, ok: true });
    m.record({ steps: 0, tools: [], elapsedMs: 50, ok: false });
    const s = m.summary();
    expect(s.turns).toBe(3);
    expect(s.ok).toBe(2);
    expect(s.fail).toBe(1);
    expect(s.avgSteps).toBe(2); // (2+4+0)/3 = 2
    expect(s.tools).toEqual({ scrape: 2, extract: 1 });
  });

  it("computes latency percentiles (nearest-rank)", () => {
    const m = new Metrics();
    for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) m.record({ steps: 1, tools: [], elapsedMs: ms, ok: true });
    const s = m.summary();
    expect(s.p50Ms).toBe(50);
    expect(s.p95Ms).toBe(100);
  });

  it("is empty-safe", () => {
    const s = new Metrics().summary();
    expect(s).toMatchObject({ turns: 0, ok: 0, fail: 0, avgSteps: 0, p50Ms: 0, p95Ms: 0, tools: {} });
  });

  it("format() emits a [metrics] JSON line", () => {
    const m = new Metrics();
    m.record({ steps: 1, tools: ["fetch_json"], elapsedMs: 42, ok: true });
    const line = m.format();
    expect(line.startsWith("[metrics] ")).toBe(true);
    const obj = JSON.parse(line.slice(10));
    expect(obj.turns).toBe(1);
    expect(obj.tools).toEqual({ fetch_json: 1 });
  });

  it("clamps negative inputs", () => {
    const m = new Metrics();
    m.record({ steps: -5, tools: [], elapsedMs: -10, ok: true });
    const s = m.summary();
    expect(s.avgSteps).toBe(0);
    expect(s.p50Ms).toBe(0);
  });
});
