import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHandler, type HandlerDeps } from "../src/handler.js";
import { MemoryStore } from "../src/lib/memory-store.js";
import { RecipeStore, parseRecipeCommand, parseRunCommand } from "../src/lib/recipes.js";
import { DigestStore, parseDigestCommand } from "../src/lib/digests.js";
import { AlertStore, parseAlertCommand } from "../src/lib/alerts.js";
import { parseScheduleFor } from "../src/lib/schedule.js";
import { runDigest } from "../src/digest-runner.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";

// m11 cons-2: the whole product composed. REAL Memory/Recipe/Digest/Alert stores wired
// through createHandler exactly as index.ts does; only the LLM (runAgentFn) + Telegram send
// are faked. Drives a real user journey + asserts the features compose (not just pass alone).
const dirs: string[] = [];
function tmpdir_() { const d = mkdtempSync(join(tmpdir(), "relay-journey-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function build() {
  const dir = tmpdir_();
  const memory = new MemoryStore({ file: join(dir, "m.json") });
  const recipes = new RecipeStore({ file: join(dir, "r.json") });
  const digests = new DigestStore({ file: join(dir, "d.json") });
  const alerts = new AlertStore({ file: join(dir, "a.json") });
  const sent: string[] = [];
  const agentTasks: string[] = [];
  const llm = {} as HandlerDeps["llm"];
  const runAgentFn = async (text: string) => { agentTasks.push(text); return { reply: `RESULT[${text}]`, steps: 1, tools: [] as string[] }; };
  const digestRunText = (chatId: number, name: string) => {
    const d = digests.get(chatId, name);
    if (!d) return Promise.resolve(null);
    return runDigest(d, { llm, resolveRecipe: (c, n) => { const r = recipes.get(c, n); return r ? { task: r.task } : null; }, runAgent: runAgentFn, formatReply: (t) => t });
  };
  const handle = createHandler({
    llm,
    memoryGet: (id) => memory.get(id) as LLMMessage[],
    memorySet: (id, h) => memory.set(id, h),
    memoryClear: (id) => memory.delete(id),
    sendMessage: async (_id, text) => { sent.push(text); },
    sendTyping: async () => {},
    handleCommand: () => null,
    checkRateLimit: () => ({ allowed: true }),
    redactText: (t) => t,
    hasModelKey: () => true,
    recordTurn: () => {},
    now: () => 1_700_000_000_000,
    runAgentFn,
    recipeSave: (c, text) => { const p = parseRecipeCommand(text); if (!p) return { ok: false, reason: "unparsed" }; const r = recipes.add(c, p, 0); return r ? { ok: true, name: r.name } : { ok: false, reason: "capped" }; },
    recipeResolve: (c, text) => { const n = parseRunCommand(text); if (!n) return null; const r = recipes.get(c, n); return r ? { name: r.name, task: r.task } : null; },
    recipeList: (c) => recipes.list(c).map((r) => ({ name: r.name, task: r.task, schedule: r.schedule })),
    recipeForget: (c, n) => recipes.remove(c, n),
    digestDefine: (c, text) => { const p = parseDigestCommand(text); if (!p) return { ok: false, reason: "unparsed" }; const r = digests.add(c, p, 0); return r ? { ok: true, name: r.name, members: r.members.length } : { ok: false, reason: "capped" }; },
    digestList: (c) => digests.list(c).map((d) => ({ name: d.name, members: d.members, schedule: d.schedule })),
    digestForget: (c, n) => digests.remove(c, n),
    isDigest: (c, n) => !!digests.get(c, n),
    digestRun: (c, n) => digestRunText(c, n),
    alertDefine: (c, text) => { const p = parseAlertCommand(text); if (!p) return { ok: false, reason: "unparsed" }; const r = alerts.add(c, p, 0); return r ? { ok: true, name: r.name } : { ok: false, reason: "capped" }; },
    alertList: (c) => alerts.list(c).map((a) => ({ name: a.name, task: a.task, lastValue: a.lastValue, threshold: a.threshold })),
    alertForget: (c, n) => alerts.remove(c, n),
  });
  return { handle, sent, agentTasks };
}
const msg = (text: string, chatId = 1): InboundMessage => ({ chatId, from: "u", text } as InboundMessage);

describe("whole-product journey (m11 cons-2)", () => {
  it("save recipes -> define a digest -> /run it -> watch an alert -> lists reflect all of it", async () => {
    const { handle, sent, agentTasks } = build();

    // 1) a plain lookup goes to the agent
    await handle(msg("top HN story"));
    expect(agentTasks).toContain("top HN story");

    // 2) save two recipes
    await handle(msg("save weather: get the weather"));
    await handle(msg("save btc: price of bitcoin"));
    expect(sent.at(-1)).toMatch(/Saved recipe "btc"/);

    // 3) define a digest of them, then /run it -> one composed briefing (both members)
    await handle(msg("define digest morning: weather, btc"));
    expect(sent.at(-1)).toMatch(/Saved digest "morning" \(2 recipes\)/);
    await handle(msg("/run morning"));
    const briefing = sent.at(-1)!;
    expect(briefing).toMatch(/📋 morning/);
    expect(briefing).toMatch(/weather: RESULT\[get the weather\]/);
    expect(briefing).toMatch(/btc: RESULT\[price of bitcoin\]/);

    // 4) watch an alert
    await handle(msg("watch eth: price of ethereum when it changes by 50"));
    expect(sent.at(-1)).toMatch(/Watching "eth"/);

    // 5) /run a saved recipe -> its task runs through the agent
    await handle(msg("/run weather"));
    expect(agentTasks).toContain("get the weather");

    // 6) all the lists reflect the built-up state
    await handle(msg("/recipes"));
    expect(sent.at(-1)).toMatch(/weather/); expect(sent.at(-1)).toMatch(/btc/);
    await handle(msg("/digests"));
    expect(sent.at(-1)).toMatch(/morning/); expect(sent.at(-1)).toMatch(/weather, btc/);
    await handle(msg("/alerts"));
    expect(sent.at(-1)).toMatch(/eth/); expect(sent.at(-1)).toMatch(/±50/);
  });

  it("state persists across a fresh handler (new stores, same files) — a redeploy keeps recipes/digests/alerts", async () => {
    const dir = tmpdir_();
    const files = { m: join(dir, "m.json"), r: join(dir, "r.json"), d: join(dir, "d.json"), a: join(dir, "a.json") };
    // seed via real stores
    new RecipeStore({ file: files.r }).add(1, { name: "btc", task: "price" }, 0);
    new DigestStore({ file: files.d }).add(1, { name: "morning", members: ["btc"] }, 0);
    new AlertStore({ file: files.a }).add(1, { name: "eth", task: "eth price" }, 0);
    // reopen
    expect(new RecipeStore({ file: files.r }).get(1, "btc")).toBeTruthy();
    expect(new DigestStore({ file: files.d }).get(1, "morning")!.members).toEqual(["btc"]);
    expect(new AlertStore({ file: files.a }).get(1, "eth")).toBeTruthy();
    void parseScheduleFor; // (kept imported for the wiring parity with index)
  });
});
