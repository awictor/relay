import { describe, it, expect } from "vitest";
import { createShutdown } from "../src/shutdown.js";

function harness() {
  const calls = { stop: 0, exit: [] as number[], logs: [] as string[] };
  const shutdown = createShutdown({
    stopPolling: () => { calls.stop++; },
    log: (m) => calls.logs.push(m),
    exit: (c) => calls.exit.push(c),
  });
  return { shutdown, calls };
}

describe("createShutdown", () => {
  it("stops polling and exits 0 on a signal", () => {
    const { shutdown, calls } = harness();
    shutdown("SIGTERM");
    expect(calls.stop).toBe(1);
    expect(calls.exit).toEqual([0]);
    expect(calls.logs[0]).toMatch(/SIGTERM/);
  });

  it("is idempotent — a second signal during shutdown is ignored", () => {
    const { shutdown, calls } = harness();
    shutdown("SIGINT");
    shutdown("SIGTERM");
    expect(calls.stop).toBe(1);
    expect(calls.exit).toEqual([0]);
  });

  it("still exits 0 if stopPolling throws (shutdown must not hang)", () => {
    const calls = { exit: [] as number[], logs: [] as string[] };
    const shutdown = createShutdown({
      stopPolling: () => { throw new Error("boom"); },
      log: (m) => calls.logs.push(m),
      exit: (c) => calls.exit.push(c),
    });
    shutdown("SIGTERM");
    expect(calls.exit).toEqual([0]);
    expect(calls.logs.some((l) => /stopPolling error/.test(l))).toBe(true);
  });
});
