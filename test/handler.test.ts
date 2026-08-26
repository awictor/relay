import { describe, it, expect } from "vitest";
import { createHandler, type HandlerDeps } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";

// Build a handler with fakes; capture what got sent / recorded / persisted.
function harness(over: Partial<HandlerDeps> = {}) {
  const sent: Array<{ chatId: number; text: string }> = [];
  const recorded: Array<{ ok: boolean; steps: number; tools: string[] }> = [];
  const mem = new Map<number, LLMMessage[]>();
  const deps: HandlerDeps = {
    llm: {} as HandlerDeps["llm"],
    memoryGet: (id) => mem.get(id) ?? [],
    memorySet: (id, h) => { mem.set(id, h); },
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); },
    sendTyping: async () => {},
    handleCommand: () => null,
    checkRateLimit: () => ({ allowed: true }),
    redactText: (t) => t,
    hasModelKey: () => true,
    recordTurn: (t) => { recorded.push({ ok: t.ok, steps: t.steps, tools: t.tools }); },
    now: () => 0,
    runAgentFn: async () => ({ reply: "hi there", steps: 2, tools: ["scrape"] }),
    log: () => {},
    ...over,
  };
  return { handle: createHandler(deps), sent, recorded, mem };
}

const msg = (text: string, chatId = 1): InboundMessage => ({ chatId, from: "u", text } as InboundMessage);

describe("createHandler", () => {
  it("a slash command short-circuits: replies canned, no agent/memory/metrics", async () => {
    let agentCalled = false;
    const { handle, sent, recorded, mem } = harness({
      handleCommand: (t) => (t === "/help" ? "HELP TEXT" : null),
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("/help"));
    expect(sent).toEqual([{ chatId: 1, text: "HELP TEXT" }]);
    expect(agentCalled).toBe(false);
    expect(recorded).toHaveLength(0);
    expect(mem.size).toBe(0);
  });

  it("a rate-limited chat gets the limit message, no agent", async () => {
    let agentCalled = false;
    const { handle, sent, recorded } = harness({
      checkRateLimit: () => ({ allowed: false, retryAfterSec: 30 }),
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("do a thing"));
    expect(agentCalled).toBe(false);
    expect(sent[0]!.text).toMatch(/30s/);
    expect(recorded).toHaveLength(0);
  });

  it("missing model key -> config message, no agent", async () => {
    let agentCalled = false;
    const { handle, sent } = harness({
      hasModelKey: () => false,
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("weather?"));
    expect(agentCalled).toBe(false);
    expect(sent[0]!.text).toMatch(/not fully configured/i);
  });

  it("a normal message runs the agent, replies, persists memory, records an ok turn", async () => {
    const { handle, sent, recorded, mem } = harness();
    await handle(msg("top HN story", 42));
    expect(sent[0]).toEqual({ chatId: 42, text: "hi there" });
    // memory now has the user + assistant turn
    const h = mem.get(42)!;
    expect(h[h.length - 2]).toEqual({ role: "user", content: "top HN story" });
    expect(h[h.length - 1]).toEqual({ role: "assistant", content: "hi there" });
    expect(recorded).toEqual([{ ok: true, steps: 2, tools: ["scrape"] }]);
  });

  it("an agent error -> friendly reply + a failed turn recorded (no memory write)", async () => {
    const { handle, sent, recorded, mem } = harness({
      runAgentFn: async () => { throw new Error("boom"); },
    });
    await handle(msg("do it", 7));
    expect(sent[0]!.text).toMatch(/something went wrong/i);
    expect(recorded).toEqual([{ ok: false, steps: 0, tools: [] }]);
    expect(mem.has(7)).toBe(false);
  });

  it("a transient model error -> the overloaded hint", async () => {
    const { handle, sent } = harness({
      runAgentFn: async () => { throw new Error("503 UNAVAILABLE high demand"); },
    });
    await handle(msg("go"));
    expect(sent[0]!.text).toMatch(/overloaded/i);
  });
});
