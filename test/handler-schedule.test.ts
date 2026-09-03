import { describe, it, expect } from "vitest";
import { createHandler, type HandlerDeps } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";

// Handler schedule routing (m4 sched-3): "remind me" / "every morning" -> scheduleAdd;
// /schedules -> list; /cancel -> remove. All short-circuit before the agent.
function harness(over: Partial<HandlerDeps> = {}) {
  const sent: string[] = [];
  const added: Array<{ chatId: number; text: string }> = [];
  let agentCalls = 0;
  const deps: HandlerDeps = {
    llm: {} as HandlerDeps["llm"],
    memoryGet: () => [] as LLMMessage[],
    memorySet: () => {},
    memoryClear: () => false,
    sendMessage: async (_id, text) => { sent.push(text); },
    sendTyping: async () => {},
    handleCommand: () => null,
    checkRateLimit: () => ({ allowed: true }),
    redactText: (t) => t,
    hasModelKey: () => true,
    recordTurn: () => {},
    now: () => 1_700_000_000_000,
    runAgentFn: async () => { agentCalls++; return { reply: "agent ran", steps: 1, tools: [] }; },
    scheduleAdd: (chatId, text) => { added.push({ chatId, text }); return { ok: true, kind: "once", task: "stretch", whenMs: 0 }; },
    scheduleList: () => [{ id: "s1", kind: "once", task: "stretch", dueMs: 0 }],
    scheduleCancel: (_c, which) => ({ removed: which === "all" ? 2 : 1 }),
    ...over,
  };
  return { handle: createHandler(deps), sent, added, calls: () => agentCalls };
}
const msg = (text: string, chatId = 1): InboundMessage => ({ chatId, from: "u", text } as InboundMessage);

