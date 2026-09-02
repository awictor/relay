import { describe, it, expect } from "vitest";
import { createHandler, type HandlerDeps } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";

// DEV-0174 + audit-9 B#1: the schedule keyword-regex (remind me|every day|every morning|...|in N
// min) runs BEFORE the alert/digest/save branches. Originally it matched-then-relied on scheduleAdd
// returning "unparsed" to fall through — but scheduleAdd could wrongly claim a define-shaped message
// ("watch daily: btc") and silently shadow the intended command. The matcher now SKIPS command
// shapes (define "<verb> <name>: <task>" + alert-edit "<verb> ... <below|by|...>") outright, so such
// a message reaches its CORRECT downstream branch and never touches scheduleAdd.

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
    // /run routing deps (DEV-0175): "daily-report" is a digest; recipeResolve rewrites a run to a task.
    isDigest: (_c, name) => name === "daily-report",
    digestRun: async (_c, _n) => { (calls as any).run = ((calls as any).run || 0) + 1; return "📋 daily-report\n• x"; },
    recipeResolve: (_c, text) => { if (/morning-brief/.test(text)) { (calls as any).recipe = ((calls as any).recipe || 0) + 1; return { name: "morning-brief", task: "brief task" }; } return null; },
    ...over,
  };
  return { handle: createHandler(deps), sent, calls };
}
const msg = (text: string): InboundMessage => ({ chatId: 1, from: "u", text } as InboundMessage);

describe("handler command precedence (DEV-0174)", () => {
  it("'alert me on btc: every day' → alertDefine (schedule word doesn't shadow it)", async () => {
    const { handle, calls } = harness();
    await handle(msg("alert me on btc: every day"));
    // The NL scheduler now SKIPS a define-shaped message entirely (isDefineShape guard), instead of
    // matching-then-relying-on-scheduleAdd-to-reject — so it never even tries. It reaches alertDefine.
    expect(calls.schedule).toBe(0);
    expect(calls.alert).toBe(1);
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

  // DEV-0175: a /run whose name contains a schedule word must NOT be intercepted by the NL matcher.
  it("'/run daily-report' runs the digest, NOT scheduleAdd (schedule word in the name)", async () => {
    const { handle, calls } = harness();
    await handle(msg("/run daily-report"));
    expect(calls.schedule).toBe(0);           // NL scheduler did NOT intercept the slash-command
    expect((calls as any).run).toBe(1);       // reached the /run digest branch
  });

  it("'run morning-brief' (bare verb + schedule word) reaches the recipe run, not scheduleAdd", async () => {
    const { handle, calls } = harness();
    await handle(msg("run morning-brief"));
    expect(calls.schedule).toBe(0);
    expect((calls as any).recipe).toBe(1);    // recipeResolve rewrote it → agent path
  });
});
