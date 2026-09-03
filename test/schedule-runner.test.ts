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

  it("a reminderOnly schedule echoes the note and does NOT run the agent (reminder-only-no-agent)", async () => {
    const clock = { t: NOW };
    const { store, runner, sent, ran } = harness(clock);
    store.add(7, { kind: "once", task: "take my meds", dueMs: NOW - 1, reminderOnly: true }, NOW);
    const n = await runner.tick();
    expect(n).toBe(1);
    expect(ran).toEqual([]);                       // agent never invoked — no confused browse/refusal
    expect(sent[0]!.text).toBe("⏰ Reminder: take my meds");
    expect(store.list(7)).toHaveLength(0);         // once -> gone
  });

  it("threads the chat's clock + units into the proactive runAgent (proactive-runs-datetime-units-blind)", async () => {
    const clock = { t: NOW };
    let seenDeps: { nowMs?: number; tzOffsetMin?: number; weatherUnits?: string } | null = null;
    const { store, runner } = harness(clock, {
      runAgent: async (_task: string, d: { nowMs?: number; tzOffsetMin?: number; weatherUnits?: string }) => { seenDeps = d; return { reply: "ok" }; },
      agentEnv: (_c: number) => ({ nowMs: NOW, tzOffsetMin: -300, weatherUnits: "metric" as const }),
    });
    store.add(1, { kind: "once", task: "top news today", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(seenDeps!.nowMs).toBe(NOW);        // the agent knows the real date, not its training cutoff
    expect(seenDeps!.tzOffsetMin).toBe(-300); // in the user's zone
    expect(seenDeps!.weatherUnits).toBe("metric"); // + the user's units
  });

  it("a paused schedule is skipped without firing or completing (snooze-automations)", async () => {
    const clock = { t: NOW };
    const { store, runner, sent, ran } = harness(clock);
    store.add(3, { kind: "daily", task: "weather", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    store.pause(3, "weather", NOW + 3 * 86_400_000); // paused 3 days out
    const n = await runner.tick();
    expect(n).toBe(0);
    expect(ran).toEqual([]);                       // agent never invoked while paused
    expect(sent).toHaveLength(0);
    expect(store.list(3)[0]!.dueMs).toBe(NOW - 1); // NOT advanced — resumes on its original schedule
  });

  it("an elapsed pause auto-resumes: the schedule fires + the stale flag clears (snooze-automations)", async () => {
    const clock = { t: NOW };
    const { store, runner, sent, ran } = harness(clock);
    store.add(3, { kind: "once", task: "stretch", dueMs: NOW - 1 }, NOW);
    store.pause(3, "stretch", NOW - 100); // pause already elapsed
    const n = await runner.tick();
    expect(n).toBe(1);
    expect(ran).toEqual(["stretch"]);              // fired once the pause window passed
    expect(sent).toHaveLength(1);
  });

  it("a 'recipe:<name>' schedule resolves the recipe's CURRENT task at fire time (recipe-schedule-stable-marker)", async () => {
    const clock = { t: NOW };
    const tasks: Record<string, string> = { btc: "check bitcoin price" };
    const { store, runner, sent, ran } = harness(clock, {
      recipeResolveTask: (_c, name) => tasks[name] ?? null,
    });
    store.add(1, { kind: "once", task: "recipe:btc", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(ran).toEqual(["check bitcoin price"]); // ran the resolved task, not the marker
    expect(sent[0]!.text).toMatch(/check bitcoin price/); // header shows the human task, not "recipe:btc"
    expect(sent[0]!.text).not.toMatch(/recipe:btc/);
  });

  it("a scheduled CHAINED recipe runs via runChain, not as one literal task (recipe-chaining)", async () => {
    const clock = { t: NOW };
    let chained = "";
    const { store, runner, sent, ran } = harness(clock, {
      recipeResolveTask: () => "step a >> step b",
      runChain: async (_c, task) => { chained = task; return "chained result"; },
    });
    store.add(1, { kind: "once", task: "recipe:flow", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(chained).toBe("step a >> step b"); // ran the chain
    expect(ran).toEqual([]);                    // NOT a single literal agent task
    expect(sent[0]!.text).toMatch(/chained result/);
  });

  it("a scheduled recipe edited to add a {slot} skips firing (no literal-slot garbage) (scheduled-recipe-slot-refire)", async () => {
    const clock = { t: NOW };
    const { store, runner, sent, ran } = harness(clock, {
      recipeResolveTask: () => "track price of {coin}", // recipe edited to add a slot after scheduling
    });
    store.add(1, { kind: "daily", task: "recipe:btc", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    expect(ran).toEqual([]);        // did NOT run the literal-slot task
    expect(sent).toHaveLength(0);   // nothing pushed
    expect(store.list(1)).toHaveLength(1); // daily stays (self-heals if the slot is removed)
  });

  it("a scheduled recipe deleted after scheduling stops firing (no send), completes", async () => {
    const clock = { t: NOW };
    const { store, runner, sent, ran } = harness(clock, {
      recipeResolveTask: () => null, // recipe gone
    });
    store.add(1, { kind: "once", task: "recipe:gone", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(ran).toEqual([]);          // never ran the agent
    expect(sent).toHaveLength(0);     // nothing sent
    expect(store.list(1)).toHaveLength(0); // once dropped
  });

  it("records the proactive send into the shared cache for a 'more'/'link' drilldown (proactive-ping-drilldown-cache)", async () => {
    const clock = { t: NOW };
    const store = new Map<number, { full: string; sent: number }>();
    const { store: sched, runner } = harness(clock, {
      runAgent: async () => ({ reply: "the news is X, see https://ex.com/a" }),
      recordSend: (chatId, text) => store.set(chatId, { full: text, sent: text.length }),
    });
    sched.add(1, { kind: "once", task: "news", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(store.get(1)!.full).toMatch(/the news is X/); // cached for a follow-up drilldown
  });

  it("defers a proactive send that lands in quiet hours to the window's end, no send (quiet-hours)", async () => {
    const clock = { t: NOW };
    const sent: unknown[] = [];
    const { store, runner } = harness(clock, {
      send: async () => { sent.push(1); },
      quietUntil: () => NOW + 8 * 3_600_000, // in quiet window -> defer 8h out
      deferTo: (id, when) => { store.deferTo(id, when); },
    });
    store.add(1, { kind: "once", task: "meds", dueMs: NOW - 1 }, NOW);
    const n = await runner.tick();
    expect(n).toBe(0);                               // nothing fired
    expect(sent).toHaveLength(0);                    // no 3am ping
    expect(store.list(1)[0]!.dueMs).toBe(NOW + 8 * 3_600_000); // pushed to window end
  });

  it("an alert CHECK runs during quiet hours (not deferred) so an overnight crossing isn't lost (quiet-hours-defers-alert-check)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    let alertChecks = 0;
    const { store, runner } = harness(clock, {
      send: async (_c, text) => { sent.push(text); },
      quietUntil: () => NOW + 8 * 3_600_000, // deep in the quiet window
      deferTo: (id, when) => { store.deferTo(id, when); },
      alertCheck: async () => { alertChecks++; return { message: "🔔 btc: below 50k", commit: () => {} }; },
    });
    store.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    expect(alertChecks).toBe(1); // the crossing was EVALUATED at 2am, not deferred to 8am (would revert)
    expect(sent).toContain("🔔 btc: below 50k"); // a real crossing is worth the ping; it can't storm (edge-only)
  });

  it("a non-alert proactive send is STILL deferred by quiet hours (regression guard)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const { store, runner } = harness(clock, {
      send: async (_c, text) => { sent.push(text); },
      quietUntil: () => NOW + 8 * 3_600_000,
      deferTo: (id, when) => { store.deferTo(id, when); },
    });
    store.add(1, { kind: "daily", task: "digest:morning", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    expect(sent).toHaveLength(0); // recurring content still waits for the quiet window to end
  });

  it("a daily task fires then reschedules forward (stays in the store)", async () => {
    const clock = { t: NOW };
    const { store, runner, sent } = harness(clock);
    store.add(1, { kind: "daily", task: "weather", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    expect(sent[0]!.text).toMatch(/Recurring/);
    const after = store.list(1);
    expect(after).toHaveLength(1);
    expect(after[0]!.dueMs).toBeGreaterThan(NOW); // moved to next occurrence
  });

  it("a failed once-reminder is DEFERRED (retried on later ticks), not dropped on the first failure (once-reminder-transient-retry)", async () => {
    const clock = { t: NOW };
    const errs: unknown[] = [];
    const { store, runner, sent } = harness(clock, {
      runAgent: async () => { throw new Error("agent boom"); },
      onError: (e) => errs.push(e),
    });
    store.add(1, { kind: "once", task: "x", dueMs: NOW - 1 }, NOW);
    const n = await runner.tick();
    expect(n).toBe(0);                     // nothing successfully fired
    expect(errs).toHaveLength(1);
    expect(sent).toHaveLength(0);          // no give-up notice yet (transient)
    expect(store.list(1)).toHaveLength(1); // STILL QUEUED — a transient hiccup didn't delete it
    expect(store.list(1)[0]!.attempts).toBe(1);
  });

  it("a once-reminder that keeps failing is given up (notified + dropped) after the attempt cap", async () => {
    const clock = { t: NOW };
    const { store, runner, sent } = harness(clock, {
      runAgent: async () => { throw new Error("still down"); },
      failureNotice: () => "⏰ I tried but the browser was down.",
    });
    store.add(1, { kind: "once", task: "meds", dueMs: NOW - 1 }, NOW);
    // Default cap is 5 attempts. Tick until it gives up.
    for (let i = 0; i < 4; i++) { await runner.tick(); expect(store.list(1)).toHaveLength(1); } // attempts 1..4: still deferred
    await runner.tick(); // attempt 5: give up
    expect(store.list(1)).toHaveLength(0);     // dropped after the cap
    expect(sent).toHaveLength(1);              // told the user, once, after exhausting retries
    expect(sent[0]!.text).toMatch(/tried/i);
  });

  it("a daily that fails still advances (not retried in place)", async () => {
    const clock = { t: NOW };
    const { store, runner } = harness(clock, { runAgent: async () => { throw new Error("boom"); } });
    store.add(1, { kind: "daily", task: "d", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    const d = store.list(1)[0]!;
    expect(d).toBeTruthy();
    expect(d.dueMs).toBeGreaterThan(NOW);      // advanced, not left due
    expect(d.attempts ?? 0).toBe(1);           // records a failure streak (failed-watch-receipts), still advances
  });

  // failed-watch-receipts: a recurring watch that fails N times in a row sends ONE receipt (a dead
  // watch otherwise reads as "no news"), then resets the streak so it re-notifies only after another N.
  it("a recurring watch failing FAIL_STREAK times in a row sends one receipt then resets the streak", async () => {
    const clock = { t: NOW };
    const { store, runner, sent } = harness(clock, {
      runAgent: async () => { throw new Error("markup changed"); },
      failStreakNotice: (s, streak) => `⚠️ "${s.task}" failed ${streak} checks in a row.`,
    });
    store.add(1, { kind: "daily", task: "btc price", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    const forceDue = () => { store.list(1)[0]!.dueMs = clock.t - 1; }; // each fire advances dueMs to tomorrow; re-arm it
    await runner.tick(); expect(sent).toHaveLength(0); forceDue(); // streak 1: silent
    await runner.tick(); expect(sent).toHaveLength(0); forceDue(); // streak 2: silent
    await runner.tick();                                           // streak 3: receipt
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/failed 3 checks/i);
    expect(store.list(1)[0]!.attempts ?? 0).toBe(0);   // streak reset after the receipt
    // Advances normally each time (a recurring watch keeps watching).
    expect(store.list(1)[0]!.dueMs).toBeGreaterThan(NOW);
  });

  // A successful fire clears any accumulated failure streak so the receipt only fires on a TRUE
  // consecutive run of failures.
  it("a successful fire resets the failure streak", async () => {
    const clock = { t: NOW };
    let fail = true;
    const { store, runner, sent } = harness(clock, {
      runAgent: async () => { if (fail) throw new Error("down"); return { reply: "ok" }; },
      failStreakNotice: () => "⚠️ dead watch",
    });
    store.add(1, { kind: "daily", task: "d", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick(); store.list(1)[0]!.dueMs = NOW - 1; // re-arm (fire advanced dueMs to tomorrow)
    await runner.tick();                                    // streak 2
    expect(store.list(1)[0]!.attempts).toBe(2);
    fail = false;
    store.list(1)[0]!.dueMs = NOW - 1; // force due for the success tick
    await runner.tick();
    expect(store.list(1)[0]!.attempts ?? 0).toBe(0);   // cleared by the successful fire
    expect(sent.some((m) => /dead watch/.test(m.text))).toBe(false); // never hit threshold
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

  // m14 degrade-4: a failed ONE-SHOT reminder must not vanish silently — when a failureNotice is
  // wired, the user gets one friendly line. A daily stays silent (no misfire storm).
  describe("failureNotice (degrade-4)", () => {
    const notice = (s: { kind: string; task: string }, raw: string) =>
      s.kind === "once" ? `couldn't run "${s.task}": ${raw}` : null;

    it("a failed once-task sends the friendly failure notice after retries are exhausted", async () => {
      const clock = { t: NOW };
      const { store, runner, sent } = harness(clock, {
        runAgent: async () => { throw new Error("anvil ECONNREFUSED"); },
        failureNotice: notice,
      });
      store.add(7, { kind: "once", task: "check flight", dueMs: NOW - 1 }, NOW);
      for (let i = 0; i < 5; i++) await runner.tick(); // default cap 5: retries 1-4 deferred, 5th gives up
      expect(sent).toHaveLength(1);                     // notice only once, after exhausting retries
      expect(sent[0]!.chatId).toBe(7);
      expect(sent[0]!.text).toMatch(/couldn't run "check flight"/);
      expect(store.list(7)).toHaveLength(0); // dropped after the cap, no storm
    });

    it("a failed daily-task stays silent (notice returns null) but still reschedules", async () => {
      const clock = { t: NOW };
      const { store, runner, sent } = harness(clock, {
        runAgent: async () => { throw new Error("boom"); },
        failureNotice: notice,
      });
      store.add(7, { kind: "daily", task: "weather", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
      await runner.tick();
      expect(sent).toHaveLength(0);          // silent — no failure ping for a daily
      const after = store.list(7);
      expect(after).toHaveLength(1);
      expect(after[0]!.dueMs).toBeGreaterThan(NOW); // advanced to tomorrow
    });

    it("the failure notice is suppressed when the chat is over its hourly cap", async () => {
      const clock = { t: NOW };
      const sent: Array<{ chatId: number }> = [];
      const { store, runner } = harness(clock, {
        maxPerChatPerHour: 1,
        // First task succeeds (consumes the 1 allowed send); second fails and its notice is capped.
        runAgent: async (task) => { if (task === "b") throw new Error("down"); return { reply: `did:${task}` }; },
        send: async (chatId) => { sent.push({ chatId }); },
        failureNotice: notice,
      });
      store.add(9, { kind: "once", task: "a", dueMs: NOW - 1 }, NOW);
      store.add(9, { kind: "once", task: "b", dueMs: NOW - 1 }, NOW);
      await runner.tick();
      expect(sent).toHaveLength(1); // only the success send; the over-cap failure notice suppressed
    });

    it("no failureNotice dep = silent on failure (historical default)", async () => {
      const clock = { t: NOW };
      const { store, runner, sent } = harness(clock, {
        runAgent: async () => { throw new Error("boom"); },
      });
      store.add(1, { kind: "once", task: "x", dueMs: NOW - 1 }, NOW);
      await runner.tick();
      expect(sent).toHaveLength(0);
    });
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
  it("stops sending past the hourly cap; over-cap ONCE-reminders are deferred (kept), not dropped", async () => {
    const clock = { t: NOW };
    const sent: Array<{ chatId: number }> = [];
    let agentCalls = 0;
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 2,
      runAgent: async (task) => { agentCalls++; return { reply: `did:${task}` }; },
      send: async (chatId) => { sent.push({ chatId }); },
    });
    // 4 due once-tasks for the same chat; cap 2 -> only 2 fire this tick; the other 2 are DEFERRED,
    // NOT deleted (an explicit reminder must not vanish silently — once-reminder-cap-drop fix).
    for (let i = 0; i < 4; i++) store.add(1, { kind: "once", task: `t${i}`, dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(sent).toHaveLength(2);
    expect(agentCalls).toBe(2);
    expect(store.list(1)).toHaveLength(2); // the 2 over-cap once-tasks are still queued, not dropped
  });

  it("a deferred once-reminder is delivered on a later tick once the rolling-hour cap frees up", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 2,
      runAgent: async (task) => ({ reply: `did:${task}` }),
      send: async (_c, text) => { sent.push(text); },
    });
    for (let i = 0; i < 4; i++) store.add(1, { kind: "once", task: `t${i}`, dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(sent).toHaveLength(2);      // cap 2 this hour
    expect(store.list(1)).toHaveLength(2);
    clock.t = NOW + 3_600_001;         // an hour later: the rolling window has cleared
    await runner.tick();
    expect(sent).toHaveLength(4);      // the 2 deferred reminders now delivered
    expect(store.list(1)).toHaveLength(0); // and completed
  });

  it("an over-cap once-reminder is delivered anyway once overdue past the grace window (once-reminder-cap-starvation)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 1,
      runAgent: async (task) => ({ reply: `did:${task}` }),
      send: async (_c, text) => { sent.push(text); },
    });
    // Two once-tasks due now; cap 1 -> first fires, second deferred (within grace).
    store.add(1, { kind: "once", task: "meds", dueMs: NOW - 1 }, NOW);
    store.add(1, { kind: "once", task: "filler", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(sent).toHaveLength(1);            // cap 1 hit; one deferred
    expect(store.list(1)).toHaveLength(1);   // the deferred one is kept
    // Advance PAST the grace window but stay within the same rolling hour (cap still full from the
    // first send) — the deferred reminder must be forced out rather than starved indefinitely.
    clock.t = NOW + 16 * 60_000;             // 16 min > 15 min grace, < 1h rolling window
    await runner.tick();
    expect(sent).toHaveLength(2);            // forced despite the cap
    expect(store.list(1)).toHaveLength(0);   // completed
  });

  it("an over-cap DAILY occurrence is still dropped (advances), not deferred — it must not storm", async () => {
    const clock = { t: NOW };
    const sent: unknown[] = [];
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 1,
      runAgent: async (task) => ({ reply: `did:${task}` }),
      send: async () => { sent.push(1); },
    });
    store.add(1, { kind: "once", task: "a", dueMs: NOW - 1 }, NOW);                    // consumes the 1 slot
    store.add(1, { kind: "daily", task: "d", dueMs: NOW - 1, hourMin: "09:00" }, NOW); // over cap -> daily drops this occurrence
    await runner.tick();
    expect(sent).toHaveLength(1);
    const daily = store.list(1).find((s) => s.kind === "daily")!;
    expect(daily).toBeTruthy();                    // daily stays in the store
    expect(daily.dueMs).toBeGreaterThan(NOW);      // advanced to its next occurrence, not fired now
  });

  it("an over-cap ALERT check still RUNS (edge-triggered, self-throttling) — a crossing isn't lost (sendcap-drops-alert-checks)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    let alertChecks = 0;
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 1,
      runAgent: async (task) => ({ reply: `did:${task}` }),
      send: async (_c, text) => { sent.push(text); },
      alertCheck: async () => { alertChecks++; return { message: "🔔 btc: below 50k", commit: () => {} }; },
    });
    store.add(1, { kind: "once", task: "filler", dueMs: NOW - 1 }, NOW);          // consumes the 1 slot
    store.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW - 1, hourMin: "09:00" }, NOW); // over cap
    await runner.tick();
    expect(alertChecks).toBe(1);   // the alert was CHECKED despite the cap (not skipped)
    // and since it crossed, it sent — an edge-triggered crossing is worth the send even over-cap
    expect(sent).toContain("🔔 btc: below 50k");
  });

  it("an over-cap alert check that DOESN'T change stays silent (no send, no storm)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    let alertChecks = 0;
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 1,
      runAgent: async (task) => ({ reply: `did:${task}` }),
      send: async (_c, text) => { sent.push(text); },
      alertCheck: async () => { alertChecks++; return { message: null, commit: () => {} }; }, // unchanged
    });
    store.add(1, { kind: "once", task: "filler", dueMs: NOW - 1 }, NOW);
    store.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    expect(alertChecks).toBe(1);                              // still checked
    expect(sent).toHaveLength(1);                             // only the filler reminder, no alert send
    expect(sent.some((t) => /btc|🔔/.test(t))).toBe(false);   // unchanged alert stayed silent — can't storm
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

  it("DEV-0187: a degraded scheduled fire records ok:false + marks the message partial (not a clean success)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const recorded: Array<{ ok: boolean }> = [];
    const { store, runner } = harness(clock, {
      runAgent: async () => ({ reply: "I ran out of steps before finishing.", steps: 8, tools: ["scrape"], degraded: true }),
      send: async (_c, text) => { sent.push(text); },
      recordTurn: (t) => recorded.push({ ok: t.ok }),
    });
    store.add(1, { kind: "daily", task: "morning report", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    // degraded proactive fire is NOT counted as a success
    expect(recorded).toEqual([{ ok: false }]);
    // it's still delivered (a daily shouldn't silently vanish) but clearly marked partial
    expect(sent[0]).toMatch(/Partial/i);
    expect(sent[0]).toContain("⏰ Recurring: morning report");
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

describe("makeScheduleRunner — profile context (product-loop)", () => {
  it("passes the chat's contextFor into runAgent so a scheduled 'weather' uses the saved location", async () => {
    const clock = { t: NOW };
    let gotContext: string | undefined;
    const { store, runner } = harness(clock, {
      contextFor: (chatId) => (chatId === 7 ? "home location is Reykjavik" : ""),
      runAgent: async (_task, deps: { llm: unknown; context?: string }) => { gotContext = deps.context; return { reply: "sunny" }; },
    });
    store.add(7, { kind: "once", task: "weather", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(gotContext).toBe("home location is Reykjavik");
  });
});
