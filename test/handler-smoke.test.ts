import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHandler } from "../src/handler.js";
import { MemoryStore } from "../src/lib/memory-store.js";
import { Metrics } from "../src/lib/metrics.js";
import { handleCommand } from "../src/commands.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";

// Smoke test: the REAL MemoryStore + Metrics + handleCommand wired through createHandler,
// only the LLM (via runAgentFn) and Telegram send faked. Catches cross-module wiring drift
// the unit tests miss (they fake memory). Asserts a 2-message conversation: turn 1 persists,
// turn 2's agent sees turn 1's history.

const dirs: string[] = [];
function tmpFile() { const d = mkdtempSync(join(tmpdir(), "relay-smoke-")); dirs.push(d); return join(d, "mem.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const msg = (text: string, chatId = 99): InboundMessage => ({ chatId, from: "u", text } as InboundMessage);

describe("handler smoke (real memory + metrics + commands)", () => {
  it("persists turn 1 and feeds it to turn 2; metrics count both", async () => {
    const memory = new MemoryStore({ file: tmpFile() });
    const metrics = new Metrics();
    const sent: string[] = [];
    const historiesSeen: LLMMessage[][] = [];

    const handle = createHandler({
      llm: {} as never,
      memoryGet: (id) => memory.get(id) as LLMMessage[],
      memorySet: (id, h) => memory.set(id, h),
      memoryClear: (id) => memory.delete(id),
      sendMessage: async (_id, text) => { sent.push(text); },
      sendTyping: async () => {},
      handleCommand,                       // real
      checkRateLimit: () => ({ allowed: true }),
      redactText: (t) => t,
      hasModelKey: () => true,
      recordTurn: (t) => metrics.record(t), // real
      now: () => 0,
      // Fake agent: echo, but record the history it was handed so we can assert turn 2 sees turn 1.
      runAgentFn: async (userText, _deps, history) => {
        historiesSeen.push(history);
        return { reply: `echo:${userText}`, steps: 1, tools: ["scrape"] };
      },
      log: () => {},
    });

    await handle(msg("first"));
    await handle(msg("second"));

    // Replies went out in order.
    expect(sent).toEqual(["echo:first", "echo:second"]);
    // Turn 1 saw empty history; turn 2 saw turn 1's user+assistant (from the REAL store).
    expect(historiesSeen[0]).toEqual([]);
    expect(historiesSeen[1]).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "echo:first" },
    ]);
    // Both turns recorded.
    expect(metrics.summary().turns).toBe(2);
    expect(metrics.summary().ok).toBe(2);
    expect(metrics.summary().tools).toEqual({ scrape: 2 });
  });

  it("a real /help command short-circuits before the agent (no turn recorded)", async () => {
    const memory = new MemoryStore({ file: tmpFile() });
    const metrics = new Metrics();
    let agentCalls = 0;
    const sent: string[] = [];
    const handle = createHandler({
      llm: {} as never,
      memoryGet: (id) => memory.get(id) as LLMMessage[],
      memorySet: (id, h) => memory.set(id, h),
      memoryClear: (id) => memory.delete(id),
      sendMessage: async (_id, text) => { sent.push(text); },
      sendTyping: async () => {},
      handleCommand,
      checkRateLimit: () => ({ allowed: true }),
      redactText: (t) => t,
      hasModelKey: () => true,
      recordTurn: (t) => metrics.record(t),
      now: () => 0,
      runAgentFn: async () => { agentCalls++; return { reply: "x", steps: 1, tools: [] }; },
      log: () => {},
    });
    await handle(msg("/help"));
    expect(agentCalls).toBe(0);
    expect(sent[0]).toMatch(/what I can do/i); // real HELP text
    expect(metrics.summary().turns).toBe(0);
  });

  // DEV-0108: slash commands are tallied via recordCommand (a separate axis from turns), and the
  // agent path still records a turn, not a command.
  it("records slash-command usage separately from agent turns", async () => {
    const memory = new MemoryStore({ file: tmpFile() });
    const metrics = new Metrics();
    const handle = createHandler({
      llm: {} as never,
      memoryGet: (id) => memory.get(id) as LLMMessage[],
      memorySet: (id, h) => memory.set(id, h),
      memoryClear: (id) => memory.delete(id),
      sendMessage: async () => {},
      sendTyping: async () => {},
      handleCommand,
      checkRateLimit: () => ({ allowed: true }),
      redactText: (t) => t,
      hasModelKey: () => true,
      recordTurn: (t) => metrics.record(t),
      recordCommand: (name) => metrics.recordCommand(name),
      now: () => 0,
      runAgentFn: async () => ({ reply: "echo", steps: 1, tools: [] }),
      log: () => {},
    });
    await handle(msg("/help"));
    await handle(msg("/reset"));
    await handle(msg("/help@relaybot")); // bot-suffix still normalizes to /help
    await handle(msg("plain question")); // agent turn, NOT a command
    const s = metrics.summary();
    expect(s.commands).toEqual({ "/help": 2, "/reset": 1 });
    expect(s.turns).toBe(1); // only the plain question
  });
});
