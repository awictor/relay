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

describe("makeScheduleRunner — send-failure gating (send-never-throws-dead-commit-guard)", () => {
  it("a FAILED send (send returns false) does NOT commit the alert baseline + does NOT complete — it re-fires", async () => {
    const clock = { t: NOW };
    const store = new ScheduleStore({ file: tmpFile() });
    let committed = 0;
    let sends = 0;
    const runner = makeScheduleRunner({
      store, llm: {} as never,
      runAgent: async () => ({ reply: "x" }),
      send: async () => { sends++; return false; }, // delivery fails every time
      alertCheck: async () => ({ message: "🔔 btc crossed", commit: () => { committed++; }, softFail: false }),
      formatReply: (t) => t, now: () => clock.t, periodMs: 0,
    });
    store.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    expect(sends).toBe(1);
    expect(committed).toBe(0);            // baseline NOT advanced — the crossing isn't swallowed
    // the daily advances (recurring) on the failed-send throw; a day later it re-checks (crossing
    // re-evaluated) rather than being lost. Advance the clock so the rescheduled daily is due again.
    clock.t += 25 * 3_600_000;
    await runner.tick();
    expect(sends).toBe(2);                // re-fired — the guard kept it live
  });

  it("a FAILED reminder send does NOT complete the once — it retries next tick", async () => {
    const clock = { t: NOW };
    const store = new ScheduleStore({ file: tmpFile() });
    let ok = false;
    const runner = makeScheduleRunner({
      store, llm: {} as never,
      runAgent: async () => ({ reply: "x" }),
      send: async () => (ok ? true : false), // first send fails, later succeeds
      formatReply: (t) => t, now: () => clock.t, periodMs: 0,
    });
    store.add(1, { kind: "once", task: "take meds", dueMs: NOW - 1, reminderOnly: true }, NOW);
    await runner.tick();
    expect(store.list(1)).toHaveLength(1); // NOT completed (send failed) — the promise survives
    ok = true;
    await runner.tick();
    expect(store.list(1)).toHaveLength(0); // delivered on retry -> completed
  });

  it("a SUCCESSFUL send (returns true) commits + completes as before", async () => {
    const clock = { t: NOW };
    const store = new ScheduleStore({ file: tmpFile() });
    let committed = 0;
    const runner = makeScheduleRunner({
      store, llm: {} as never,
      runAgent: async () => ({ reply: "x" }),
      send: async () => true,
      alertCheck: async () => ({ message: "🔔 btc crossed", commit: () => { committed++; }, softFail: false }),
      formatReply: (t) => t, now: () => clock.t, periodMs: 0,
    });
    store.add(1, { kind: "once", task: "alert:btc", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(committed).toBe(1);
    expect(store.list(1)).toHaveLength(0);
  });
});

describe("makeScheduleRunner — inline buttons (inline-tap-buttons)", () => {
  it("attaches Refresh/Snooze/Stop buttons to an alert ping and none to a plain reminder", async () => {
    const clock = { t: NOW };
    const store = new ScheduleStore({ file: tmpFile() });
    const sent: Array<{ text: string; keyboard: unknown }> = [];
    const runner = makeScheduleRunner({
      store, llm: {} as never,
      runAgent: async (task) => ({ reply: `did:${task}` }),
      send: async (_c, text, keyboard) => { sent.push({ text, keyboard }); },
      formatReply: (t) => t, now: () => clock.t, periodMs: 0,
      alertCheck: async () => ({ message: "🔔 btc crossed", commit: () => {} }),
    });
    store.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW - 1, hourMin: [9, 0] }, NOW - MIN);
    store.add(1, { kind: "once", task: "take my meds", dueMs: NOW - 1, reminderOnly: true }, NOW - MIN);
    await runner.tick();
    const alertSend = sent.find((s) => /crossed/.test(s.text))!;
    expect(alertSend).toBeTruthy();
    // keyboard is [[{text, callback_data}...]] with a Refresh/Snooze/Stop row
    const labels = (alertSend.keyboard as Array<Array<{ text: string }>>)[0]!.map((b) => b.text);
    expect(labels.some((l) => /Refresh/.test(l))).toBe(true);
    expect(labels.some((l) => /Stop/.test(l))).toBe(true);
    const reminderSend = sent.find((s) => /take my meds/.test(s.text))!;
    expect(reminderSend.keyboard).toBeUndefined();
  });

  it("attaches pick buttons + caches items when a proactive list ping is a numbered list (picker-on-proactive-pings)", async () => {
    const clock = { t: NOW };
    const store = new ScheduleStore({ file: tmpFile() });
    const sent: Array<{ text: string; keyboard: unknown }> = [];
    const pickListStore = new Map<number, Array<{ index: number; text: string }>>();
    const runner = makeScheduleRunner({
      store, llm: {} as never,
      runAgent: async () => ({ reply: "New listings:\n1. 2020 Civic $18k\n2. 2019 Corolla $16k\n3. 2021 Mazda3 $20k" }),
      send: async (_c, text, keyboard) => { sent.push({ text, keyboard }); },
      formatReply: (t) => t, now: () => clock.t, periodMs: 0,
      pickListStore,
    });
    store.add(7, { kind: "daily", task: "new car listings", dueMs: NOW - 1, hourMin: [9, 0] }, NOW - MIN);
    await runner.tick();
    const kb = sent[0]!.keyboard as Array<Array<{ text: string; callback_data: string }>>;
    // A pick row of 1/2/3 buttons.
    const pickRow = kb.find((row) => row.some((b) => /^\d+$/.test(b.text)))!;
    expect(pickRow.map((b) => b.text)).toEqual(["1", "2", "3"]);
    // Items cached for a subsequent tap.
    expect(pickListStore.get(7)).toHaveLength(3);
    expect(pickListStore.get(7)![1]!.text).toMatch(/Corolla/);
  });

  it("merges pick buttons BELOW an alert's Refresh/Stop row when a watch ping is a list", async () => {
    const clock = { t: NOW };
    const store = new ScheduleStore({ file: tmpFile() });
    const sent: Array<{ keyboard: unknown }> = [];
    const pickListStore = new Map<number, Array<{ index: number; text: string }>>();
    const runner = makeScheduleRunner({
      store, llm: {} as never,
      runAgent: async () => ({ reply: "x" }),
      send: async (_c, _t, keyboard) => { sent.push({ keyboard }); },
      formatReply: (t) => t, now: () => clock.t, periodMs: 0,
      alertCheck: async () => ({ message: "Restocks:\n1. Size M\n2. Size L", commit: () => {} }),
      pickListStore,
    });
    store.add(3, { kind: "daily", task: "alert:sizes", dueMs: NOW - 1, hourMin: [9, 0] }, NOW - MIN);
    await runner.tick();
    const kb = sent[0]!.keyboard as Array<Array<{ text: string }>>;
    // Row 0 = Refresh/Snooze/Stop (marker), later row = pick 1/2.
    expect(kb[0]!.some((b) => /Refresh/.test(b.text))).toBe(true);
    expect(kb.some((row) => row.every((b) => /^\d+$/.test(b.text)))).toBe(true);
    expect(pickListStore.get(3)).toHaveLength(2);
  });
});

