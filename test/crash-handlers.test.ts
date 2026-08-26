import { describe, it, expect, afterEach } from "vitest";
import { installCrashHandlers } from "../src/shutdown.js";

// DEV-0067: installCrashHandlers registers REAL process listeners. Snapshot the pre-existing
// listeners and remove any we added in afterEach, so these tests don't leak handlers into the rest
// of the suite (a stray unhandledRejection listener would swallow real test failures).
const EVENTS = ["uncaughtException", "unhandledRejection"] as const;
const before: Record<string, Function[]> = {};
for (const e of EVENTS) before[e] = [...process.listeners(e)];

afterEach(() => {
  for (const e of EVENTS) {
    for (const l of process.listeners(e)) {
      if (!before[e].includes(l)) process.removeListener(e, l as (...a: unknown[]) => void);
    }
  }
});

function harness() {
  const calls = { logs: [] as string[], fatal: 0, exit: [] as number[] };
  installCrashHandlers({
    log: (m) => calls.logs.push(m),
    onFatal: () => { calls.fatal++; },
    exit: (c) => calls.exit.push(c), // injected so the test process is NOT killed
  });
  return calls;
}

describe("installCrashHandlers", () => {
  it("registers a listener on both fatal events", () => {
    const b = EVENTS.map((e) => process.listenerCount(e));
    harness();
    EVENTS.forEach((e, i) => expect(process.listenerCount(e)).toBe(b[i] + 1));
  });

  it("on uncaughtException: logs the error, runs onFatal, exits 1", () => {
    const calls = harness();
    process.emit("uncaughtException", new Error("boom"));
    expect(calls.logs.some((m) => /\[fatal\] uncaughtException/.test(m) && /boom/.test(m))).toBe(true);
    expect(calls.fatal).toBe(1);
    expect(calls.exit).toEqual([1]);
  });

  it("on unhandledRejection: logs, runs onFatal, exits 1", () => {
    const calls = harness();
    // node passes the rejection reason (not necessarily an Error) as the first arg
    (process as NodeJS.EventEmitter).emit("unhandledRejection", "async-nope");
    expect(calls.logs.some((m) => /\[fatal\] unhandledRejection/.test(m) && /async-nope/.test(m))).toBe(true);
    expect(calls.fatal).toBe(1);
    expect(calls.exit).toEqual([1]);
  });

  it("is re-entrancy guarded: a second fatal on the same instance does not run onFatal/exit twice", () => {
    const calls = harness();
    process.emit("uncaughtException", new Error("first"));
    process.emit("uncaughtException", new Error("second"));
    expect(calls.fatal).toBe(1);
    expect(calls.exit).toEqual([1]); // exactly one exit, not [1,1]
  });

  it("a throw inside onFatal is swallowed (still exits 1)", () => {
    const calls = { logs: [] as string[], exit: [] as number[] };
    installCrashHandlers({
      log: (m) => calls.logs.push(m),
      onFatal: () => { throw new Error("flush failed"); },
      exit: (c) => calls.exit.push(c),
    });
    process.emit("uncaughtException", new Error("boom"));
    expect(calls.exit).toEqual([1]);
    expect(calls.logs.some((m) => /onFatal error/.test(m))).toBe(true);
  });
});
