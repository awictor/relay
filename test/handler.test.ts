import { describe, it, expect } from "vitest";
import { createHandler, type HandlerDeps } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";
import { formatReply } from "../src/lib/format-reply.js";

// Build a handler with fakes; capture what got sent / recorded / persisted.
function harness(over: Partial<HandlerDeps> = {}) {
  const sent: Array<{ chatId: number; text: string }> = [];
  const photos: Array<{ chatId: number; len: number; caption?: string }> = [];
  const docs: Array<{ chatId: number; len: number; filename?: string; caption?: string }> = [];
  const recorded: Array<{ ok: boolean; steps: number; tools: string[] }> = [];
  const mem = new Map<number, LLMMessage[]>();
  const deps: HandlerDeps = {
    llm: {} as HandlerDeps["llm"],
    memoryGet: (id) => mem.get(id) ?? [],
    memorySet: (id, h) => { mem.set(id, h); },
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); },
    sendPhoto: async (chatId, bytes, caption) => { photos.push({ chatId, len: bytes.length, caption }); },
    sendDocument: async (chatId, bytes, filename, caption) => { docs.push({ chatId, len: bytes.length, filename, caption }); },
    sendTyping: async () => {},
    handleCommand: () => null,
    memoryClear: (id) => mem.delete(id),
    statusLine: () => "STATUS LINE",
    checkRateLimit: () => ({ allowed: true }),
    redactText: (t) => t,
    hasModelKey: () => true,
    recordTurn: (t) => { recorded.push({ ok: t.ok, steps: t.steps, tools: t.tools }); },
    now: () => 0,
    runAgentFn: async () => ({ reply: "hi there", steps: 2, tools: ["scrape"] }),
    log: () => {},
    ...over,
  };
  return { handle: createHandler(deps), sent, photos, docs, recorded, mem };
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

  it("/reset clears the chat's memory, confirms, and does NOT run the agent (DEV-0023)", async () => {
    let agentCalled = false;
    const { handle, sent, mem } = harness({
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    mem.set(3, [{ role: "user", content: "old" }]);
    await handle(msg("/reset", 3));
    expect(agentCalled).toBe(false);
    expect(mem.has(3)).toBe(false);
    expect(sent[0]!.text).toMatch(/cleared/i);
  });

  it("/clear is an alias for /reset; with no history it says nothing to clear", async () => {
    const { handle, sent, mem } = harness();
    await handle(msg("/clear@relaybot", 9));
    expect(mem.has(9)).toBe(false);
    expect(sent[0]!.text).toMatch(/nothing to clear/i);
  });

  it("/reset clears this chat's memory and confirms, no agent (had history)", async () => {
    let agentCalled = false;
    const { handle, sent, recorded, mem } = harness({
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    mem.set(1, [{ role: "user", content: "old" }]);
    await handle(msg("/reset"));
    expect(agentCalled).toBe(false);
    expect(mem.has(1)).toBe(false);          // wiped
    expect(sent[0]!.text).toMatch(/cleared/i);
    expect(recorded).toHaveLength(0);        // not an agent turn
  });

  it("/reset on an empty chat says nothing-to-clear", async () => {
    const { handle, sent } = harness();
    await handle(msg("/reset", 2));
    expect(sent[0]!.text).toMatch(/nothing to clear/i);
  });

  it("/clear is an alias for /reset", async () => {
    const { handle, sent, mem } = harness();
    mem.set(3, [{ role: "user", content: "x" }]);
    await handle(msg("/clear", 3));
    expect(mem.has(3)).toBe(false);
    expect(sent[0]!.text).toMatch(/cleared/i);
  });

  it("/status replies the health line and does NOT run the agent (DEV-0024)", async () => {
    let agentCalled = false;
    const { handle, sent } = harness({
      statusLine: () => "✅ Relay up 2h 3m · 5 tasks handled · browser connected.",
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("/status", 4));
    expect(agentCalled).toBe(false);
    expect(sent[0]!.text).toMatch(/Relay up/);
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

  it("a screenshot result is sent as a photo with the reply as caption (DEV-0027)", async () => {
    const { handle, sent, photos } = harness({
      runAgentFn: async () => ({ reply: "top of HN", steps: 1, tools: ["screenshot"], photo: new Uint8Array([1, 2, 3, 4]) }),
    });
    await handle(msg("screenshot HN", 11));
    expect(photos).toEqual([{ chatId: 11, len: 4, caption: "top of HN" }]);
    expect(sent).toHaveLength(0); // short caption -> no separate text message
  });

  it("a pdf result is sent as a document with the reply as caption (DEV-0032)", async () => {
    const { handle, sent, docs } = harness({
      runAgentFn: async () => ({ reply: "your PDF", steps: 1, tools: ["pdf"], doc: new Uint8Array([1, 2, 3, 4, 5]) }),
    });
    await handle(msg("pdf of HN", 12));
    expect(docs).toEqual([{ chatId: 12, len: 5, filename: "page.pdf", caption: "your PDF" }]);
    expect(sent).toHaveLength(0);
  });

  // DEV-0082: when the optional sendPhoto/sendDocument dep is absent, a photo/doc result must fall
  // back to a plain text reply (back-compat) — the binary is dropped, not thrown away silently.
  it("a photo result with NO sendPhoto dep falls back to a text reply", async () => {
    const { handle, sent, photos } = harness({
      sendPhoto: undefined,
      runAgentFn: async () => ({ reply: "top of HN", steps: 1, tools: ["screenshot"], photo: new Uint8Array([1, 2, 3, 4]) }),
    });
    await handle(msg("screenshot HN", 13));
    expect(photos).toHaveLength(0);
    expect(sent).toEqual([{ chatId: 13, text: "top of HN" }]);
  });

  it("a doc result with NO sendDocument dep falls back to a text reply", async () => {
    const { handle, sent, docs } = harness({
      sendDocument: undefined,
      runAgentFn: async () => ({ reply: "your PDF", steps: 1, tools: ["pdf"], doc: new Uint8Array([1, 2, 3]) }),
    });
    await handle(msg("pdf of HN", 14));
    expect(docs).toHaveLength(0);
    expect(sent).toEqual([{ chatId: 14, text: "your PDF" }]);
  });

  // DEV-0083: Telegram caps a caption at 1024 chars. A longer reply is sent as a sliced caption on the
  // photo PLUS a separate full-text message, so nothing is truncated away.
  it("a >1024-char reply with a photo sends a sliced caption + the full text separately", async () => {
    // formatReply caps a reply well above 1024, so use a reply that stays long after formatting.
    const long = "word ".repeat(300).trim(); // ~1499 chars of plain text, survives formatReply
    const formatted = formatReply(long);
    expect(formatted.length).toBeGreaterThan(1024); // precondition: still over the caption cap
    const { handle, sent, photos } = harness({
      runAgentFn: async () => ({ reply: long, steps: 1, tools: ["screenshot"], photo: new Uint8Array([9]) }),
    });
    await handle(msg("screenshot HN", 15));
    expect(photos).toHaveLength(1);
    expect(photos[0].caption!.length).toBe(1024); // caption sliced to the cap
    expect(sent).toEqual([{ chatId: 15, text: formatted }]); // full (formatted) text sent as a follow-up
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

  // DEV-0021: the memory-poison guard under a PRE-EXISTING conversation. The error branch is
  // reached AFTER memoryGet but BEFORE memorySet, so a failed turn must leave the prior history
  // exactly as it was — not cleared, not extended with a dangling user/assistant turn.
  it("an error on a chat WITH history leaves the prior history untouched", async () => {
    const prior: LLMMessage[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ];
    const { handle, mem } = harness({
      memoryGet: () => prior,
      runAgentFn: async () => { throw new Error("boom"); },
    });
    await handle(msg("this one fails", 5));
    // memorySet was never called, so the store has no entry for 5 (prior lives in the closure only)
    expect(mem.has(5)).toBe(false);
    // and the prior array itself was not mutated (no half-turn appended)
    expect(prior).toHaveLength(2);
    expect(prior[prior.length - 1]).toEqual({ role: "assistant", content: "earlier reply" });
  });

  it("a failed turn then a successful one: success persists a clean user+assistant pair", async () => {
    let calls = 0;
    const { handle, mem, sent } = harness({
      runAgentFn: async (text) => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { reply: `ok:${text}`, steps: 1, tools: [] };
      },
    });
    await handle(msg("fails", 8));
    await handle(msg("works", 8));
    expect(sent[0]!.text).toMatch(/something went wrong/i);
    expect(sent[1]!.text).toBe("ok:works");
    // memory holds ONLY the successful turn — the failed one left nothing behind
    const h = mem.get(8)!;
    expect(h).toEqual([
      { role: "user", content: "works" },
      { role: "assistant", content: "ok:works" },
    ]);
  });
});
