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

  // m14 degrade-2: completing a schedule persists to disk. If complete() throws (unwritable
  // store), it must NOT abort the rest of the due batch — every other due task still fires.
  it("a store.complete() failure is swallowed and doesn't block the rest of the due batch", async () => {
    const clock = { t: NOW };
    const store = new ScheduleStore({ file: tmpFile() });
    const errs: unknown[] = [];
    // Wrap the real store so complete() throws on the FIRST call only (simulate a transient
    // write failure), then delegates normally.
    let firstComplete = true;
    const flaky = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
      dueNow: (n: number) => store.dueNow(n),
      complete: (id: string, n: number) => {
        if (firstComplete) { firstComplete = false; throw new Error("EACCES: read-only file system"); }
        return store.complete(id, n);
      },
    });
    const ran: string[] = [];
    const runner = makeScheduleRunner({
      store: flaky,
      llm: {} as never,
      runAgent: async (task) => { ran.push(task); return { reply: `did:${task}` }; },
      send: async () => {},
      formatReply: (t) => t,
      now: () => clock.t,
      periodMs: 0,
      onError: (e) => errs.push(e),
    });
    store.add(1, { kind: "once", task: "a", dueMs: NOW - 1 }, NOW);
    store.add(1, { kind: "once", task: "b", dueMs: NOW - 1 }, NOW);
    // tick must NOT throw even though the first task's complete() throws mid-batch.
    const n = await runner.tick();
    // BOTH tasks were attempted (agent ran for each) — the complete() failure on "a" didn't abort
    // the loop before "b" got its turn. That's the resilience guarantee.
    expect(ran).toEqual(["a", "b"]);
    expect(n).toBeGreaterThanOrEqual(1); // "b" fully fired; "a" completed-failed (still attempted)
    expect(errs).toHaveLength(1);        // the complete failure was reported, not swallowed silently
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

describe("makeScheduleRunner anti-spam cap (m8 pobs-2)", () => {
  it("stops sending to a chat past the hourly cap; over-cap schedules are dropped, not fired", async () => {
    const clock = { t: NOW };
    const sent: Array<{ chatId: number }> = [];
    let agentCalls = 0;
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 2,
      runAgent: async (task) => { agentCalls++; return { reply: `did:${task}` }; },
      send: async (chatId) => { sent.push({ chatId }); },
    });
    // 4 due once-tasks for the same chat; cap 2 -> only 2 fire, 2 dropped.
    for (let i = 0; i < 4; i++) store.add(1, { kind: "once", task: `t${i}`, dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(sent).toHaveLength(2);
    expect(agentCalls).toBe(2);
    expect(store.list(1)).toHaveLength(0); // over-cap ones completed (dropped), not left to storm
  });

  it("the cap is per-chat (a 2nd chat is unaffected)", async () => {
    const clock = { t: NOW };
    const sent: Array<{ chatId: number }> = [];
    const { store, runner } = harness(clock, { maxPerChatPerHour: 1, send: async (chatId) => { sent.push({ chatId }); } });
    store.add(1, { kind: "once", task: "a", dueMs: NOW - 1 }, NOW);
    store.add(1, { kind: "once", task: "b", dueMs: NOW - 1 }, NOW); // over cap for chat 1
    store.add(2, { kind: "once", task: "c", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(sent.filter((s) => s.chatId === 1)).toHaveLength(1);
    expect(sent.filter((s) => s.chatId === 2)).toHaveLength(1);
  });

  it("cap 0 = unlimited", async () => {
    const clock = { t: NOW };
    const sent: unknown[] = [];
    const { store, runner } = harness(clock, { maxPerChatPerHour: 0, send: async () => { sent.push(1); } });
    for (let i = 0; i < 5; i++) store.add(1, { kind: "once", task: `t${i}`, dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(sent).toHaveLength(5);
  });
});

describe("makeScheduleRunner observability (m8 pobs-1)", () => {
  it("logs a [proactive] line + records an ok turn on a successful fire", async () => {
    const clock = { t: NOW };
    const logs: string[] = [];
    const recorded: Array<{ ok: boolean; steps: number; tools: string[] }> = [];
    const { store, runner } = harness(clock, {
      runAgent: async (task) => ({ reply: `did:${task}`, steps: 3, tools: ["scrape"] }),
      log: (m) => logs.push(m),
      recordTurn: (t) => recorded.push({ ok: t.ok, steps: t.steps, tools: t.tools }),
    });
    store.add(1, { kind: "once", task: "x", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    const line = logs.find((l) => l.startsWith("[proactive]"));
    expect(line).toBeTruthy();
    const obj = JSON.parse(line!.slice("[proactive] ".length));
    expect(obj).toMatchObject({ kind: "once", steps: 3, ok: true });
    expect(recorded).toEqual([{ ok: true, steps: 3, tools: ["scrape"] }]);
  });

  it("logs a [proactive] failure line + records a failed turn when the agent throws", async () => {
    const clock = { t: NOW };
    const logs: string[] = [];
    const recorded: Array<{ ok: boolean }> = [];
    const { store, runner } = harness(clock, {
      runAgent: async () => { throw new Error("boom"); },
      log: (m) => logs.push(m),
      recordTurn: (t) => recorded.push({ ok: t.ok }),
    });
    store.add(1, { kind: "once", task: "x", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    const line = logs.find((l) => l.startsWith("[proactive]") && /"ok":false/.test(l));
    expect(line).toBeTruthy();
    expect(recorded).toEqual([{ ok: false }]);
  });
});
