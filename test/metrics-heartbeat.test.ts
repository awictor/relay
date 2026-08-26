import { describe, it, expect, vi } from "vitest";
import { makeMetricsHeartbeat } from "../src/lib/metrics-heartbeat.js";

// DEV-0111: wall-clock metrics heartbeat. Injectable setInterval/clearInterval so we drive it with a
// captured callback — no real timers.

function fakeTimer() {
  let fn: (() => void) | null = null;
  const setInterval = (f: () => void, _ms: number) => { fn = f; return 1 as unknown; };
  const clearInterval = (_h: unknown) => { fn = null; };
  return { setInterval, clearInterval, fire: () => fn?.(), get armed() { return fn !== null; } };
}

describe("makeMetricsHeartbeat (DEV-0111)", () => {
  it("emits + snapshots on each interval fire", () => {
    const t = fakeTimer();
    let emits = 0, snaps = 0;
    const hb = makeMetricsHeartbeat({
      emit: () => emits++, snapshot: () => snaps++, periodMs: 60000,
      setInterval: t.setInterval, clearInterval: t.clearInterval,
    });
    hb.start();
    expect(t.armed).toBe(true);
    t.fire(); t.fire(); t.fire();
    expect(emits).toBe(3);
    expect(snaps).toBe(3);
  });

  it("stop() clears the interval (no further fires)", () => {
    const t = fakeTimer();
    let emits = 0;
    const hb = makeMetricsHeartbeat({ emit: () => emits++, periodMs: 60000, setInterval: t.setInterval, clearInterval: t.clearInterval });
    hb.start();
    t.fire();
    hb.stop();
    expect(t.armed).toBe(false);
    expect(emits).toBe(1);
  });

  it("periodMs <= 0 disables the interval (never arms)", () => {
    const t = fakeTimer();
    const hb = makeMetricsHeartbeat({ emit: () => {}, periodMs: 0, setInterval: t.setInterval, clearInterval: t.clearInterval });
    hb.start();
    expect(t.armed).toBe(false);
  });

  it("start() is idempotent — a second call doesn't stack a second timer", () => {
    const spy = vi.fn((_f: () => void, _ms: number) => 1 as unknown);
    const hb = makeMetricsHeartbeat({ emit: () => {}, periodMs: 1000, setInterval: spy, clearInterval: () => {} });
    hb.start();
    hb.start();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a throwing emit routes to onError and does NOT stop the beat", () => {
    const t = fakeTimer();
    const errs: unknown[] = [];
    let snaps = 0;
    const hb = makeMetricsHeartbeat({
      emit: () => { throw new Error("log pipe broke"); },
      snapshot: () => snaps++,
      periodMs: 1000, onError: (e) => errs.push(e),
      setInterval: t.setInterval, clearInterval: t.clearInterval,
    });
    hb.start();
    t.fire(); t.fire();
    expect(errs.length).toBe(2);      // both emit throws captured
    expect(snaps).toBe(2);            // snapshot still ran despite emit throwing
    expect(t.armed).toBe(true);       // beat survives
  });
});
