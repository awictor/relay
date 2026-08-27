import { describe, it, expect } from "vitest";
import { createHandler, type HandlerDeps } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";

// m9 digest-3: handler routes define/list/run/schedule for digests, dispatching digest vs
// recipe by name. A /run <digest> sends the composed briefing (no agent rewrite).
function harness(over: Partial<HandlerDeps> = {}) {
  const sent: string[] = [];
  const agentTexts: string[] = [];
  const digestRuns: string[] = [];
  const deps: HandlerDeps = {
    llm: {} as HandlerDeps["llm"],
    memoryGet: () => [] as LLMMessage[], memorySet: () => {}, memoryClear: () => false,
    sendMessage: async (_id, text) => { sent.push(text); },
    sendTyping: async () => {},
    handleCommand: () => null,
    checkRateLimit: () => ({ allowed: true }),
    redactText: (t) => t, hasModelKey: () => true, recordTurn: () => {}, now: () => 0,
    runAgentFn: async (text) => { agentTexts.push(text); return { reply: `ran:${text}`, steps: 1, tools: [] }; },
    // recipe deps (for dispatch fallthrough)
    recipeResolve: (_c, text) => text.includes("btc") ? { name: "btc", task: "btc price" } : null,
    // digest deps
    digestDefine: (_c, text) => text.includes("cap") ? { ok: false, reason: "capped" } : { ok: true, name: "morning", members: 3 },
    digestList: () => [{ name: "morning", members: ["weather", "hn", "btc"], schedule: undefined }],
    digestForget: (_c, name) => name === "morning",
    isDigest: (_c, name) => name === "morning",
    digestRun: async (_c, name) => name === "morning" ? "📋 morning\n• weather: sunny\n• btc: $65k" : null,
    digestSchedule: (_c, _n, _w) => ({ ok: true, kind: "daily" }),
    ...over,
  };
  return { handle: createHandler(deps), sent, agentTexts, digestRuns };
}
const msg = (text: string, chatId = 1): InboundMessage => ({ chatId, from: "u", text } as InboundMessage);

describe("handler — digest routing", () => {
  it("'define digest ...' stores + confirms, no agent", async () => {
    const { handle, sent, agentTexts } = harness();
    await handle(msg("define digest morning: weather, hn, btc"));
    expect(sent[0]).toMatch(/Saved digest "morning" \(3 recipes\)/);
    expect(agentTexts).toHaveLength(0);
  });

  it("/digests lists digests", async () => {
    const { handle, sent } = harness();
    await handle(msg("/digests"));
    expect(sent[0]).toMatch(/morning/);
    expect(sent[0]).toMatch(/weather, hn, btc/);
  });

  it("/run <digest> sends the composed briefing, NOT via the agent", async () => {
    const { handle, sent, agentTexts } = harness();
    await handle(msg("/run morning"));
    expect(sent[0]).toMatch(/📋 morning/);
    expect(sent[0]).toMatch(/weather: sunny/);
    expect(agentTexts).toHaveLength(0); // digest composed directly, not an agent run
  });

  it("/run <recipe> (not a digest) still rewrites to the recipe task -> agent", async () => {
    const { handle, agentTexts } = harness();
    await handle(msg("/run btc"));
    expect(agentTexts).toEqual(["btc price"]);
  });

  it("DEV-0130: explicit 'run recipe <name>' runs the recipe even when a same-named digest exists", async () => {
    // "morning" is BOTH a digest (isDigest) and a recipe here. Bare /run runs the digest;
    // the explicit "recipe" keyword must bypass the digest-first branch to the recipe.
    const recipeResolve = (_c: number, text: string) =>
      /morning/.test(text) ? { name: "morning", task: "morning recipe task" } : null;
    const { handle, sent, agentTexts } = harness({ recipeResolve });
    await handle(msg("/run recipe morning"));
    expect(agentTexts).toEqual(["morning recipe task"]); // ran the recipe, not the digest
    expect(sent.some((s) => /📋 morning/.test(s))).toBe(false); // digest NOT composed
  });

  it("DEV-0130: bare '/run <name>' still runs the same-named digest (digest-first preserved)", async () => {
    const recipeResolve = (_c: number, text: string) =>
      /morning/.test(text) ? { name: "morning", task: "morning recipe task" } : null;
    const { handle, sent, agentTexts } = harness({ recipeResolve });
    await handle(msg("/run morning"));
    expect(sent[0]).toMatch(/📋 morning/); // digest wins on a bare name
    expect(agentTexts).toHaveLength(0);
  });

  it("schedule <digest> dispatches to digestSchedule", async () => {
    const { handle, sent } = harness();
    await handle(msg("schedule morning every morning"));
    expect(sent[0]).toMatch(/Scheduled "morning" to run daily/);
  });

  it("DEV-0131: 'schedule recipe <name>' dispatches to recipeSchedule even when a same-named digest exists", async () => {
    // "morning" is a digest (isDigest). Bare schedule hits digestSchedule; the explicit
    // "recipe" keyword must route to recipeSchedule instead.
    const calls: string[] = [];
    const { handle, sent } = harness({
      digestSchedule: (_c, n) => { calls.push(`digest:${n}`); return { ok: true, kind: "daily" }; },
      recipeSchedule: (_c, n) => { calls.push(`recipe:${n}`); return { ok: true, kind: "daily" }; },
    });
    await handle(msg("schedule recipe morning every morning"));
    expect(calls).toEqual(["recipe:morning"]); // recipe scheduled, digest NOT touched
    expect(sent[0]).toMatch(/Scheduled "morning" to run daily/);
  });

  it("DEV-0131: bare 'schedule <name>' still dispatches to digestSchedule (digest-first preserved)", async () => {
    const calls: string[] = [];
    const { handle } = harness({
      digestSchedule: (_c, n) => { calls.push(`digest:${n}`); return { ok: true, kind: "daily" }; },
      recipeSchedule: (_c, n) => { calls.push(`recipe:${n}`); return { ok: true, kind: "daily" }; },
    });
    await handle(msg("schedule morning every morning"));
    expect(calls).toEqual(["digest:morning"]);
  });

  it("/forget-digest removes", async () => {
    const { handle, sent } = harness();
    await handle(msg("/forget-digest morning"));
    expect(sent[0]).toMatch(/Forgot digest "morning"/);
  });

  it("capped define warns", async () => {
    const { handle, sent } = harness();
    await handle(msg("define digest cap: a, b"));
    expect(sent[0]).toMatch(/digest limit/i);
  });
});
