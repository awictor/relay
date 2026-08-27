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

  // DEV-0179: a not-ok turn splits into two classes — a DEGRADED turn (answered but partial) and a
  // HARD failure (threw). They must be counted in SEPARATE buckets so an operator can tell "partial
  // answers" from "crashes", and turns must equal ok + fail + degraded.
  it("counts degraded turns separately from hard failures", () => {
    const m = new Metrics();
    m.record({ steps: 3, tools: ["scrape"], elapsedMs: 100, ok: true });                    // ok
    m.record({ steps: 8, tools: ["scrape"], elapsedMs: 200, ok: false, degraded: true });   // soft (partial)
    m.record({ steps: 0, tools: [], elapsedMs: 50, ok: false });                             // hard (threw)
    const s = m.summary();
    expect(s.turns).toBe(3);
    expect(s.ok).toBe(1);
    expect(s.degraded).toBe(1);          // the degraded turn lands here, NOT in fail
    expect(s.fail).toBe(1);              // only the thrown turn
    expect(s.ok + s.fail + s.degraded).toBe(s.turns);
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
    expect(s).toMatchObject({ turns: 0, ok: 0, fail: 0, degraded: 0, avgSteps: 0, p50Ms: 0, p95Ms: 0, tools: {} });
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

  // HARDEN: the latency ring buffer (LATENCY_WINDOW=500) drops the oldest sample once full via a
  // rotating index `li`. Nothing exercised the wraparound — a broken index could keep stale samples
  // or double-count. Record 500 slow then 500 fast: the window must now hold ONLY the fast samples,
  // so p50/p95 reflect the fast batch, not a blend with the evicted slow ones.
  it("latency percentiles reflect only the last LATENCY_WINDOW (500) samples", () => {
    const m = new Metrics();
    for (let i = 0; i < 500; i++) m.record({ steps: 1, tools: [], elapsedMs: 1000, ok: true });
    // Window is now full of 1000ms samples.
    expect(m.summary().p50Ms).toBe(1000);
    // Overwrite the entire window with 10ms samples.
    for (let i = 0; i < 500; i++) m.record({ steps: 1, tools: [], elapsedMs: 10, ok: true });
    const s = m.summary();
    expect(s.p50Ms).toBe(10); // every slow sample evicted — no blend
    expect(s.p95Ms).toBe(10);
    // turns keeps counting past the window (it's the ring buffer that's bounded, not the totals).
    expect(s.turns).toBe(1000);
  });

  // DEV-0107: command usage is a separate axis from turns (commands short-circuit before the agent).
  it("recordCommand tallies a commands histogram without touching turns/ok/fail", () => {
    const m = new Metrics();
    m.recordCommand("/status");
    m.recordCommand("/status");
    m.recordCommand("/recipes");
    m.recordCommand(""); // ignored — no empty-name bucket
    // A real agent turn alongside commands: turns count that, not the commands.
    m.record({ steps: 1, tools: ["scrape"], elapsedMs: 20, ok: true });
    const s = m.summary();
    expect(s.commands).toEqual({ "/status": 2, "/recipes": 1 }); // sorted desc, no "" key
    expect(s.turns).toBe(1);
    expect(s.ok).toBe(1);
    expect(s.tools).toEqual({ scrape: 1 });
  });

  it("commands histogram is empty-safe and included in summary + format", () => {
    const m = new Metrics();
    expect(m.summary().commands).toEqual({});
    expect(JSON.parse(m.format().slice(10)).commands).toEqual({});
  });

  // HARDEN: a partial overwrite must evict proportionally — record 500 slow, then 250 fast, so the
  // window is half fast / half slow and p50 lands at the boundary (fast), p95 stays slow.
  it("partial ring overwrite evicts the oldest half", () => {
    const m = new Metrics();
    for (let i = 0; i < 500; i++) m.record({ steps: 1, tools: [], elapsedMs: 1000, ok: true });
    for (let i = 0; i < 250; i++) m.record({ steps: 1, tools: [], elapsedMs: 10, ok: true });
    const s = m.summary();
    // 250 fast (10ms) + 250 remaining slow (1000ms) in the 500-window: nearest-rank p50 = 10.
    expect(s.p50Ms).toBe(10);
    expect(s.p95Ms).toBe(1000);
  });
});
