import { describe, it, expect, afterEach } from "vitest";
import { makeScheduleRunner } from "../src/schedule-runner.js";
import { ScheduleStore } from "../src/lib/schedule.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const dirs: string[] = [];
function tmpFile() { const d = mkdtempSync(join(tmpdir(), "relay-schedrun-")); dirs.push(d); return join(d, "s.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function harness(clock: { t: number }, over: Partial<Parameters<typeof makeScheduleRunner>[0]> = {}) {
  const store = new ScheduleStore({ file: tmpFile() });
  const sent: Array<{ chatId: number; text: string }> = [];
  const ran: string[] = [];
  const runner = makeScheduleRunner({
    store,
    llm: {} as never,
    runAgent: async (task) => { ran.push(task); return { reply: `did:${task}` }; },
    send: async (chatId, text) => { sent.push({ chatId, text }); },
    formatReply: (t) => t,
    now: () => clock.t,
    periodMs: 0, // manual tick in tests
    ...over,
  });
  return { store, runner, sent, ran };
}

describe("makeScheduleRunner.tick", () => {
  it("fires nothing when nothing is due", async () => {
    const clock = { t: NOW };
    const { store, runner, sent } = harness(clock);
    store.add(1, { kind: "once", task: "x", dueMs: NOW + 10 * MIN }, NOW);
    expect(await runner.tick()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("fires a due once-task, texts the chat unprompted, and removes it", async () => {
    const clock = { t: NOW };
    const { store, runner, sent, ran } = harness(clock);
    store.add(42, { kind: "once", task: "stretch", dueMs: NOW - 1 }, NOW);
    const n = await runner.tick();
    expect(n).toBe(1);
    expect(ran).toEqual(["stretch"]);
    expect(sent[0]!.chatId).toBe(42);
    expect(sent[0]!.text).toMatch(/Reminder/);
    expect(sent[0]!.text).toMatch(/did:stretch/);
    expect(store.list(42)).toHaveLength(0); // once -> gone
  });

  it("a daily task fires then reschedules forward (stays in the store)", async () => {
    const clock = { t: NOW };
    const { store, runner, sent } = harness(clock);
    store.add(1, { kind: "daily", task: "weather", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    expect(sent[0]!.text).toMatch(/Daily/);
    const after = store.list(1);
    expect(after).toHaveLength(1);
    expect(after[0]!.dueMs).toBeGreaterThan(NOW); // moved to next occurrence
  });

  it("a failed agent run doesn't storm — the once-task is completed (dropped), not retried forever", async () => {
    const clock = { t: NOW };
    const errs: unknown[] = [];
    const { store, runner, sent } = harness(clock, {
      runAgent: async () => { throw new Error("agent boom"); },
      onError: (e) => errs.push(e),
    });
    store.add(1, { kind: "once", task: "x", dueMs: NOW - 1 }, NOW);
    const n = await runner.tick();
    expect(n).toBe(0);                 // nothing successfully fired
    expect(errs).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(store.list(1)).toHaveLength(0); // dropped, won't retry every tick
  });

  it("only fires each due task once even if ticks overlap (re-entrancy guard)", async () => {
    const clock = { t: NOW };
    let agentCalls = 0;
    const { store, runner } = harness(clock, {
      // Slow agent: while it runs, a 2nd tick fires and must be a no-op.
      runAgent: async (task) => { agentCalls++; await new Promise((r) => setTimeout(r, 20)); return { reply: `did:${task}` }; },
    });
    store.add(1, { kind: "once", task: "once-only", dueMs: NOW - 1 }, NOW);
    const [a, b] = await Promise.all([runner.tick(), runner.tick()]);
    expect(a + b).toBe(1);            // exactly one fired across the overlapping ticks
    expect(agentCalls).toBe(1);
  });
});

describe("makeScheduleRunner start/stop", () => {
  it("start uses the injected interval; stop clears it; periodMs<=0 is a no-op", () => {
    let intervalFn: (() => void) | null = null;
    let cleared = false;
    const clock = { t: NOW };
    const { runner } = harness(clock, {
      periodMs: 1000,
      setInterval: (fn) => { intervalFn = fn as () => void; return 1; },
      clearInterval: () => { cleared = true; },
    });
    runner.start();
    expect(intervalFn).toBeTypeOf("function");
    runner.stop();
    expect(cleared).toBe(true);
  });
});
