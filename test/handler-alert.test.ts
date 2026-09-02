import { describe, it, expect } from "vitest";
import { createHandler, type HandlerDeps } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";

// m10 alert-3: handler routes watch/define + /alerts + /forget-alert. Define short-circuits
// (no agent); it auto-schedules via the alertDefine dep (index wires the schedule).
function harness(over: Partial<HandlerDeps> = {}) {
  const sent: string[] = [];
  const defined: string[] = [];
  let agentCalls = 0;
  const deps: HandlerDeps = {
    llm: {} as HandlerDeps["llm"],
    memoryGet: () => [] as LLMMessage[], memorySet: () => {}, memoryClear: () => false,
    sendMessage: async (_id, text) => { sent.push(text); },
    sendTyping: async () => {},
    handleCommand: () => null,
    checkRateLimit: () => ({ allowed: true }),
    redactText: (t) => t, hasModelKey: () => true, recordTurn: () => {}, now: () => 0,
    runAgentFn: async () => { agentCalls++; return { reply: "x", steps: 1, tools: [] }; },
    alertDefine: (_c, text) => { if (text.includes("cap")) return { ok: false, reason: "capped" }; defined.push(text); return { ok: true, name: "btc" }; },
    alertList: () => [{ name: "btc", task: "price of bitcoin", lastValue: "$65k", threshold: 1000 }],
    alertForget: (_c, name) => name === "btc",
    ...over,
  };
  return { handle: createHandler(deps), sent, defined, calls: () => agentCalls };
}
const msg = (text: string, chatId = 1): InboundMessage => ({ chatId, from: "u", text } as InboundMessage);

describe("handler — alert routing", () => {
  it("'watch <name>: <task>' defines + confirms, no agent", async () => {
    const { handle, sent, defined, calls } = harness();
    await handle(msg("watch btc: price of bitcoin when it changes by 1000"));
    expect(defined).toHaveLength(1);
    expect(sent[0]).toMatch(/Watching "btc"/);
    expect(calls()).toBe(0);
  });

  it("'alert me <name>: <task>' also defines", async () => {
    const { handle, sent } = harness();
    await handle(msg("alert me page: check example.com"));
    expect(sent[0]).toMatch(/Watching/);
  });

  it("/alerts lists with last value + threshold", async () => {
    const { handle, sent } = harness();
    await handle(msg("/alerts"));
    expect(sent[0]).toMatch(/btc/);
    expect(sent[0]).toMatch(/±1000/);
    expect(sent[0]).toMatch(/last: \$65k/);
  });

  it("/alerts with none gives a hint", async () => {
    const { handle, sent } = harness({ alertList: () => [] });
    await handle(msg("/alerts"));
    expect(sent[0]).toMatch(/No alerts/i);
  });

  it("/forget-alert stops watching", async () => {
    const { handle, sent } = harness();
    await handle(msg("/forget-alert btc"));
    expect(sent[0]).toMatch(/Stopped watching "btc"/);
  });

  it("capped define warns, no agent", async () => {
    const { handle, sent, calls } = harness();
    await handle(msg("watch cap: something"));
    expect(sent[0]).toMatch(/alert limit/i);
    expect(calls()).toBe(0);
  });

  it("runs one check on define and relays it when the predicate already holds (product-loop)", async () => {
    const { handle, sent } = harness({ alertRunNow: async () => "🔔 btc:\n$48,000 (below 50000)" });
    await handle(msg("watch btc: price of bitcoin below 50000"));
    expect(sent[0]).toMatch(/Watching "btc"/); // confirmation first
    expect(sent[1]).toMatch(/48,000/);          // immediate check second
  });

  it("silent immediate check sends only the confirmation", async () => {
    const { handle, sent } = harness({ alertRunNow: async () => null });
    await handle(msg("watch btc: price of bitcoin below 50000"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Watching "btc"/);
  });

  it("a throwing immediate check never breaks the define confirmation", async () => {
    const { handle, sent } = harness({ alertRunNow: async () => { throw new Error("flaky"); } });
    await handle(msg("watch btc: price of bitcoin below 50000"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Watching "btc"/);
  });

  it("a normal message is unaffected", async () => {
    const { handle, calls } = harness();
    await handle(msg("what's the weather"));
    expect(calls()).toBe(1);
  });
});