describe("handler — schedule routing", () => {
  it("\"remind me ... in 10 min\" routes to scheduleAdd, confirms, no agent", async () => {
    const { handle, sent, added, calls } = harness();
    await handle(msg("remind me to stretch in 10 min", 5));
    expect(added).toHaveLength(1);
    expect(added[0]!.chatId).toBe(5);
    expect(sent[0]).toMatch(/I'll remind you/i);
    expect(calls()).toBe(0);
  });

  it("\"every 2 days ...\" + \"in 3 weeks ...\" reach scheduleAdd (cue covers multi-day/week gaps)", async () => {
    const a = harness();
    await a.handle(msg("every 2 days water the plants", 5));
    expect(a.added).toHaveLength(1);
    expect(a.calls()).toBe(0); // NOT a silent one-shot agent browse
    const b = harness();
    await b.handle(msg("remind me to renew the lease in 3 weeks", 5));
    expect(b.added).toHaveLength(1);
  });

  it("echoes the resolved next-fire time when scheduleAdd returns whenText (schedule-confirm-fire-time)", async () => {
    const { handle, sent } = harness({
      scheduleAdd: () => ({ ok: true, kind: "daily", task: "weather", whenMs: 0, whenText: "tomorrow 9:00am" }),
    });
    await handle(msg("every morning tell me the weather"));
    expect(sent[0]).toMatch(/Next: tomorrow 9:00am/);
  });

  it("warns about UTC when a clock-time schedule is set with no timezone (no-tz-clock-warning)", async () => {
    const { handle, sent } = harness({
      scheduleAdd: () => ({ ok: true, kind: "daily", task: "weather", whenMs: 0, whenText: "tomorrow 8:00am", noTz: true }),
    });
    await handle(msg("every morning at 8 tell me the weather"));
    expect(sent[0]).toMatch(/No timezone set/i);
    expect(sent[0]).toMatch(/setlocation/i);
  });

  it("no UTC warning when noTz is not set (tz known, or a relative reminder)", async () => {
    const { handle, sent } = harness({
      scheduleAdd: () => ({ ok: true, kind: "once", task: "stretch", whenMs: 0, whenText: "today 3:40pm" }),
    });
    await handle(msg("remind me to stretch in 10 min"));
    expect(sent[0]).not.toMatch(/No timezone set/i);
  });

  it("\"every morning ...\" routes to scheduleAdd as daily", async () => {
    const { handle, sent } = harness({
      scheduleAdd: () => ({ ok: true, kind: "daily", task: "weather", whenMs: 0 }),
    });
    await handle(msg("every morning tell me the weather"));
    expect(sent[0]).toMatch(/daily/i);
  });

  it("a 'remind me WHY/WHAT ...' question falls through to the agent (not a reminder)", async () => {
    const { handle, calls } = harness({
      scheduleAdd: () => ({ ok: false, reason: "unparsed" }),
    });
    await handle(msg("remind me why the sky is blue")); // a "tell me" question, not a reminder
    expect(calls()).toBe(1); // agent handled it
  });

  it("'remind me to <task> at 3' (no am/pm) ASKS for the time, no agent, no silent drop (reminder-intent-clarify)", async () => {
    const { handle, sent, calls } = harness({ scheduleAdd: () => ({ ok: false, reason: "unparsed" }) });
    await handle(msg("remind me to call mom at 3"));
    expect(sent[0]).toMatch(/when should i remind you/i);
    expect(calls()).toBe(0); // did NOT run it as an immediate agent task
  });

  it("'remind me to X tonight' (vague time) ASKS instead of running now", async () => {
    const { handle, sent, calls } = harness({ scheduleAdd: () => ({ ok: false, reason: "unparsed" }) });
    await handle(msg("remind me to take the trash out tonight"));
    expect(sent[0]).toMatch(/when should i remind you/i);
    expect(calls()).toBe(0);
  });

  it("capped scheduling tells the user, no agent", async () => {
    const { handle, sent, calls } = harness({
      scheduleAdd: () => ({ ok: false, reason: "capped" }),
    });
    await handle(msg("remind me to nap in 5 min"));
    expect(sent[0]).toMatch(/limit/i);
    expect(calls()).toBe(0);
  });

  it("a 'watch <name>: <task>' with a cadence word is NOT hijacked by the scheduler (product-loop)", async () => {
    // "watch daily: btc price" contains "daily" — the NL scheduler must NOT intercept it; it has to
    // reach the alertDefine branch. scheduleAdd must not be called; the agent path (which the alert
    // define lives on in this harness) handles it. Here we assert scheduleAdd was NOT invoked.
    const added: Array<{ text: string }> = [];
    const { handle } = harness({ scheduleAdd: (_c, text) => { added.push({ text }); return { ok: true, kind: "daily", task: "x", whenMs: 0 }; } });
    await handle(msg("watch daily: btc price when it changes by 1000"));
    expect(added).toHaveLength(0); // scheduler did not swallow the watch command
  });

  it("a 'save <name>: <task>' with 'every morning' in it is NOT hijacked by the scheduler", async () => {
    const added: Array<{ text: string }> = [];
    const { handle } = harness({ scheduleAdd: (_c, text) => { added.push({ text }); return { ok: true, kind: "daily", task: "x", whenMs: 0 }; } });
    await handle(msg("save morning-brief: every morning summary of the news"));
    expect(added).toHaveLength(0);
  });

  it("weekly + interval phrasings REACH scheduleAdd (recurring-schedules gate fix)", async () => {
    for (const text of ["every monday tell me the news", "every 2 hours check btc", "every weekday at 8 stand up", "weekends brunch spots"]) {
      const added: string[] = [];
      const { handle } = harness({ scheduleAdd: (_c, t) => { added.push(t); return { ok: true, kind: "weekly", task: t, whenMs: 0 }; } });
      await handle(msg(text));
      expect(added, `"${text}" should reach scheduleAdd`).toHaveLength(1);
    }
  });

  it("absolute clock-time phrasings REACH scheduleAdd (at 6pm / at 14:30 / tomorrow at 9am)", async () => {
    for (const text of ["text me the headlines at 6pm", "send the weather tomorrow at 9am", "at 14:30 ping me the news"]) {
      const added: string[] = [];
      const { handle } = harness({ scheduleAdd: (_c, t) => { added.push(t); return { ok: true, kind: "once", task: t, whenMs: 0 }; } });
      await handle(msg(text));
      expect(added, `"${text}" should reach scheduleAdd`).toHaveLength(1);
    }
  });

  it("'save that as daily' is NOT hijacked into a junk schedule (reaches the save-that-as branch)", async () => {
    const added: string[] = [];
    const { handle } = harness({ scheduleAdd: (_c, t) => { added.push(t); return { ok: true, kind: "daily", task: t, whenMs: 0 }; } });
    await handle(msg("save that as daily"));
    expect(added).toHaveLength(0); // the cadence-word name did NOT get scheduled
  });

  it("'set a reminder ... over/by ...' (no number) still schedules — not mistaken for an alert-edit (audit 19)", async () => {
    const added: string[] = [];
    const { handle } = harness({ scheduleAdd: (_c, t) => { added.push(t); return { ok: true, kind: "once", task: t, whenMs: 0 }; } });
    await handle(msg("set a reminder to hand over the keys tomorrow at 9am"));
    expect(added).toHaveLength(1); // "over" without a number is NOT an alert-edit -> reaches scheduler
  });

  it("'/remind me ... in 10 min' (stray slash) still reaches scheduleAdd (command-intent-recovery)", async () => {
    const added: Array<{ text: string }> = [];
    const { handle } = harness({ scheduleAdd: (_c, text) => { added.push({ text }); return { ok: true, kind: "once", task: "stretch", whenMs: 0 }; } });
    await handle(msg("/remind me to stretch in 10 min"));
    expect(added).toHaveLength(1);
    expect(added[0]!.text).toBe("remind me to stretch in 10 min"); // slash stripped, routed as NL
  });

  it("a bare unknown command suggests the nearest real one, no agent", async () => {
    const { handle, sent, calls } = harness();
    await handle(msg("/schedule"));
    expect(sent[0]).toMatch(/did you mean \/schedules/i);
    expect(calls()).toBe(0);
  });

  it("a bare 'at 5' (no am/pm, no colon) does NOT trigger the scheduler", async () => {
    const added: string[] = [];
    const { handle, calls } = harness({ scheduleAdd: (_c, t) => { added.push(t); return { ok: true, kind: "once", task: t, whenMs: 0 }; } });
    await handle(msg("look at 5 tabs and summarize them"));
    expect(added).toHaveLength(0); // not cued -> goes to the agent
    expect(calls()).toBe(1);
  });

  it("a plain reminder that merely starts with 'set' still schedules (guard not too broad)", async () => {
    const added: Array<{ text: string }> = [];
    const { handle } = harness({ scheduleAdd: (_c, text) => { added.push({ text }); return { ok: true, kind: "once", task: "call mom", whenMs: 0 }; } });
    await handle(msg("set a reminder to call mom in 10 min"));
    expect(added).toHaveLength(1); // NOT excluded — it's a real schedule, not an alert-edit shape
  });

  it("scheduling a slotted recipe is refused with a clear reason, no agent (product-loop)", async () => {
    const { handle, sent, calls } = harness({
      recipeSchedule: () => ({ ok: false, reason: "needsarg" }),
    });
    await handle(msg("schedule track every morning"));
    expect(sent[0]).toMatch(/fill-in value|\{\.\.\.\}|can't run on a schedule/i);
    expect(calls()).toBe(0);
  });

  it("a bare \"done\" acknowledges + stops a sticky reminder, no agent (sticky-acknowledged-reminders)", async () => {
    const { handle, sent, calls } = harness({ stickyAck: () => ["take my meds"] });
    await handle(msg("done"));
    expect(sent[0]).toMatch(/stopped reminding you about "take my meds"/i);
    expect(calls()).toBe(0); // handled before the agent
  });

  it("a \"done\" with no active sticky reminder falls through to the agent (not swallowed)", async () => {
    const { handle, calls } = harness({ stickyAck: () => [] }); // nothing to ack
    await handle(msg("done"));
    expect(calls()).toBe(1); // reached the agent as a normal message
  });

  it("\"keep reminding me ... every 15 min\" confirms with the sticky wording", async () => {
    const { handle, sent, calls } = harness({
      scheduleAdd: () => ({ ok: true, kind: "interval", task: "take my meds", whenMs: 0, sticky: true }),
    });
    await handle(msg("keep reminding me to take my meds every 15 min"));
    expect(sent[0]).toMatch(/keep reminding you.*done/i);
    expect(calls()).toBe(0);
  });

  it("/schedules lists pending tasks, no agent", async () => {
    const { handle, sent, calls } = harness();
    await handle(msg("/schedules"));
    expect(sent[0]).toMatch(/stretch/);
    expect(sent[0]).toMatch(/s1/);
    expect(calls()).toBe(0);
  });

  it("/schedules with none gives a helpful hint", async () => {
    const { handle, sent } = harness({ scheduleList: () => [] });
    await handle(msg("/schedules"));
    expect(sent[0]).toMatch(/No scheduled tasks/i);
  });

  it("/cancel all removes everything", async () => {
    const { handle, sent } = harness();
    await handle(msg("/cancel all"));
    expect(sent[0]).toMatch(/Cancelled 2/);
  });

  it("/cancel <id> removes one", async () => {
    const { handle, sent } = harness();
    await handle(msg("/cancel s1"));
    expect(sent[0]).toMatch(/Cancelled 1/);
  });

  it("/cancel with no match reports it", async () => {
    const { handle, sent } = harness({ scheduleCancel: () => ({ removed: 0 }) });
    await handle(msg("/cancel s9"));
    expect(sent[0]).toMatch(/Nothing matched/i);
  });

  it("without schedule deps wired, 'remind me' just goes to the agent", async () => {
    const { handle, calls } = harness({ scheduleAdd: undefined });
    await handle(msg("remind me to stretch in 10 min"));
    expect(calls()).toBe(1);
  });
});

describe("handler — snooze/resume routing (snooze-automations)", () => {
  it("\"pause btc for 2 days\" routes to scheduleSnooze + confirms, no agent, no scheduleAdd", async () => {
    const added: Array<{ chatId: number; text: string }> = [];
    const { handle, sent, calls } = harness({
      scheduleAdd: (chatId, text) => { added.push({ chatId, text }); return { ok: true, kind: "once", task: "x", whenMs: 0 }; },
      scheduleSnooze: (_c, _t) => ({ action: "pause", count: 1, which: "btc", untilText: "Tue 9am" }),
    });
    await handle(msg("pause btc for 2 days", 5));
    expect(sent[0]).toMatch(/Paused "btc" until Tue 9am/);
    expect(added).toHaveLength(0); // NOT misread as a new reminder
    expect(calls()).toBe(0);
  });

  it("\"resume btc\" confirms the resume", async () => {
    const { handle, sent } = harness({ scheduleSnooze: () => ({ action: "resume", count: 1, which: "btc" }) });
    await handle(msg("resume btc", 5));
    expect(sent[0]).toMatch(/Resumed "btc"/);
  });

  it("an unknown name (count 0) tells the user it couldn't find it", async () => {
    const { handle, sent } = harness({ scheduleSnooze: () => ({ action: "pause", count: 0, which: "nonesuch" }) });
    await handle(msg("snooze nonesuch", 5));
    expect(sent[0]).toMatch(/couldn't find "nonesuch"/i);
  });

  it("an indefinite pause says 'until you resume it'", async () => {
    const { handle, sent } = harness({ scheduleSnooze: () => ({ action: "pause", count: 1, which: "morning digest" }) });
    await handle(msg("pause my morning digest", 5));
    expect(sent[0]).toMatch(/until you resume it/);
  });

  it("a non-snooze message falls through (scheduleSnooze returns null)", async () => {
    const { handle, added, calls } = harness({ scheduleSnooze: () => null });
    await handle(msg("remind me to stretch in 10 min", 5));
    expect(added).toHaveLength(1); // still scheduled normally
    expect(calls()).toBe(0);
  });
});

describe("handler — /dashboard routing (unified-dashboard)", () => {
  it("/dashboard sends the dashboardView string, no agent", async () => {
    const { handle, sent, calls } = harness({ dashboardView: (c) => `DASH for ${c}` });
    await handle(msg("/dashboard", 5));
    expect(sent[0]).toBe("DASH for 5");
    expect(calls()).toBe(0);
  });
  it("/dash alias also works", async () => {
    const { handle, sent } = harness({ dashboardView: () => "DASH" });
    await handle(msg("/dash", 5));
    expect(sent[0]).toBe("DASH");
  });
});
