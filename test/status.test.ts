import { describe, it, expect } from "vitest";
import { formatUptime, formatStatus, makeAnvilPinger } from "../src/lib/status.js";

// DEV-0024: /status health line — pure formatters, no live bot.
describe("formatUptime", () => {
  it("seconds under a minute", () => {
    expect(formatUptime(45_000)).toBe("45s");
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(-5)).toBe("0s"); // clamped
  });
  it("minutes+seconds under an hour", () => {
    expect(formatUptime(12 * 60_000 + 30_000)).toBe("12m 30s");
  });
  it("hours+minutes under a day", () => {
    expect(formatUptime((4 * 3600 + 12 * 60) * 1000)).toBe("4h 12m");
  });
  it("days+hours past a day", () => {
    expect(formatUptime((3 * 86400 + 4 * 3600) * 1000)).toBe("3d 4h");
  });
});

describe("formatStatus", () => {
  it("reports up + tasks + browser connected with a ✅ prefix", () => {
    const s = formatStatus({ uptimeMs: 3600_000, turns: 5, anvilOk: true });
    expect(s).toMatch(/up 1h 0m/);
    expect(s).toMatch(/5 tasks/);
    expect(s).toMatch(/browser connected/);
    expect(s.startsWith("✅")).toBe(true);
  });
  it("singular task + browser down uses a ⚠️ prefix (emoji must not contradict the body)", () => {
    const s = formatStatus({ uptimeMs: 30_000, turns: 1, anvilOk: false });
    expect(s).toMatch(/1 task\b/);
    expect(s).toMatch(/browser DOWN/);
    expect(s.startsWith("⚠")).toBe(true);
    expect(s.startsWith("✅")).toBe(false);
  });
  // DEV-0109: surface the busiest command when present, omit the fragment when not.
  it("renders a top-command fragment when topCommand is set", () => {
    const s = formatStatus({ uptimeMs: 1000, turns: 2, anvilOk: true, topCommand: { name: "/status", count: 3 } });
    expect(s).toMatch(/top cmd \/status x3/);
  });
  it("omits the top-command fragment when no command has been used", () => {
    const s = formatStatus({ uptimeMs: 1000, turns: 2, anvilOk: true });
    expect(s).not.toMatch(/top cmd/);
  });
  // DEV-0180: surface the health breakdown (hard fails + partial/degraded) only when non-zero.
  it("appends a health clause naming failed + partial counts when either is > 0", () => {
    const s = formatStatus({ uptimeMs: 1000, turns: 10, anvilOk: true, fail: 2, degraded: 3 });
    expect(s).toMatch(/2 failed/);
    expect(s).toMatch(/3 partial/);
  });
  it("names only the non-zero class (partial-only, no failures)", () => {
    const s = formatStatus({ uptimeMs: 1000, turns: 10, anvilOk: true, fail: 0, degraded: 1 });
    expect(s).toMatch(/1 partial/);
    expect(s).not.toMatch(/failed/);
  });
  it("omits the health clause entirely on a healthy bot (fail=0, degraded=0 or absent)", () => {
    expect(formatStatus({ uptimeMs: 1000, turns: 10, anvilOk: true, fail: 0, degraded: 0 })).not.toMatch(/failed|partial/);
    expect(formatStatus({ uptimeMs: 1000, turns: 10, anvilOk: true })).not.toMatch(/failed|partial/);
  });
});

describe("makeAnvilPinger (DEV-0025 live reachability refresh)", () => {
  it("tick() updates the cached flag from the probe", async () => {
    let val = false;
    const p = makeAnvilPinger({ probe: async () => val, periodMs: 0, initial: false });
    expect(p.current()).toBe(false);
    val = true;
    await p.tick();
    expect(p.current()).toBe(true);
    val = false;
    await p.tick();
    expect(p.current()).toBe(false);
  });

  it("a probe rejection keeps the last-known value (never throws)", async () => {
    const p = makeAnvilPinger({ probe: async () => { throw new Error("net"); }, periodMs: 0, initial: true, onError: () => {} });
    await p.tick(); // must not throw
    expect(p.current()).toBe(true); // unchanged
  });

  it("start() with periodMs<=0 registers no interval; start()/stop() are idempotent", () => {
    let started = 0, cleared = 0;
    const p = makeAnvilPinger({
      probe: async () => true, periodMs: 0, initial: false,
      setInterval: () => { started++; return 1; },
      clearInterval: () => { cleared++; },
    });
    p.start(); p.start();
    expect(started).toBe(0); // disabled
    p.stop();                // safe even though never started
    expect(cleared).toBe(0);
  });

  it("start() registers exactly one interval; stop() clears it; the interval body probes", async () => {
    let started = 0, cleared = 0;
    let fn: (() => void) | null = null;
    let val = false;
    const p = makeAnvilPinger({
      probe: async () => val, periodMs: 1000, initial: false,
      setInterval: (f) => { started++; fn = f as () => void; return 42; },
      clearInterval: (h) => { cleared++; expect(h).toBe(42); },
    });
    p.start(); p.start();          // second is a no-op
    expect(started).toBe(1);
    // fire the interval body: it probes + updates the cache
    val = true;
    fn!();
    await Promise.resolve(); await Promise.resolve();
    expect(p.current()).toBe(true);
    p.stop();
    expect(cleared).toBe(1);
  });
});
