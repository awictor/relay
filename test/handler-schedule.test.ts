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

  it("\"every morning ...\" routes to scheduleAdd as daily", async () => {
    const { handle, sent } = harness({
      scheduleAdd: () => ({ ok: true, kind: "daily", task: "weather", whenMs: 0 }),
    });
    await handle(msg("every morning tell me the weather"));
    expect(sent[0]).toMatch(/daily/i);
  });

  it("an unparsed 'remind' request falls through to the agent", async () => {
    const { handle, calls } = harness({
      scheduleAdd: () => ({ ok: false, reason: "unparsed" }),
    });
    await handle(msg("remind me why the sky is blue")); // no time clause
    expect(calls()).toBe(1); // agent handled it
  });

  it("capped scheduling tells the user, no agent", async () => {
    const { handle, sent, calls } = harness({
      scheduleAdd: () => ({ ok: false, reason: "capped" }),
    });
    await handle(msg("remind me to nap in 5 min"));
    expect(sent[0]).toMatch(/limit/i);
    expect(calls()).toBe(0);
  });

  it("scheduling a slotted recipe is refused with a clear reason, no agent (product-loop)", async () => {
    const { handle, sent, calls } = harness({
      recipeSchedule: () => ({ ok: false, reason: "needsarg" }),
    });
    await handle(msg("schedule track every morning"));
    expect(sent[0]).toMatch(/fill-in value|\{\.\.\.\}|can't run on a schedule/i);
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
