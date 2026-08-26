import { describe, it, expect } from "vitest";
import { formatUptime, formatStatus } from "../src/lib/status.js";

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
  it("reports up + tasks + browser connected", () => {
    const s = formatStatus({ uptimeMs: 3600_000, turns: 5, anvilOk: true });
    expect(s).toMatch(/up 1h 0m/);
    expect(s).toMatch(/5 tasks/);
    expect(s).toMatch(/browser connected/);
  });
  it("singular task + browser down", () => {
    const s = formatStatus({ uptimeMs: 30_000, turns: 1, anvilOk: false });
    expect(s).toMatch(/1 task\b/);
    expect(s).toMatch(/browser DOWN/);
  });
});
