import { describe, it, expect } from "vitest";
import { createHandler, type HandlerDeps } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";

// Handler recipe routing (m7 recipe-2): save / /recipes / /run / /forget short-circuit,
// and /run rewrites the message to the saved task so it flows through the agent.
function harness(over: Partial<HandlerDeps> = {}) {
  const sent: string[] = [];
  const agentTexts: string[] = [];
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
    now: () => 0,
    runAgentFn: async (text) => { agentTexts.push(text); return { reply: `ran:${text}`, steps: 1, tools: [] }; },
    recipeSave: (_c, text) => text.includes("cap") ? { ok: false, reason: "capped" } : text.includes(":") ? { ok: true, name: "btc" } : { ok: false, reason: "unparsed" },
    recipeResolve: (_c, text) => text.includes("btc") ? { name: "btc", task: "check the price of bitcoin" } : null,
    recipeList: () => [{ name: "btc", task: "check the price of bitcoin", schedule: undefined }],
    recipeForget: (_c, name) => name === "btc",
    ...over,
  };
  return { handle: createHandler(deps), sent, agentTexts };
}
const msg = (text: string, chatId = 1): InboundMessage => ({ chatId, from: "u", text } as InboundMessage);

describe("handler — recipe routing", () => {
  it("'save btc: ...' stores + confirms, no agent", async () => {
    const { handle, sent, agentTexts } = harness();
    await handle(msg("save btc: check the price of bitcoin"));
    expect(sent[0]).toMatch(/Saved recipe "btc"/);
    expect(agentTexts).toHaveLength(0);
  });

  it("a slotted recipe run with no value asks for it, no agent (product-loop)", async () => {
    const { handle, sent, agentTexts } = harness({
      recipeResolve: (_c, _text) => ({ name: "track", missingArg: true as const }),
    });
    await handle(msg("/run track"));
    expect(sent[0]).toMatch(/needs a value/i);
    expect(sent[0]).toMatch(/\/run track <value>/);
    expect(agentTexts).toHaveLength(0);
  });

  it("capped save warns, no agent", async () => {
    const { handle, sent, agentTexts } = harness();
    await handle(msg("save cap: something"));
    expect(sent[0]).toMatch(/recipe limit/i);
    expect(agentTexts).toHaveLength(0);
  });

  it("/recipes lists saved recipes", async () => {
    const { handle, sent } = harness();
    await handle(msg("/recipes"));
    expect(sent[0]).toMatch(/btc/);
    expect(sent[0]).toMatch(/check the price/);
  });

  it("/recipes with none gives a hint", async () => {
    const { handle, sent } = harness({ recipeList: () => [] });
    await handle(msg("/recipes"));
    expect(sent[0]).toMatch(/No saved recipes/i);
  });

  it("/run <name> resolves to the task and runs it through the agent", async () => {
    const { handle, agentTexts } = harness();
    await handle(msg("/run btc"));
    expect(agentTexts).toEqual(["check the price of bitcoin"]); // rewritten to the saved task
  });

  it("/run unknown reports no recipe, no agent", async () => {
    const { handle, sent, agentTexts } = harness({ recipeResolve: () => null });
    await handle(msg("/run nope"));
    expect(sent[0]).toMatch(/No recipe/i);
    expect(agentTexts).toHaveLength(0);
  });

  it("/forget <name> removes", async () => {
    const { handle, sent } = harness();
    await handle(msg("/forget btc"));
    expect(sent[0]).toMatch(/Forgot "btc"/);
  });

  it("/forget unknown reports it", async () => {
    const { handle, sent } = harness({ recipeForget: () => false });
    await handle(msg("/forget nope"));
    expect(sent[0]).toMatch(/No recipe/i);
  });

  // DEV-0114: a bare /forget (no name) must NOT imply the user named a missing recipe — it should
  // show usage, and must not call recipeForget with an empty name.
  it("bare /forget shows usage, not a misleading not-found (recipeForget not called empty)", async () => {
    const seen: string[] = [];
    const { handle, sent } = harness({ recipeForget: (_c, name) => { seen.push(name); return false; } });
    await handle(msg("/forget"));
    expect(sent[0]).toMatch(/usage/i);
    expect(sent[0]).not.toMatch(/No recipe by that name/i);
    expect(seen).toEqual([]); // never invoked with an empty name
  });

  it("a normal message is unaffected by recipe routing", async () => {
    const { handle, agentTexts } = harness();
    await handle(msg("what's the weather"));
    expect(agentTexts).toEqual(["what's the weather"]);
  });
});
