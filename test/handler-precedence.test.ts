import { describe, it, expect } from "vitest";
import { createHandler, type HandlerDeps } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";

// DEV-0174: the schedule keyword-regex (handler.ts:137: remind me|every day|every morning|...|in N
// min) is evaluated BEFORE the alert/digest/save branches, and only falls through when scheduleAdd
// returns reason:"unparsed". A message that is really an alert/digest/save but contains a schedule
// word ("alert me on btc: every day") depends entirely on scheduleAdd rejecting it — if scheduleAdd
// wrongly claimed ok, the intended command would be silently shadowed. Pin the fall-through: with
// scheduleAdd -> unparsed, such a message reaches the CORRECT downstream handler.

function harness(over: Partial<HandlerDeps> = {}) {
  const sent: string[] = [];
  const calls = { schedule: 0, alert: 0, digest: 0, save: 0, agent: 0 };
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
    runAgentFn: async () => { calls.agent++; return { reply: "agent", steps: 1, tools: [] }; },
    // scheduleAdd rejects everything as unparsed → forces the fall-through path.
    scheduleAdd: () => { calls.schedule++; return { ok: false, reason: "unparsed" }; },
    alertDefine: (_c, _t) => { calls.alert++; return { ok: true, name: "btc" }; },
    digestDefine: (_c, _t) => { calls.digest++; return { ok: true, name: "morning", members: 2 }; },
    recipeSave: (_c, _t) => { calls.save++; return { ok: true, name: "btc" }; },
    ...over,
  };
  return { handle: createHandler(deps), sent, calls };
}
const msg = (text: string): InboundMessage => ({ chatId: 1, from: "u", text } as InboundMessage);

describe("handler command precedence (DEV-0174)", () => {
  it("'alert me on btc: every day' → alertDefine (schedule word doesn't shadow it)", async () => {
    const { handle, calls } = harness();
    await handle(msg("alert me on btc: every day"));
    expect(calls.schedule).toBe(1);   // schedule regex matched + tried first
    expect(calls.alert).toBe(1);      // ...then fell through to the real handler
    expect(calls.agent).toBe(0);
  });

  it("'define digest morning: hn every morning' → digestDefine", async () => {
    const { handle, calls } = harness();
    await handle(msg("define digest morning: hn every morning"));
    expect(calls.digest).toBe(1);
    expect(calls.agent).toBe(0);
  });

  it("'save daily-btc: check btc every day' → recipeSave", async () => {
    const { handle, calls } = harness();
    await handle(msg("save daily-btc: check btc every day"));
    expect(calls.save).toBe(1);
    expect(calls.agent).toBe(0);
  });

  it("a genuine 'remind me ... in 5 min' is claimed by scheduleAdd (ok), not passed on", async () => {
    const { handle, calls } = harness({
      scheduleAdd: () => { calls.schedule++; return { ok: true, kind: "once", task: "x", whenMs: 0 }; },
    });
    await handle(msg("remind me to stretch in 5 min"));
    expect(calls.schedule).toBe(1);
    expect(calls.alert + calls.digest + calls.save + calls.agent).toBe(0);
  });
});
