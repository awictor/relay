import { describe, it, expect } from "vitest";
import { createHandler, type HandlerDeps } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";
import { encodeCallback } from "../src/lib/callbacks.js";

// inline-tap-buttons: a callback InboundMessage (a tapped button) is routed to the bounded action,
// acked, and never runs the agent flow. Offline via injected deps.
function harness(over: Partial<HandlerDeps> = {}) {
  const sent: Array<{ text: string; hasButtons: boolean }> = [];
  const acked: Array<string | undefined> = [];
  let agentCalls = 0;
  const deps: HandlerDeps = {
    llm: {} as HandlerDeps["llm"],
    memoryGet: () => [] as LLMMessage[], memorySet: () => {}, memoryClear: () => false,
    sendMessage: async (_id, text, kb) => { sent.push({ text, hasButtons: !!kb }); },
    answerCallback: async (_id, toast) => { acked.push(toast); },
    sendTyping: async () => {},
    handleCommand: () => null,
    checkRateLimit: () => ({ allowed: true }),
    redactText: (t) => t, hasModelKey: () => true, recordTurn: () => {}, now: () => 0,
    runAgentFn: async () => { agentCalls++; return { reply: "x", steps: 1, tools: [] }; },
    ...over,
  };
  return { handle: createHandler(deps), sent, acked, calls: () => agentCalls };
}
const tap = (data: string, chatId = 1): InboundMessage =>
  ({ chatId, from: "u", text: "", messageId: 0, callback: { data, callbackQueryId: "q1" } } as InboundMessage);

describe("handler — inline-button callbacks", () => {
  it("alert Refresh: fires the check, sends result + buttons, acks", async () => {
    let committed = false;
    const { handle, sent, acked, calls } = harness({
      alertRunNow: async () => ({ message: "🔔 btc crossed $65k", commit: () => { committed = true; } }),
    });
    await handle(tap(encodeCallback({ kind: "alert", action: "refresh", name: "btc" })!));
    expect(sent[0]!.text).toMatch(/crossed/);
    expect(sent[0]!.hasButtons).toBe(true);
    expect(committed).toBe(true);
    expect(acked[0]).toMatch(/Refreshed/);
    expect(calls()).toBe(0);
  });

  it("alert Refresh with no change says so + commits", async () => {
    let committed = false;
    const { handle, sent, acked } = harness({
      alertRunNow: async () => ({ message: null, commit: () => { committed = true; } }),
    });
    await handle(tap(encodeCallback({ kind: "alert", action: "refresh", name: "btc" })!));
    expect(sent[0]!.text).toMatch(/no change/i);
    expect(committed).toBe(true);
    expect(acked[0]).toMatch(/No change/);
  });

  it("alert Snooze pauses the watch 1 day", async () => {
    const calls: string[] = [];
    const { handle, sent, acked } = harness({
      scheduleSnooze: (_c, text) => { calls.push(text); return { action: "pause", count: 1, which: "btc", untilText: "tomorrow 9am" }; },
    });
    await handle(tap(encodeCallback({ kind: "alert", action: "snooze", name: "btc" })!));
    expect(calls[0]).toMatch(/snooze btc 1 day/);
    expect(sent[0]!.text).toMatch(/Snoozed "btc"/);
    expect(acked[0]).toMatch(/Snoozed/);
  });

  it("alert Stop forgets the watch", async () => {
    let forgot = "";
    const { handle, sent, acked } = harness({ alertForget: (_c, name) => { forgot = name; return true; } });
    await handle(tap(encodeCallback({ kind: "alert", action: "stop", name: "btc" })!));
    expect(forgot).toBe("btc");
    expect(sent[0]!.text).toMatch(/Stopped watching "btc"/);
    expect(acked[0]).toMatch(/Stopped/);
  });

  it("digest Run again composes + sends with a Run-again button", async () => {
    const { handle, sent, acked } = harness({ digestRun: async () => "☀️ Morning brief: ..." });
    await handle(tap(encodeCallback({ kind: "digest", action: "run", name: "morning" })!));
    expect(sent[0]!.text).toMatch(/Morning brief/);
    expect(sent[0]!.hasButtons).toBe(true);
    expect(acked[0]).toMatch(/Done/);
  });

  it("recipe Run again runs by name", async () => {
    let ran = "";
    const { handle, sent } = harness({ recipeRunByName: async (_c, name) => { ran = name; return "flight found: $220"; } });
    await handle(tap(encodeCallback({ kind: "recipe", action: "run", name: "flights" })!));
    expect(ran).toBe("flights");
    expect(sent[0]!.text).toMatch(/flight found/);
  });

  it("a stale/garbage payload is handled gracefully, no agent", async () => {
    const { handle, sent, acked, calls } = harness();
    await handle(tap("zz|nope"));
    expect(sent[0]!.text).toMatch(/no longer valid/i);
    expect(acked[0]).toMatch(/Expired/);
    expect(calls()).toBe(0);
  });

  it("rate-limited tap does not act", async () => {
    let refreshed = false;
    const { handle, acked } = harness({
      checkRateLimit: () => ({ allowed: false, retryAfterSec: 9 }),
      alertRunNow: async () => { refreshed = true; return { message: "x", commit: () => {} }; },
    });
    await handle(tap(encodeCallback({ kind: "alert", action: "refresh", name: "btc" })!));
    expect(refreshed).toBe(false);
    expect(acked[0]).toMatch(/Slow down/);
  });
});
