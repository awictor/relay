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

  it("fires onShutdown once, before exit (final metrics flush — DEV-0041)", () => {
    const order: string[] = [];
    let shutdownCalls = 0;
    const shutdown = createShutdown({
      stopPolling: () => order.push("stop"),
      onShutdown: () => { shutdownCalls++; order.push("flush"); },
      log: () => {},
      exit: () => order.push("exit"),
    });
    shutdown("SIGTERM");
    shutdown("SIGINT"); // idempotent — must not flush twice
    expect(shutdownCalls).toBe(1);
    expect(order).toEqual(["stop", "flush", "exit"]); // flush after stop, before exit
  });

  it("an onShutdown throw is swallowed and exit still runs", () => {
    const calls = { exit: [] as number[], logs: [] as string[] };
    const shutdown = createShutdown({
      stopPolling: () => {},
      onShutdown: () => { throw new Error("flush boom"); },
      log: (m) => calls.logs.push(m),
      exit: (c) => calls.exit.push(c),
    });
    shutdown("SIGTERM");
    expect(calls.exit).toEqual([0]);
    expect(calls.logs.some((l) => /onShutdown error/.test(l))).toBe(true);
  });
});