describe("makeScheduleRunner.tick", () => {
  it("fires nothing when nothing is due", async () => {
    const clock = { t: NOW };
    const { store, runner, sent } = harness(clock);
    store.add(1, { kind: "once", task: "x", dueMs: NOW + 10 * MIN }, NOW);
    expect(await runner.tick()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("a hung task times out so the rest of the due batch still fires (slow-task-starves-due-reminders)", async () => {
    const prev = process.env.RELAY_FIRE_TIMEOUT_MS;
    process.env.RELAY_FIRE_TIMEOUT_MS = "30"; // short real timeout for the test
    try {
      const clock = { t: NOW };
      const sent: Array<{ chatId: number; text: string }> = [];
      const store = new ScheduleStore({ file: tmpFile() });
      let firstStarted = false;
      const runner = makeScheduleRunner({
        store,
        llm: {} as never,
        // chat 1's run hangs forever (never resolves -> hits the 30ms timeout); chat 2 resolves at once.
        runAgent: async (task) => {
          if (task === "hang") { firstStarted = true; return new Promise<{ reply: string }>(() => {}); }
          return { reply: `did:${task}` };
        },
        send: async (chatId, text) => { sent.push({ chatId, text }); },
        formatReply: (t) => t,
        now: () => clock.t,
        periodMs: 0,
      });
      store.add(1, { kind: "once", task: "hang", dueMs: NOW - 2 }, NOW);
      store.add(2, { kind: "once", task: "stretch", dueMs: NOW - 1 }, NOW);
      const n = await runner.tick();
      expect(firstStarted).toBe(true);         // the hung task did start
      expect(n).toBe(1);                        // only the 2nd fired (the 1st timed out)
      expect(sent.some((m) => m.chatId === 2)).toBe(true); // chat 2 wasn't starved behind the hang
    } finally {
      if (prev === undefined) delete process.env.RELAY_FIRE_TIMEOUT_MS; else process.env.RELAY_FIRE_TIMEOUT_MS = prev;
    }
  });

  it("a reminderOnly whose SEND stalls past the timeout doesn't double-send when it finishes late (reminderonly-no-cancel-guard)", async () => {
    const prev = process.env.RELAY_FIRE_TIMEOUT_MS;
    process.env.RELAY_FIRE_TIMEOUT_MS = "20";
    try {
      const clock = { t: NOW };
      const sent: string[] = [];
      const store = new ScheduleStore({ file: tmpFile() });
      let releaseSend!: () => void;
      let sendCalls = 0;
      const runner = makeScheduleRunner({
        store, llm: {} as never,
        runAgent: async () => ({ reply: "unused" }),
        // A reminderOnly echoes via deps.send; make the FIRST send hang past the 20ms timeout.
        send: async (_c, text) => { sendCalls++; if (sendCalls === 1) { await new Promise<void>((r) => { releaseSend = r; }); } sent.push(text); },
        formatReply: (t) => t, now: () => clock.t, periodMs: 0,
      });
      store.add(1, { kind: "once", task: "take meds", dueMs: NOW - 1, reminderOnly: true }, NOW);
      await runner.tick();                    // send stalls -> fire times out at 20ms -> once retry-deferred
      releaseSend();                          // the stalled send now completes late
      await new Promise((r) => setTimeout(r, 0));
      // The stalled send DID eventually push its text (1 delivery), but the late finish must not
      // re-send or double-complete. The once is still in the store (deferred for retry), not dropped twice.
      expect(sent.length).toBeLessThanOrEqual(1);
    } finally {
      if (prev === undefined) delete process.env.RELAY_FIRE_TIMEOUT_MS; else process.env.RELAY_FIRE_TIMEOUT_MS = prev;
    }
  });

  it("a slow task that finishes AFTER its timeout does not double-send or double-complete (slow-task-starves-due-reminders)", async () => {
    const prev = process.env.RELAY_FIRE_TIMEOUT_MS;
    process.env.RELAY_FIRE_TIMEOUT_MS = "20";
    try {
      const clock = { t: NOW };
      const sent: Array<{ chatId: number; text: string }> = [];
      const store = new ScheduleStore({ file: tmpFile() });
      let release!: (r: { reply: string }) => void;
      const runner = makeScheduleRunner({
        store, llm: {} as never,
        runAgent: () => new Promise<{ reply: string }>((res) => { release = res; }), // resolves only when we say
        send: async (chatId, text) => { sent.push({ chatId, text }); },
        formatReply: (t) => t, now: () => clock.t, periodMs: 0,
      });
      store.add(1, { kind: "daily", task: "brief", dueMs: NOW - 1, hourMin: "09:00", offsetMin: 0 }, NOW);
      const dueBefore = store.list(1)[0]!.dueMs;
      await runner.tick();                       // times out at 20ms -> catch advances the daily
      const dueAfterTimeout = store.list(1)[0]!.dueMs;
      expect(dueAfterTimeout).toBeGreaterThan(dueBefore); // schedule advanced by the timeout path
      // Now the abandoned run finishes LATE — it must be dropped, not sent.
      release({ reply: "late briefing" });
      await new Promise((r) => setTimeout(r, 0));
      expect(sent).toHaveLength(0);              // no duplicate ping from the late finish
      expect(store.list(1)[0]!.dueMs).toBe(dueAfterTimeout); // not advanced a second time
    } finally {
      if (prev === undefined) delete process.env.RELAY_FIRE_TIMEOUT_MS; else process.env.RELAY_FIRE_TIMEOUT_MS = prev;
    }
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

  it("a RECURRING recipe/digest whose content is gone sends a one-time notice, then stays silent (digest-silent-on-member-delete)", async () => {
    const clock = { t: NOW };
    const notices: Array<{ what: string; name: string }> = [];
    const { store, runner, sent } = harness(clock, {
      recipeResolveTask: () => null,          // recipe deleted
      digestRun: async () => null,            // digest members all gone
      goneNotice: (_s, what, name) => { notices.push({ what, name }); return `⚠️ "${name}" ${what} stopped.`; },
    });
    store.add(1, { kind: "daily", task: "recipe:brief", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    store.add(2, { kind: "daily", task: "digest:morning", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    expect(notices).toEqual([{ what: "recipe", name: "brief" }, { what: "digest", name: "morning" }]);
    expect(sent.filter((s) => /stopped/.test(s.text))).toHaveLength(2);
    // Fire again next day — the notice does NOT repeat (one-shot per schedule id).
    clock.t = NOW + 25 * 3_600_000;
    // re-due both (daily advanced ~24h; push them due again)
    for (const s of store.list(1).concat(store.list(2))) store.deferTo(s.id, clock.t - 1);
    await runner.tick();
    expect(notices).toHaveLength(2); // still just the two — no repeat
  });

  it("a ONCE recipe whose content is gone stays silent (no notice — it just drops)", async () => {
    const clock = { t: NOW };
    const notices: unknown[] = [];
    const { store, runner, sent } = harness(clock, {
      recipeResolveTask: () => null,
      goneNotice: () => { notices.push(1); return "should not fire"; },
    });
    store.add(1, { kind: "once", task: "recipe:gone", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(notices).toHaveLength(0);   // a once needs no "it stopped" notice
    expect(sent).toHaveLength(0);
    expect(store.list(1)).toHaveLength(0);
  });

  it("records the proactive send into the shared cache for a 'more'/'link' drilldown (proactive-ping-drilldown-cache)", async () => {
    const clock = { t: NOW };
    const store = new Map<number, { full: string; sent: number }>();
    const { store: sched, runner } = harness(clock, {
      runAgent: async () => ({ reply: "the news is X, see https://ex.com/a" }),
      recordSend: (chatId, full, sentLen) => store.set(chatId, { full, sent: sentLen ?? full.length }),
    });
    sched.add(1, { kind: "once", task: "news", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    expect(store.get(1)!.full).toMatch(/the news is X/); // cached for a follow-up drilldown
  });

  it("caches the UNTRIMMED digest for drilldown, so 'more' can page the dropped tail (digest-drilldown-trims-tail)", async () => {
    const clock = { t: NOW };
    const store = new Map<number, { full: string; sent: number }>();
    // A long digest whose formatReply trims to a short shown slice.
    const longDigest = "📋 morning\n" + Array.from({ length: 40 }, (_, i) => `• line ${i} https://ex.com/${i}`).join("\n");
    const { store: sched, runner } = harness(clock, {
      digestRun: async () => longDigest,
      formatReply: (t) => t.slice(0, 200), // simulate trimming
      recordSend: (chatId, full, sentLen) => store.set(chatId, { full, sent: sentLen ?? full.length }),
    });
    sched.add(1, { kind: "daily", task: "digest:morning", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    const cached = store.get(1)!;
    expect(cached.full).toBe(longDigest);          // FULL untrimmed text cached, not the 200-char slice
    expect(cached.sent).toBe(200);                 // only 200 chars were actually sent
    expect(cached.full.length).toBeGreaterThan(cached.sent); // -> "more" has a tail to page
  });

  it("caches the UNTRIMMED agent reply for a scheduled task, so 'more' can page the dropped tail (sched-reminder-tail-trim)", async () => {
    const clock = { t: NOW };
    const store = new Map<number, { full: string; sent: number }>();
    // A long agent answer whose phone-sized view is trimmed. formatReplyParts returns both views.
    const longReply = Array.from({ length: 40 }, (_, i) => `sentence ${i} https://ex.com/${i}`).join(" ");
    const { store: sched, runner } = harness(clock, {
      runAgent: async () => ({ reply: longReply }),
      formatReply: (t) => t.slice(0, 200),                          // trimmed view
      formatReplyParts: (t) => ({ shown: t.slice(0, 200), full: t }), // untrimmed full retained
      recordSend: (chatId, full, sentLen) => store.set(chatId, { full, sent: sentLen ?? full.length }),
    });
    sched.add(1, { kind: "once", task: "summarize the article", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    const cached = store.get(1)!;
    expect(cached.full).toContain("sentence 39"); // the FULL reply (incl. the tail) was cached
    expect(cached.full.length).toBeGreaterThan(cached.sent); // -> "more" has a real tail to page
  });

  it("without formatReplyParts, a short scheduled reply still caches sensibly (back-compat)", async () => {
    const clock = { t: NOW };
    const store = new Map<number, { full: string; sent: number }>();
    const { store: sched, runner } = harness(clock, {
      runAgent: async () => ({ reply: "short answer" }),
      // no formatReplyParts injected -> falls back to formatReply, fullText stays undefined
      recordSend: (chatId, full, sentLen) => store.set(chatId, { full, sent: sentLen ?? full.length }),
    });
    sched.add(1, { kind: "once", task: "ping", dueMs: NOW - 1 }, NOW);
    await runner.tick();
    const cached = store.get(1)!;
    expect(cached.full).toContain("short answer");
    expect(cached.sent).toBe(cached.full.length); // whole thing sent, no phantom tail
  });

  it("defers a proactive send that lands in quiet hours to the window's end, no send (quiet-hours)", async () => {
    const clock = { t: NOW };
    const sent: unknown[] = [];
    const { store, runner } = harness(clock, {
      send: async () => { sent.push(1); },
      quietUntil: () => NOW + 8 * 3_600_000, // in quiet window -> defer 8h out
      deferTo: (id, when) => { store.deferTo(id, when); },
    });
    // A long-horizon relative once (set a day ago) landing in quiet hours defers; a just-set near-term
    // timer would not (see the short-once test below).
    store.add(1, { kind: "once", task: "meds", dueMs: NOW - 1 }, NOW - 86_400_000);
    const n = await runner.tick();
    expect(n).toBe(0);                               // nothing fired
    expect(sent).toHaveLength(0);                    // no 3am ping
    expect(store.list(1)[0]!.dueMs).toBe(NOW + 8 * 3_600_000); // pushed to window end
  });

  it("an explicit wall-clock 'once' alarm fires AT its time even inside quiet hours (quiet-hours-once-alarm)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const { store, runner } = harness(clock, {
      send: async (_c, text) => { sent.push(text); },
      quietUntil: () => NOW + 8 * 3_600_000, // now is inside the quiet window
      deferTo: (id, when) => { store.deferTo(id, when); },
    });
    // "wake me at 6am" — clockTime marks the user-chosen instant; deferring it to 8am defeats the alarm.
    store.add(1, { kind: "once", task: "wake up", dueMs: NOW - 1, clockTime: true, reminderOnly: true }, NOW);
    const n = await runner.tick();
    expect(n).toBe(1);                     // fired despite quiet hours
    expect(sent[0]).toMatch(/wake up/);    // the alarm rang on time
    expect(store.list(1)).toHaveLength(0); // once delivered + dropped, not deferred
  });

  it("a LONG relative 'once' (set days ahead, no clockTime) still defers in quiet hours — its instant is incidental", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const { store, runner } = harness(clock, {
      send: async (_c, text) => { sent.push(text); },
      quietUntil: () => NOW + 8 * 3_600_000,
      deferTo: (id, when) => { store.deferTo(id, when); },
    });
    // Created 2 days ago, due now — a long-horizon relative once, NOT a just-set near-term timer.
    store.add(1, { kind: "once", task: "check the thing", dueMs: NOW - 1 }, NOW - 2 * 86_400_000);
    const n = await runner.tick();
    expect(n).toBe(0);                                          // deferred, not fired
    expect(sent).toHaveLength(0);
    expect(store.list(1)[0]!.dueMs).toBe(NOW + 8 * 3_600_000);  // pushed to window end
  });

  it("a SHORT-horizon once (timer / 'in 20 min') fires in quiet hours, not deferred (timer-quiet-hours-defer)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const { store, runner } = harness(clock, {
      send: async (_c, text) => { sent.push(text); },
      quietUntil: () => NOW + 8 * 3_600_000, // deep in the quiet window
      deferTo: (id, when) => { store.deferTo(id, when); },
    });
    // "timer for 20 minutes" set just now, now due — a deliberate near-term instant.
    store.add(1, { kind: "once", task: "timer's up ⏰", dueMs: NOW - 1, reminderOnly: true }, NOW - 20 * 60_000);
    const n = await runner.tick();
    expect(n).toBe(1);                 // fired on time despite quiet hours
    expect(sent[0]).toMatch(/timer/i);
  });

  it("a relative 'remind me in 4 hours' set at night fires on time, not deferred to quiet-end (relative-once-quiet-defer)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const { store, runner } = harness(clock, {
      send: async (_c, text) => { sent.push(text); },
      quietUntil: () => NOW + 3 * 3_600_000, // now is inside the quiet window (ends in 3h)
      deferTo: (id, when) => { store.deferTo(id, when); },
    });
    // "remind me in 4 hours" set 4h ago, now due — hour-granularity relative once = a deliberate gap.
    store.add(1, { kind: "once", task: "take the pizza out 🍕", dueMs: NOW - 1, reminderOnly: true }, NOW - 4 * 3_600_000);
    const n = await runner.tick();
    expect(n).toBe(1);                 // fired on time despite quiet hours (NOT pushed to quiet-end)
    expect(sent[0]).toMatch(/pizza/i);
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

  it("a PERSISTENT alert (feed/page) is deferred to quiet-end, not buzzed at 3am (quiet-hours-persistent-alerts)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    let alertChecks = 0;
    const { store, runner } = harness(clock, {
      send: async (_c, text) => { sent.push(text); },
      quietUntil: () => NOW + 8 * 3_600_000, // deep in the quiet window
      deferTo: (id, when) => { store.deferTo(id, when); },
      alertCheck: async () => { alertChecks++; return { message: "🆕 new listing", commit: () => {} }; },
      alertQuietDeferrable: () => true, // this alert's change persists (a feed/page-diff)
    });
    store.add(1, { kind: "daily", task: "alert:jobs", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    expect(alertChecks).toBe(0);           // the CHECK itself waits — nothing lost, the item is still there at 8am
    expect(sent).toHaveLength(0);          // no 3am buzz
    const a = store.list(1).find((s) => s.task === "alert:jobs")!;
    expect(a.dueMs).toBe(NOW + 8 * 3_600_000); // deferred to quiet-end
    // at quiet-end it runs + sends
    clock.t = NOW + 8 * 3_600_000;
    await runner.tick();
    expect(sent).toContain("🆕 new listing");
  });

  it("an EDGE-triggered alert stays exempt even when a deferrable classifier is wired (crossing can revert)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    let alertChecks = 0;
    const { store, runner } = harness(clock, {
      send: async (_c, text) => { sent.push(text); },
      quietUntil: () => NOW + 8 * 3_600_000,
      deferTo: (id, when) => { store.deferTo(id, when); },
      alertCheck: async () => { alertChecks++; return { message: "🔔 below 50k", commit: () => {} }; },
      alertQuietDeferrable: () => false, // value/predicate/weather -> edge-triggered, NOT deferrable
    });
    store.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    expect(alertChecks).toBe(1);                 // still evaluated on cadence so the crossing isn't lost
    expect(sent).toContain("🔔 below 50k");
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

  it("an over-cap DIGEST is deferred (kept), not dropped for the day (digest-dropped-over-cap)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 1,
      runAgent: async (task) => ({ reply: `did:${task}` }),
      send: async (_c, text) => { sent.push(text); },
      digestRun: async (_c, name) => `📋 ${name}\n• weather\n• hn`,
    });
    store.add(1, { kind: "once", task: "filler", dueMs: NOW - 1 }, NOW);          // consumes the 1 slot
    store.add(1, { kind: "daily", task: "digest:morning", dueMs: NOW - 1, hourMin: "09:00" }, NOW); // over cap
    await runner.tick();
    expect(sent).toHaveLength(1);                        // only the filler; digest deferred, not sent
    const digest = store.list(1).find((s) => s.task === "digest:morning")!;
    expect(digest).toBeTruthy();                          // still queued (NOT advanced to tomorrow)
    expect(digest.dueMs).toBeLessThanOrEqual(NOW);        // left DUE so a later tick delivers it
    // an hour later the cap clears -> the digest finally sends.
    clock.t = NOW + 3_600_001;
    await runner.tick();
    expect(sent.some((t) => /morning/.test(t))).toBe(true);
  });

  it("a plain daily is DEFERRED (kept), not dropped, when over cap (chatty-watch-starves-daily)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 1,
      runAgent: async (task) => ({ reply: `did:${task}` }),
      send: async (_c, text) => { sent.push(text); },
    });
    store.add(1, { kind: "once", task: "filler", dueMs: NOW - 1 }, NOW);          // consumes the slot
    store.add(1, { kind: "daily", task: "weather", dueMs: NOW - 1, hourMin: "09:00" }, NOW); // over cap
    await runner.tick();
    expect(sent).toHaveLength(1);                         // filler only; the daily briefing deferred, not lost
    const daily = store.list(1).find((s) => s.task === "weather")!;
    expect(daily.dueMs).toBeLessThanOrEqual(NOW);         // left DUE (grace) so a later tick delivers it — NOT advanced a day out
    // once a slot frees, the relied-upon daily finally sends instead of silently no-showing.
    clock.t = NOW + 3_600_001;
    await runner.tick();
    expect(sent.some((t) => /weather/.test(t))).toBe(true);
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

  it("an over-cap MONTHLY reminder is deferred (kept), not dropped for the month (monthly-yearly-cap-drop)", async () => {
    const clock = { t: NOW };
    const sent: unknown[] = [];
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 1,
      runAgent: async (task) => ({ reply: `did:${task}` }),
      send: async () => { sent.push(1); },
    });
    store.add(1, { kind: "once", task: "filler", dueMs: NOW - 1 }, NOW);   // consumes the 1 slot
    store.add(1, { kind: "monthly", task: "pay rent", dueMs: NOW - 1, hourMin: "09:00", offsetMin: 0, dayOfMonth: 1, reminderOnly: true }, NOW); // over cap
    await runner.tick();
    expect(sent).toHaveLength(1);                    // only the filler; the rent reminder deferred, not dropped
    const monthly = store.list(1).find((s) => s.kind === "monthly")!;
    expect(monthly).toBeTruthy();
    expect(monthly.dueMs).toBeLessThanOrEqual(NOW);  // left DUE (grace) so a later tick delivers it — NOT advanced a month out
  });

  it("an over-cap INTERVAL occurrence is still dropped (advances), not deferred — a sticky nag must not storm", async () => {
    const clock = { t: NOW };
    const sent: unknown[] = [];
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 1,
      runAgent: async (task) => ({ reply: `did:${task}` }),
      send: async () => { sent.push(1); },
    });
    store.add(1, { kind: "once", task: "a", dueMs: NOW - 1 }, NOW);                    // consumes the 1 slot
    // interval is the storm case the cap exists for (a "nag me every 15 min") — it stays droppable.
    store.add(1, { kind: "interval", task: "d", dueMs: NOW - 1, intervalMs: 15 * 60_000 }, NOW); // over cap -> drops this occurrence
    await runner.tick();
    expect(sent).toHaveLength(1);
    const iv = store.list(1).find((s) => s.kind === "interval")!;
    expect(iv).toBeTruthy();                        // interval stays in the store
    expect(iv.dueMs).toBeGreaterThan(NOW);          // advanced to its next occurrence, not fired now
  });

  it("an over-cap STICKY drop does NOT burn its anti-nag budget (sticky-cap-drop-burns-budget)", async () => {
    const clock = { t: NOW };
    const sent: unknown[] = [];
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 1,
      runAgent: async () => ({ reply: "x" }),
      send: async () => { sent.push(1); },
    });
    store.add(1, { kind: "once", task: "filler", dueMs: NOW - 1 }, NOW); // consumes the 1 slot
    // A sticky "nag me to take my meds" with stickyMax 2. Over cap this tick -> dropped (not sent).
    store.add(1, { kind: "interval", task: "meds", dueMs: NOW - 1, intervalMs: 15 * 60_000, reminderOnly: true, sticky: true, stickyMax: 2 }, NOW);
    await runner.tick();
    expect(sent).toHaveLength(1);                                   // only the filler; the sticky was cap-dropped
    const sticky = store.list(1).find((s) => s.task === "meds")!;
    expect(sticky).toBeTruthy();                                    // still alive
    expect(sticky.stickyFired ?? 0).toBe(0);                        // budget NOT burned by the unsent ping
  });

  it("a watch that keeps SOFT-failing (can't read its source) earns a failed-watch receipt, not silent death (silent-watch-death)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const notices: number[] = [];
    let checks = 0;
    const { store, runner } = harness(clock, {
      send: async (_c, text) => { sent.push(text); },
      alertCheck: async () => { checks++; return { message: null, commit: () => {}, softFail: true }; }, // source unreadable every tick
      failStreakNotice: (_s, streak) => { notices.push(streak); return `⚠️ your watch failed ${streak} checks`; },
    });
    store.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    // Fire 3 times (FAIL_STREAK_NOTIFY default 3) — the 3rd trips the receipt. Advance the clock a day
    // each round so the daily (which reschedules ~24h forward on complete) is due again.
    for (let i = 0; i < 3; i++) {
      await runner.tick(); clock.t += 25 * 3_600_000;
    }
    expect(checks).toBe(3);
    expect(notices).toContain(3);                         // receipt fired at the streak threshold
    expect(sent.some((t) => /failed 3 checks/.test(t))).toBe(true);
  });

  it("a soft-fail streak RESETS on a clean read, so an intermittent blip never trips the receipt", async () => {
    const clock = { t: NOW };
    const notices: number[] = [];
    let call = 0;
    const { store, runner } = harness(clock, {
      send: async () => {},
      // fail, fail, then a clean silent hold (softFail falsy) resets — never reaches 3 in a row.
      alertCheck: async () => { call++; return { message: null, commit: () => {}, softFail: call !== 3 }; },
      failStreakNotice: (_s, streak) => { notices.push(streak); return "x"; },
    });
    store.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    for (let i = 0; i < 4; i++) {
      await runner.tick(); clock.t += 25 * 3_600_000;
    }
    expect(notices).toEqual([]); // fail,fail,CLEAN,fail -> streak never hit 3 consecutively
  });

  it("a watchlist member dead N straight checks earns a per-member receipt; a clean read resets (watchlist-member-dead-no-receipt)", async () => {
    const clock = { t: NOW };
    const notices: Array<{ member: string }> = [];
    let deadEth = true;
    const { store, runner } = harness(clock, {
      send: async () => {},
      // btc always reads; eth is dead until deadEth flips.
      alertCheck: async () => ({ message: null, commit: () => {}, deadMembers: deadEth ? ["eth"] : [] }),
      deadMemberNotice: (_c, _alert, member) => { notices.push({ member }); return `⚠️ "${member}" keeps failing`; },
    });
    store.add(1, { kind: "daily", task: "alert:markets", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    // 3 straight dead checks (FAIL_STREAK_NOTIFY default 3) -> the 3rd fires the receipt for eth.
    for (let i = 0; i < 3; i++) { const s = store.list(1)[0]!; store.deferTo(s.id, clock.t - 1); await runner.tick(); clock.t += 25 * 3_600_000; }
    expect(notices).toEqual([{ member: "eth" }]);
    // eth recovers -> streak resets; further dead-free checks don't re-notify.
    deadEth = false;
    for (let i = 0; i < 4; i++) { const s = store.list(1)[0]!; store.deferTo(s.id, clock.t - 1); await runner.tick(); clock.t += 25 * 3_600_000; }
    expect(notices).toHaveLength(1); // no repeat — eth read fine after recovery
  });

  it("a chatty alert burning the hourly budget no longer starves the user's daily briefing (chatty-watch-starves-daily)", async () => {
    const clock = { t: NOW };
    const sent: string[] = [];
    const { store, runner } = harness(clock, {
      maxPerChatPerHour: 1,
      runAgent: async (task) => ({ reply: `did:${task}` }),
      send: async (_c, text) => { sent.push(text); },
      alertCheck: async () => ({ message: "🔔 btc moved", commit: () => {} }), // a noisy watch that keeps firing
    });
    // The alert fires (cap-exempt) and consumes the 1 send slot via noteSend; the daily briefing is over cap.
    store.add(1, { kind: "daily", task: "alert:btc", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    store.add(1, { kind: "daily", task: "weather + news", dueMs: NOW - 1, hourMin: "09:00" }, NOW);
    await runner.tick();
    expect(sent).toContain("🔔 btc moved");                       // the alert sent
    const daily = store.list(1).find((s) => s.task === "weather + news")!;
    expect(daily.dueMs).toBeLessThanOrEqual(NOW);                  // briefing DEFERRED (kept), not dropped for the day
    clock.t = NOW + 3_600_001;                                     // hour clears
    await runner.tick();
    expect(sent.some((t) => /weather \+ news/.test(t))).toBe(true); // and then it delivers
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

describe("makeScheduleRunner — sticky reminders (sticky-acknowledged-reminders)", () => {
  const MIN = 60_000;
  it("a confirmed sticky ping is stamped fired + the anti-nag budget only counts real sends", async () => {
    const clock = { t: NOW };
    const { store, runner, sent } = harness(clock);
    const r = store.add(1, { kind: "interval", task: "take meds", dueMs: NOW - 1, intervalMs: 15 * MIN, reminderOnly: true, sticky: true, stickyMax: 5 }, NOW)!;
    await runner.tick();
    expect(sent[0]!.text).toMatch(/take meds/);
    expect(sent[0]!.text).toMatch(/reply "done"/i);      // off-switch shown
    const after = store.list(1).find((x) => x.id === r.id)!;
    expect(after.lastFiredMs).toBe(NOW);                 // stamped so a "done" scopes to it
    expect(after.stickyFired).toBe(1);                   // confirmed send counted
  });
  it("a FAILED sticky send does not burn the anti-nag budget (sticky-send-fail-burns-budget)", async () => {
    const clock = { t: NOW };
    const { store, runner } = harness(clock, { send: async () => { throw new Error("telegram down"); } });
    const r = store.add(1, { kind: "interval", task: "meds", dueMs: NOW - 1, intervalMs: 15 * MIN, reminderOnly: true, sticky: true, stickyMax: 2 }, NOW)!;
    await runner.tick(); // the send throws -> tick catch -> safeComplete(fired:false)
    const after = store.list(1).find((x) => x.id === r.id);
    expect(after).toBeDefined();                 // NOT self-dropped by a failed send
    expect(after!.stickyFired ?? 0).toBe(0);     // budget untouched — the user saw nothing, so it doesn't count
  });
});
