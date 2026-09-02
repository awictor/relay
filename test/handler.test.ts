import { describe, it, expect } from "vitest";
import { createHandler, type HandlerDeps } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";
import { formatReply } from "../src/lib/format-reply.js";
import { NotesStore, parseRemember, parseForgetFact } from "../src/lib/notes.js";
import { parseCityReply } from "../src/lib/profile.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

  it("/sites replies the cookie-hosts line and does NOT run the agent (m30)", async () => {
    let agentCalled = false;
    const { handle, sent } = harness({
      sitesLine: () => "I'm signed in for these sites:\n• example.com",
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("/sites", 4));
    expect(agentCalled).toBe(false);
    expect(sent[0]!.text).toMatch(/example\.com/);
  });

  it("sends a progress ping when the agent run outlasts progressDelayMs, then the reply (product-loop)", async () => {
    // Injected timer that fires synchronously = simulate the run outlasting the delay.
    let fired: (() => void) | null = null;
    let cleared = false;
    const { handle, sent } = harness({
      progressDelayMs: 6000,
      setTimer: (fn) => { fired = fn as () => void; return 7; },
      clearTimer: () => { cleared = true; },
      runAgentFn: async () => { fired?.(); return { reply: "the answer", steps: 3, tools: ["web_search"] }; },
    });
    await handle(msg("who won the game", 5));
    expect(sent.map((s) => s.text)).toEqual([
      "Still working on it — reading the web, hang tight…",
      "the answer",
    ]);
    expect(cleared).toBe(true); // timer cleared once the run settled
  });

  it("no progress ping when progressDelayMs is unset (default wiring unchanged)", async () => {
    const { handle, sent } = harness({
      runAgentFn: async () => ({ reply: "quick", steps: 1, tools: [] }),
    });
    await handle(msg("hi", 6));
    expect(sent).toEqual([{ chatId: 6, text: "quick" }]);
  });

  it("progress timer is cleared on agent error (no ping after failure resolves)", async () => {
    let cleared = false;
    const { handle, sent } = harness({
      progressDelayMs: 6000,
      setTimer: () => 1,
      clearTimer: () => { cleared = true; },
      runAgentFn: async () => { throw new Error("boom"); },
    });
    await handle(msg("do it", 7));
    expect(cleared).toBe(true);
    expect(sent[0]!.text).toMatch(/something went wrong/i);
  });

  it("persists the user turn + a failure note on the error path so a follow-up has context (product-loop)", async () => {
    const { handle, mem } = harness({ runAgentFn: async () => { throw new Error("anvil down at host 10.0.0.1"); } });
    await handle(msg("check the price of bitcoin", 9));
    const h = mem.get(9)!;
    expect(h).toHaveLength(2);
    expect(h[0]).toEqual({ role: "user", content: "check the price of bitcoin" });
    expect(h[1]!.role).toBe("assistant");
    expect(h[1]!.content).toMatch(/that attempt failed/i);
    expect(h[1]!.content).not.toMatch(/10\.0\.0\.1/); // raw error (hostnames) never enters memory
  });

  it("a photo message is answered via describeImage, not the browser agent (product-loop)", async () => {
    let agentCalled = false;
    let gotFile = ""; let gotCaption = "";
    const { handle, sent } = harness({
      describeImage: async (fileId, caption) => { gotFile = fileId; gotCaption = caption; return "That's a receipt; total is $42.50."; },
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle({ chatId: 5, from: "u", text: "what's the total?", messageId: 1, photoFileId: "F1" } as InboundMessage);
    expect(agentCalled).toBe(false);
    expect(gotFile).toBe("F1");
    expect(gotCaption).toBe("what's the total?");
    expect(sent[0]!.text).toMatch(/\$42\.50/);
  });

  it("a photo answer is persisted to memory so a follow-up has context (product-loop)", async () => {
    const { handle, mem } = harness({
      describeImage: async () => "That's a receipt; total is $42.50.",
    });
    await handle({ chatId: 5, from: "u", text: "what's the total?", messageId: 1, photoFileId: "F1" } as InboundMessage);
    const h = mem.get(5)!;
    expect(h).toHaveLength(2);
    expect(h[0]).toEqual({ role: "user", content: "[photo] what's the total?" });
    expect(h[1]).toEqual({ role: "assistant", content: "That's a receipt; total is $42.50." });
  });

  it("a document answer is persisted to memory (product-loop)", async () => {
    const { handle, mem } = harness({
      describeDocument: async () => "It's an invoice for $88.",
    });
    await handle({ chatId: 6, from: "u", text: "", messageId: 1, documentFileId: "D1" } as InboundMessage);
    const h = mem.get(6)!;
    expect(h).toHaveLength(2);
    expect(h[0]).toEqual({ role: "user", content: "[document] [sent a document]" });
    expect(h[1]!.content).toMatch(/\$88/);
  });

  it("a photo with no describeImage dep gets a clear 'can't read images' note", async () => {
    const { handle, sent } = harness();
    await handle({ chatId: 5, from: "u", text: "", messageId: 1, photoFileId: "F1" } as InboundMessage);
    expect(sent[0]!.text).toMatch(/can't read images/i);
  });

  it("a voice note is transcribed then RUN as a task (product-loop)", async () => {
    let ranTask = "";
    const { handle, sent } = harness({
      transcribeVoice: async () => "what's the weather in Paris",
      runAgentFn: async (t) => { ranTask = t; return { reply: "20C in Paris", steps: 1, tools: [] }; },
    });
    await handle({ chatId: 5, from: "u", text: "", messageId: 1, voiceFileId: "V1" } as InboundMessage);
    expect(ranTask).toBe("what's the weather in Paris");            // transcript run as the task
    expect(sent.map((s) => s.text)).toEqual(['🎤 "what\'s the weather in Paris"', "20C in Paris"]); // echo + answer
  });

  it("a voice note with no transcribeVoice dep gets a clear note", async () => {
    const { handle, sent } = harness();
    await handle({ chatId: 5, from: "u", text: "", messageId: 1, voiceFileId: "V1" } as InboundMessage);
    expect(sent[0]!.text).toMatch(/can't do voice/i);
  });

  it("an unintelligible voice note asks the user to retry, no agent", async () => {
    let agentCalled = false;
    const { handle, sent } = harness({
      transcribeVoice: async () => "   ",
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle({ chatId: 5, from: "u", text: "", messageId: 1, voiceFileId: "V1" } as InboundMessage);
    expect(agentCalled).toBe(false);
    expect(sent[0]!.text).toMatch(/couldn't make out/i);
  });

  it("a document message is answered via describeDocument, not the browser agent (product-loop)", async () => {
    let agentCalled = false; let gotFile = ""; let gotCaption = "";
    const { handle, sent } = harness({
      describeDocument: async (fileId, caption) => { gotFile = fileId; gotCaption = caption; return "Statement: total due $88 on the 15th."; },
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle({ chatId: 5, from: "u", text: "summarize this", messageId: 1, documentFileId: "D1" } as InboundMessage);
    expect(agentCalled).toBe(false);
    expect(gotFile).toBe("D1");
    expect(gotCaption).toBe("summarize this");
    expect(sent[0]!.text).toMatch(/\$88/);
  });

  it("a document with no describeDocument dep gets a clear note", async () => {
    const { handle, sent } = harness();
    await handle({ chatId: 5, from: "u", text: "", messageId: 1, documentFileId: "D1" } as InboundMessage);
    expect(sent[0]!.text).toMatch(/can't read files/i);
  });

  it("a location message stores it and does NOT run the agent (product-loop)", async () => {
    let agentCalled = false;
    const { handle, sent } = harness({
      setLocation: (_id, t) => (/paris/i.test(t) ? { location: "Paris" } : null),
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("I'm in Paris", 5));
    expect(agentCalled).toBe(false);
    expect(sent[0]!.text).toMatch(/Paris/);
  });

  it("/profile shows the stored profile, no agent (profile-view-reset)", async () => {
    let agentCalled = false;
    const { handle, sent } = harness({
      profileView: () => "Home location is Paris; timezone is UTC+1",
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("/profile", 5));
    expect(agentCalled).toBe(false);
    expect(sent[0]!.text).toMatch(/Paris/);
    expect(sent[0]!.text).toMatch(/UTC\+1/);
  });

  it("/profile with nothing saved hints how to set it", async () => {
    const { handle, sent } = harness({ profileView: () => null });
    await handle(msg("/profile", 5));
    expect(sent[0]!.text).toMatch(/No profile saved/i);
    expect(sent[0]!.text).toMatch(/setlocation/i);
  });

  it("/profile clear forgets it, no agent", async () => {
    let cleared = 0;
    const { handle, sent } = harness({ profileClear: () => { cleared++; return true; } });
    await handle(msg("/profile clear", 5));
    expect(cleared).toBe(1);
    expect(sent[0]!.text).toMatch(/[Cc]leared/);
  });

  it("appends a save-nudge when a task repeats a prior one (auto-suggest-save)", async () => {
    const mem = new Map<number, LLMMessage[]>();
    mem.set(9, [{ role: "user", content: "check the price of bitcoin" }, { role: "assistant", content: "$65k" }]);
    const sent: string[] = [];
    const handle = createHandler({
      llm: {} as never,
      memoryGet: (id) => mem.get(id) ?? [],
      memorySet: (id, h) => { mem.set(id, h); },
      memoryClear: () => false,
      sendMessage: async (_id, text) => { sent.push(text); },
      sendTyping: async () => {},
      handleCommand: () => null,
      checkRateLimit: () => ({ allowed: true }),
      redactText: (t) => t, hasModelKey: () => true, recordTurn: () => {}, now: () => 0,
      suggestSaves: true,
      runAgentFn: async () => ({ reply: "It's $66k now.", steps: 1, tools: [] }),
      log: () => {},
    });
    await handle(msg("check the price of bitcoin", 9));
    expect(sent[0]).toMatch(/66k/);           // the answer leads
    expect(sent[0]).toMatch(/want me to save it/i); // ...then the nudge
  });

  it("shows the make-it-recurring tip ONCE on a chat's first clean answer (post-answer-recurring-offer)", async () => {
    const mem = new Map<number, LLMMessage[]>();
    const sent: string[] = [];
    const handle = createHandler({
      llm: {} as never,
      memoryGet: (id) => mem.get(id) ?? [],
      memorySet: (id, h) => { mem.set(id, h); },
      memoryClear: () => false,
      sendMessage: async (_id, text) => { sent.push(text); },
      sendTyping: async () => {},
      handleCommand: () => null,
      checkRateLimit: () => ({ allowed: true }),
      redactText: (t) => t, hasModelKey: () => true, recordTurn: () => {}, now: () => 0,
      suggestSaves: true,
      runAgentFn: async (text) => ({ reply: `answer:${text}`, steps: 1, tools: [] }),
      log: () => {},
    });
    await handle(msg("top HN story", 3));
    expect(sent[0]).toMatch(/Tip: I can keep this coming/);
    await handle(msg("weather in Paris", 3));   // second turn: no tip again
    expect(sent[1]).not.toMatch(/Tip: I can keep this coming/);
  });

  it("no save-nudge when suggestSaves is off (default)", async () => {
    const mem = new Map<number, LLMMessage[]>();
    mem.set(9, [{ role: "user", content: "check the price of bitcoin" }, { role: "assistant", content: "$65k" }]);
    const { handle, sent } = harness({
      memoryGet: (id) => mem.get(id) ?? [],
      runAgentFn: async () => ({ reply: "It's $66k now.", steps: 1, tools: [] }),
    });
    await handle(msg("check the price of bitcoin", 9));
    expect(sent[0]!.text).not.toMatch(/want me to save/i);
  });

  it("'save that as <name>' captures the prior task as a recipe (save-that-as)", async () => {
    const mem = new Map<number, LLMMessage[]>();
    mem.set(5, [{ role: "user", content: "check the price of bitcoin" }, { role: "assistant", content: "$65k" }]);
    const saved: Array<{ name: string; task: string }> = [];
    const { handle, sent } = harness({
      memoryGet: (id) => mem.get(id) ?? [],
      recipeSaveNamed: (_c, name, task) => { saved.push({ name, task }); return { ok: true, name }; },
    });
    await handle(msg("save that as btc", 5));
    expect(saved).toEqual([{ name: "btc", task: "check the price of bitcoin" }]);
    expect(sent[0]!.text).toMatch(/Saved recipe "btc" from your last task/);
  });

  it("'save that as <name>' with nothing to save says so, no crash", async () => {
    const { handle, sent } = harness({
      memoryGet: () => [],
      recipeSaveNamed: () => ({ ok: true, name: "x" }),
    });
    await handle(msg("save that as x", 5));
    expect(sent[0]!.text).toMatch(/Nothing recent to save/i);
  });

  it("serializes two overlapping same-chat messages so neither turn is clobbered (memory-clobber-lock)", async () => {
    const mem = new Map<number, LLMMessage[]>();
    let firstRelease!: () => void;
    const firstGate = new Promise<void>((r) => { firstRelease = r; });
    let n = 0;
    const handle = createHandler({
      llm: {} as never,
      memoryGet: (id) => mem.get(id) ?? [],
      memorySet: (id, h) => { mem.set(id, h); },
      memoryClear: () => false,
      sendMessage: async () => {},
      sendTyping: async () => {},
      handleCommand: () => null,
      checkRateLimit: () => ({ allowed: true }),
      redactText: (t) => t, hasModelKey: () => true, recordTurn: () => {}, now: () => 0,
      runAgentFn: async (text) => { n++; if (n === 1) await firstGate; return { reply: `r:${text}`, steps: 1, tools: [] }; },
      log: () => {},
    });
    const p1 = handle(msg("first", 9));   // blocks in the agent until released
    const p2 = handle(msg("second", 9));  // must WAIT for p1 (same chat), not read the same base history
    await Promise.resolve(); await Promise.resolve();
    firstRelease();                        // let the first finish; the second then runs on top of it
    await Promise.all([p1, p2]);
    const h = mem.get(9)!;
    // Both turns survived, in order — the second didn't overwrite the first from a stale snapshot.
    expect(h).toHaveLength(4);
    expect(h[0]).toEqual({ role: "user", content: "first" });
    expect(h[2]).toEqual({ role: "user", content: "second" });
  });

  it("offers a matching saved recipe instead of a cold agent run (recipe-auto-recall)", async () => {
    let agentCalled = false;
    const { handle, sent } = harness({
      recipeMatch: (_c, t) => (/bitcoin/i.test(t) ? { name: "btc" } : null),
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("check bitcoin price"));
    expect(sent[0]!.text).toMatch(/saved "btc".*\/run btc/);
    expect(agentCalled).toBe(false); // offered, didn't cold-run
  });

  it("re-sending the same phrase after a recall offer runs it fresh (escape hatch, no loop)", async () => {
    let agentCalls = 0;
    const { handle, sent } = harness({
      recipeMatch: () => ({ name: "btc" }),
      runAgentFn: async () => { agentCalls++; return { reply: "fresh answer", steps: 1, tools: [] }; },
    });
    await handle(msg("check bitcoin price", 7));
    expect(sent[0]!.text).toMatch(/saved "btc"/);   // first: offered
    expect(agentCalls).toBe(0);
    await handle(msg("check bitcoin price", 7));      // same phrase again
    expect(agentCalls).toBe(1);                       // second: fresh agent run, no re-offer loop
  });

  it("no recipe match -> normal agent run", async () => {
    let agentCalled = false;
    const { handle } = harness({
      recipeMatch: () => null,
      runAgentFn: async () => { agentCalled = true; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("weather in Paris"));
    expect(agentCalled).toBe(true);
  });

  it("'more' pages out the tail of a truncated answer, no agent re-run (last-result-drilldown)", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"); // >12 lines -> trimmed
    let agentCalls = 0;
    const { handle, sent } = harness({
      runAgentFn: async () => { agentCalls++; return { reply: long, steps: 1, tools: [] }; },
    });
    await handle(msg("give me the list", 4));
    expect(agentCalls).toBe(1);
    expect(sent[0]!.text).toMatch(/…$/); // first reply trimmed
    await handle(msg("more", 4));
    expect(agentCalls).toBe(1);          // served from cache, no re-run
    expect(sent[1]!.text).toMatch(/line 30/); // the dropped tail
  });

  it("a proactive ping between the answer and 'more' does NOT eat the answer tail (proactive-clobbers-drilldown-cache)", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const store = new Map<number, { full: string; sent: number; ping?: { full: string; sent: number } }>();
    const { handle, sent } = harness({
      lastResultStore: store,
      runAgentFn: async () => ({ reply: long, steps: 1, tools: [] }),
    });
    await handle(msg("give me the list", 4));
    expect(sent[0]!.text).toMatch(/…$/); // trimmed; tail cached in the answer slot
    // A scheduled digest/alert fires (runner's recordSend shape) — writes the ping slot, must NOT
    // touch the answer's sent offset.
    const e = store.get(4)!;
    store.set(4, { full: e.full, sent: e.sent, ping: { full: "🔔 digest: here's your morning brief", sent: "🔔 digest: here's your morning brief".length } });
    await handle(msg("more", 4));
    expect(sent[1]!.text).toMatch(/line 30/); // answer tail STILL recoverable, not "nothing more to show"
    expect(sent[1]!.text).not.toMatch(/nothing more to show/i);
  });

  it("'send the link' works on a proactive ping via the shared last-result store (proactive-ping-drilldown-cache)", async () => {
    const store = new Map<number, { full: string; sent: number; ping?: { full: string; sent: number } }>();
    store.set(8, { full: "", sent: 0, ping: { full: "🔔 btc changed: see https://x.com/p", sent: 999 } }); // as if a runner ping cached it
    let agentCalls = 0;
    const { handle, sent } = harness({
      lastResultStore: store,
      runAgentFn: async () => { agentCalls++; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("send the link", 8));
    expect(sent[0]!.text).toMatch(/https:\/\/x\.com\/p/);
    expect(agentCalls).toBe(0);
  });

  it("'send the link' returns URLs from the last answer, no agent re-run", async () => {
    let agentCalls = 0;
    const { handle, sent } = harness({
      runAgentFn: async () => { agentCalls++; return { reply: "Top result: https://example.com/story", steps: 1, tools: ["web_search"] }; },
    });
    await handle(msg("top story", 4));
    await handle(msg("send the link", 4));
    expect(agentCalls).toBe(1);
    expect(sent[1]!.text).toMatch(/https:\/\/example\.com\/story/);
  });

  it("'watch that' turns the last task into an alert (watch-schedule-that-by-ref)", async () => {
    const mem = new Map<number, LLMMessage[]>();
    mem.set(6, [{ role: "user", content: "price of bitcoin" }, { role: "assistant", content: "$65k" }]);
    const defined: string[] = [];
    const { handle, sent } = harness({
      memoryGet: (id) => mem.get(id) ?? [],
      alertDefine: (_c, text) => { defined.push(text); return { ok: true, name: "price-of" }; },
      alertRunNow: async () => ({ message: null, commit: () => {} }),
    });
    await handle(msg("watch that below 50000", 6));
    expect(defined[0]).toMatch(/watch .*: price of bitcoin below 50000/);
    expect(sent[0]!.text).toMatch(/Watching/);
  });

  it("'do that every morning' schedules the last task (not the literal 'do that') (audit 20 B#1)", async () => {
    const mem = new Map<number, LLMMessage[]>();
    mem.set(6, [{ role: "user", content: "top HN story" }, { role: "assistant", content: "Story X" }]);
    const added: string[] = [];
    const { handle } = harness({
      memoryGet: (id) => mem.get(id) ?? [],
      scheduleAdd: (_c, text) => { added.push(text); return { ok: true, kind: "daily", task: "top HN story", whenMs: 0 }; },
    });
    await handle(msg("do that every morning", 6));
    expect(added[0]).toBe("top HN story every morning"); // the prior task, not "do that"
  });

  it("'watch that' names the alert after salient words, not stopwords (audit 20 B#2)", async () => {
    const mem = new Map<number, LLMMessage[]>();
    mem.set(6, [{ role: "user", content: "what's the price of bitcoin" }, { role: "assistant", content: "$65k" }]);
    const defined: string[] = [];
    const { handle } = harness({
      memoryGet: (id) => mem.get(id) ?? [],
      alertDefine: (_c, text) => { defined.push(text); return { ok: true, name: "bitcoin" }; },
      alertRunNow: async () => ({ message: null, commit: () => {} }),
    });
    await handle(msg("watch that below 50000", 6));
    expect(defined[0]).toMatch(/^watch bitcoin:/); // salient token, not "whats-the"
  });

  it("'schedule that every morning' schedules the last task", async () => {
    const mem = new Map<number, LLMMessage[]>();
    mem.set(6, [{ role: "user", content: "top HN story" }, { role: "assistant", content: "Story X" }]);
    const added: string[] = [];
    const { handle, sent } = harness({
      memoryGet: (id) => mem.get(id) ?? [],
      scheduleAdd: (_c, text) => { added.push(text); return { ok: true, kind: "daily", task: "top HN story", whenMs: 0 }; },
    });
    await handle(msg("schedule that every morning", 6));
    expect(added[0]).toBe("top HN story every morning");
    expect(sent[0]!.text).toMatch(/on that schedule/);
  });

  it("'watch that' with nothing recent says so", async () => {
    const { handle, sent } = harness({ memoryGet: () => [], alertDefine: () => ({ ok: true, name: "x" }) });
    await handle(msg("watch that", 6));
    expect(sent[0]!.text).toMatch(/Nothing recent to watch/i);
  });

  it("a short follow-up to a proactive ping gets that ping as agent context (proactive-followup-context)", async () => {
    const store = new Map<number, { full: string; sent: number; ping?: { full: string; sent: number } }>();
    store.set(4, { full: "", sent: 0, ping: { full: "🔔 btc changed: now $67,000 (was $65,000)", sent: 999 } });
    let gotCtx: string | undefined;
    const { handle } = harness({
      lastResultStore: store,
      runAgentFn: async (_t, deps) => { gotCtx = (deps as { context?: string }).context; return { reply: "because demand rose", steps: 1, tools: [] }; },
    });
    await handle(msg("why?", 4));
    expect(gotCtx).toMatch(/replying to this message.*btc changed/i);
  });

  it("a follow-up to a NORMAL (inbound) answer does NOT get proactive-ping context", async () => {
    const store = new Map<number, { full: string; sent: number; ping?: { full: string; sent: number } }>();
    store.set(4, { full: "an earlier answer", sent: 999 }); // inbound answer, no ping
    let gotCtx: string | undefined;
    const { handle } = harness({
      lastResultStore: store,
      runAgentFn: async (_t, deps) => { gotCtx = (deps as { context?: string }).context; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("why?", 4));
    expect(gotCtx ?? "").not.toMatch(/replying to this message/i);
  });

  it("passes the profile context into the agent run", async () => {
    let gotContext: string | undefined;
    const { handle } = harness({
      profileContext: () => "home location is Paris",
      runAgentFn: async (_t, deps) => { gotContext = (deps as { context?: string }).context; return { reply: "ok", steps: 1, tools: [] }; },
    });
    await handle(msg("weather?", 5));
    expect(gotContext).toBe("home location is Paris");
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

  it("DEV-0178: a degraded reply records ok:false + prepends a partial-answer hint (not counted as success)", async () => {
    const { handle, sent, recorded } = harness({
      runAgentFn: async () => ({ reply: "I ran out of steps before finishing.", steps: 8, tools: ["scrape"], degraded: true }),
    });
    await handle(msg("scrape a huge site", 9));
    // degraded turn is NOT a success — the ok/success metric must not be inflated by soft failures
    expect(recorded).toEqual([{ ok: false, steps: 8, tools: ["scrape"] }]);
    // the user sees a partial-answer hint prepended to the fallback text
    expect(sent[0]!.chatId).toBe(9);
    expect(sent[0]!.text).toMatch(/partial answer/i);
    expect(sent[0]!.text).toContain("I ran out of steps before finishing.");
  });

  it("an agent error -> friendly reply + a failed turn recorded + a coherent memory pair (product-loop)", async () => {
    const { handle, sent, recorded, mem } = harness({
      runAgentFn: async () => { throw new Error("boom"); },
    });
    await handle(msg("do it", 7));
    expect(sent[0]!.text).toMatch(/something went wrong/i);
    expect(recorded).toEqual([{ ok: false, steps: 0, tools: [] }]);
    // The user turn + a failure NOTE are persisted so a follow-up ("try again") has context.
    const h = mem.get(7)!;
    expect(h).toEqual([
      { role: "user", content: "do it" },
      { role: "assistant", content: expect.stringMatching(/that attempt failed/i) },
    ]);
  });

  it("a transient model error -> the overloaded hint", async () => {
    const { handle, sent } = harness({
      runAgentFn: async () => { throw new Error("503 UNAVAILABLE high demand"); },
    });
    await handle(msg("go"));
    expect(sent[0]!.text).toMatch(/overloaded/i);
  });

  // m14 degrade-1: anvil-down surfaces as a connection-refused / "create session failed" error.
  // The user must get a friendly browser-down line, NOT the raw ECONNREFUSED text.
  it("an anvil/browser-down error -> friendly browser message, no raw error leaked", async () => {
    const { handle, sent } = harness({
      runAgentFn: async () => { throw new Error("anvil create session failed: connect ECONNREFUSED 127.0.0.1:3000"); },
    });
    await handle(msg("get the top HN story"));
    expect(sent[0]!.text).toMatch(/browser/i);
    expect(sent[0]!.text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|create session/);
  });

  // m14 degrade-1: a blocked/unsafe URL bubbling up gets a user-actionable line (not generic).
  it("a blocked-URL error -> the unsafe-link message", async () => {
    const { handle, sent } = harness({
      runAgentFn: async () => { throw new Error("Blocked URL: private IP 10.0.0.5"); },
    });
    await handle(msg("open http://10.0.0.5"));
    expect(sent[0]!.text).toMatch(/unsafe|can't open/i);
    expect(sent[0]!.text).not.toMatch(/10\.0\.0\.5/);
  });

  // DEV-0021 (revised, product-loop): a failed turn on a chat WITH history APPENDS a clean
  // user+failure-note pair (so a follow-up is coherent) WITHOUT mutating the prior array and
  // WITHOUT a dangling half-turn. The prior array itself must stay untouched (new array written).
  it("an error on a chat WITH history appends a clean pair, prior array untouched", async () => {
    const prior: LLMMessage[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ];
    const { handle, mem } = harness({
      memoryGet: () => prior,
      runAgentFn: async () => { throw new Error("boom"); },
    });
    await handle(msg("this one fails", 5));
    // A complete new history was persisted: prior 2 + this user turn + a failure note.
    const h = mem.get(5)!;
    expect(h).toHaveLength(4);
    expect(h.slice(0, 2)).toEqual(prior);
    expect(h[2]).toEqual({ role: "user", content: "this one fails" });
    expect(h[3]!.role).toBe("assistant");
    // the prior array itself was not mutated in place
    expect(prior).toHaveLength(2);
    expect(prior[prior.length - 1]).toEqual({ role: "assistant", content: "earlier reply" });
  });

  it("a failed turn then a successful one: the follow-up sees the failure context (product-loop)", async () => {
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
    // The failed turn left a coherent pair, so the success ran WITH that context and appended to it.
    const h = mem.get(8)!;
    expect(h).toHaveLength(4);
    expect(h[0]).toEqual({ role: "user", content: "fails" });
    expect(h[1]!.content).toMatch(/that attempt failed/i);
    expect(h[2]).toEqual({ role: "user", content: "works" });
    expect(h[3]).toEqual({ role: "assistant", content: "ok:works" });
  });
});

describe("long-term memory (remember-facts-store)", () => {
  function notesHarness() {
    const notes = new NotesStore({ file: join(mkdtempSync(join(tmpdir(), "relay-h-notes-")), "n.json") });
    let ctxSeen: string | undefined;
    const h = harness({
      rememberFact: (chatId, text) => { const f = parseRemember(text); if (!f) return null; const r = notes.add(chatId, f, 0); return { fact: f, evicted: r.evicted }; },
      forgetFact: (chatId, text) => {
        const p = parseForgetFact(text);
        if (!p) return null;
        if ("all" in p) return { removed: notes.clear(chatId), all: true, forgotten: [] };
        const forgotten = notes.forget(chatId, p.term);
        return { removed: forgotten.length, all: false, forgotten };
      },
      notesList: (chatId) => notes.list(chatId).map((n) => n.text),
      profileContext: (chatId) => notes.contextLine(chatId),
      runAgentFn: async (_t, deps) => { ctxSeen = (deps as { context?: string }).context; return { reply: "ok", steps: 1, tools: [] }; },
    });
    return { ...h, notes, ctx: () => ctxSeen };
  }

  it("'remember X' stores a fact and a later answer gets it as agent context", async () => {
    const { handle, sent, notes, ctx } = notesHarness();
    await handle(msg("remember I'm vegetarian", 5));
    expect(sent[0]!.text).toMatch(/I'll remember that I'm vegetarian/);
    expect(notes.list(5).map((n) => n.text)).toEqual(["I'm vegetarian"]);
    await handle(msg("suggest a dinner", 5));
    expect(ctx()).toMatch(/asked me to remember: I'm vegetarian/);
  });

  it("'what do you know about me' recites the stored facts, no agent run", async () => {
    const { handle, sent, recorded } = notesHarness();
    await handle(msg("remember I park in section G", 5));
    await handle(msg("what do you know about me", 5));
    expect(sent[1]!.text).toMatch(/I park in section G/);
    expect(recorded).toHaveLength(0); // never hit the agent
  });

  it("'forget that X' deletes a matching fact; 'remember to X' falls through (not a fact)", async () => {
    const { handle, sent, notes } = notesHarness();
    await handle(msg("remember I'm vegetarian", 5));
    await handle(msg("forget that I'm vegetarian", 5));
    expect(sent[1]!.text).toMatch(/Forgot 1 thing/);
    expect(notes.list(5)).toHaveLength(0);
    // "remember to call mom" is a to-do, not a fact — parseRemember returns null so it reaches the agent.
    await handle(msg("remember to call mom", 5));
    expect(notes.list(5)).toHaveLength(0); // not stored as a fact
  });
});

describe("first-run location capture (first-location-capture)", () => {
  function locHarness(hasLoc = false) {
    let stored: { location: string; tzOffsetMin?: number } | null = hasLoc ? { location: "Austin" } : null;
    let agentRan: string | null = null;
    const h = harness({
      hasLocation: () => stored !== null,
      captureLocation: (_c, text) => {
        const c = parseCityReply(text);
        if (!c) return null;
        stored = c;
        return c;
      },
      runAgentFn: async (t: string) => { agentRan = t; return { reply: "sunny, 70F", steps: 1, tools: [] }; },
    });
    return { ...h, agentRan: () => agentRan, city: () => stored };
  }

  it("first weather ask with no city asks for it + stashes the errand, no agent run", async () => {
    const { handle, sent, agentRan } = locHarness(false);
    await handle(msg("weather tomorrow", 5));
    expect(sent[0]!.text).toMatch(/what city are you in/i);
    expect(agentRan()).toBeNull(); // didn't run the errand yet
  });

  it("the city reply is saved and the original errand re-runs", async () => {
    const { handle, sent, agentRan, city } = locHarness(false);
    await handle(msg("weather tomorrow", 5));
    await handle(msg("Denver UTC-7", 5));
    expect(city()).toEqual({ location: "Denver", tzOffsetMin: -420 });
    expect(sent[1]!.text).toMatch(/saved Denver/i);
    expect(agentRan()).toBe("weather tomorrow"); // re-ran the stashed errand
    expect(sent[2]!.text).toMatch(/sunny/);
  });

  it("a non-city reply bails out — routes normally, errand NOT re-run", async () => {
    const { handle, sent, agentRan } = locHarness(false);
    await handle(msg("sushi near me", 5));
    await handle(msg("actually never mind, top HN story", 5)); // not a place
    expect(agentRan()).toBe("actually never mind, top HN story"); // ran THIS message, not the stashed errand
  });

  it("does NOT ask when a city is already saved", async () => {
    const { handle, sent, agentRan } = locHarness(true);
    await handle(msg("weather", 5));
    expect(sent.some((m) => /what city/i.test(m.text))).toBe(false);
    expect(agentRan()).toBe("weather"); // straight to the agent
  });
});

describe("background errands (async-background-errands)", () => {
  it("ACKs immediately then delivers the result unprompted, off the chain", async () => {
    let resolveRun: ((r: { reply: string; steps: number; tools: string[] }) => void) | null = null;
    const { handle, sent } = harness({
      enableBackgroundErrands: true,
      runAgentFn: (_t) => new Promise((res) => { resolveRun = res; }),
    });
    await handle(msg("find the 5 cheapest flights to Lisbon and get back to me", 5));
    // handle() resolves BEFORE the agent finishes (detached) — the ack is already sent.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/on it/i);
    // Now let the detached run finish + flush microtasks.
    resolveRun!({ reply: "Found 5 flights: ...", steps: 12, tools: ["web_search"] });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toMatch(/Done with/i);
    expect(sent[1]!.text).toMatch(/Found 5 flights/);
  });

  it("passes a raised step budget to the agent for the errand", async () => {
    let seenMax: number | undefined;
    const { handle } = harness({
      enableBackgroundErrands: true,
      runAgentFn: async (_t, d) => { seenMax = (d as { maxSteps?: number }).maxSteps; return { reply: "ok", steps: 1, tools: [] }; },
    });
    await handle(msg("compare the 10 best laptops and report back", 5));
    await new Promise((r) => setTimeout(r, 0));
    expect(seenMax).toBeGreaterThan(8);
  });

  it("a failed background errand still tells the user (no silent black hole)", async () => {
    const { handle, sent } = harness({
      enableBackgroundErrands: true,
      runAgentFn: async () => { throw new Error("anvil down"); },
    });
    await handle(msg("research the best CRMs and get back to me", 5));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0]!.text).toMatch(/on it/i);
    expect(sent[1]!.text).toMatch(/failed/i);
  });

  it("a quick task stays synchronous when the flag is on", async () => {
    let ran = false;
    const { handle, sent } = harness({
      enableBackgroundErrands: true,
      runAgentFn: async () => { ran = true; return { reply: "sunny", steps: 1, tools: [] }; },
    });
    await handle(msg("weather", 5));
    expect(ran).toBe(true);
    expect(sent[0]!.text).toBe("sunny"); // no "on it" ack — ran inline
  });
});

describe("answer history recall (answer-history-recall)", () => {
  it("logs a clean answer, then serves a recall from the log without running the agent", async () => {
    const { AnswerLog, recallKeywords } = await import("../src/lib/answer-log.js");
    const log = new AnswerLog({ file: join(mkdtempSync(join(tmpdir(), "relay-h-ans-")), "a.json") });
    let agentCalls = 0;
    const { handle, sent } = harness({
      recallAnswers: (c, t) => log.search(c, recallKeywords(t), 3),
      logAnswer: (c, task, reply) => log.record(c, task, reply, 0),
      runAgentFn: async () => { agentCalls++; return { reply: "Try Sushi Zen on Main St.", steps: 1, tools: [] }; },
    });
    await handle(msg("best sushi near me", 5));   // logged
    expect(agentCalls).toBe(1);
    await handle(msg("what was that sushi place you found?", 5)); // recall — no agent
    expect(agentCalls).toBe(1);
    expect(sent[1]!.text).toMatch(/Sushi Zen/);
  });

  it("a recall with no matching past answer says so, no agent", async () => {
    let agentCalls = 0;
    const { handle, sent } = harness({
      recallAnswers: () => [],
      logAnswer: () => {},
      runAgentFn: async () => { agentCalls++; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("what did you find about the flights", 5));
    expect(agentCalls).toBe(0);
    expect(sent[0]!.text).toMatch(/don't have a past answer/i);
  });

  it("a fresh (non-recall) task still runs the agent", async () => {
    let ran = "";
    const { handle } = harness({
      recallAnswers: () => [],
      logAnswer: () => {},
      runAgentFn: async (t) => { ran = t; return { reply: "sunny", steps: 1, tools: [] }; },
    });
    await handle(msg("weather in Paris", 5));
    expect(ran).toBe("weather in Paris");
  });
});

describe("background errand reliability (audit fixes)", () => {
  it("persists the errand + result to memory so a follow-up has context", async () => {
    const mem = new Map<number, LLMMessage[]>();
    let resolveRun: ((r: { reply: string; steps: number; tools: string[] }) => void) | null = null;
    const { handle } = harness({
      enableBackgroundErrands: true,
      memoryGet: (id) => mem.get(id) ?? [],
      memorySet: (id, h) => { mem.set(id, h); },
      runAgentFn: () => new Promise((res) => { resolveRun = res; }),
    });
    await handle(msg("compare the 5 best laptops and get back to me", 5));
    resolveRun!({ reply: "The XPS wins.", steps: 3, tools: [] });
    await new Promise((r) => setTimeout(r, 0));
    const h = mem.get(5)!;
    expect(h[h.length - 1]).toEqual({ role: "assistant", content: "The XPS wins." });
  });

  it("a background result writes the PING slot, not clobbering an inbound answer's paging", async () => {
    const store = new Map<number, { full: string; sent: number; ping?: { full: string; sent: number } }>();
    store.set(5, { full: "an earlier long answer tail", sent: 4 }); // inbound answer mid-paging
    let resolveRun: ((r: { reply: string; steps: number; tools: string[] }) => void) | null = null;
    const { handle } = harness({
      enableBackgroundErrands: true,
      lastResultStore: store,
      runAgentFn: () => new Promise((res) => { resolveRun = res; }),
    });
    await handle(msg("research the best CRMs and get back to me", 5));
    resolveRun!({ reply: "Found: HubSpot, Pipedrive.", steps: 2, tools: [] });
    await new Promise((r) => setTimeout(r, 0));
    const e = store.get(5)!;
    expect(e.full).toBe("an earlier long answer tail"); // inbound answer slot untouched
    expect(e.sent).toBe(4);
    expect(e.ping!.full).toMatch(/HubSpot/); // result in the ping slot
  });

  it("caps concurrent background runs per chat — over the cap does NOT detach (no unbounded acks)", async () => {
    let started = 0;
    const { handle, sent } = harness({
      enableBackgroundErrands: true,
      // Never resolves: the two detached runs stay in flight, so the 3rd is over the cap.
      runAgentFn: () => new Promise(() => { started++; }),
    });
    // Two detached errands (each ACKs immediately + stays in flight).
    await handle(msg("find the 5 cheapest flights and get back to me", 5));
    await handle(msg("compare the 10 best laptops and report back", 5));
    expect(sent.filter((m) => /on it/i.test(m.text))).toHaveLength(2); // both detached + ACKed
    // 3rd is over the cap (2 in flight) -> does NOT detach: no 3rd "on it" ack. It falls to the
    // synchronous path (which hangs on this never-resolving mock), so run it WITHOUT awaiting.
    void handle(msg("research the top CRMs and get back to me", 5));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.filter((m) => /on it/i.test(m.text))).toHaveLength(2); // still 2 — the 3rd didn't detach
    expect(started).toBe(3); // the 3rd DID start a run (synchronously), just not detached
  });
});

describe("answer recall shows staleness (audit fix)", () => {
  it("labels a recalled answer's age and nudges a refresh when old", async () => {
    let nowMs = 100 * 86_400_000; // fixed clock
    const past = nowMs - 3 * 86_400_000; // 3 days ago
    const { handle, sent } = harness({
      now: () => nowMs,
      recallAnswers: () => [{ task: "best sushi", reply: "Sushi Zen", at: past }],
      logAnswer: () => {},
    });
    await handle(msg("what was that sushi place you found?", 5));
    expect(sent[0]!.text).toMatch(/3 days ago/);
    expect(sent[0]!.text).toMatch(/ask me to check again/i);
  });
});

describe("watch trend recall (watch-time-series)", () => {
  it("answers a trend ask from watchTrend, no agent run", async () => {
    let agentCalls = 0;
    const { handle, sent } = harness({
      watchTrend: (_c, t) => (/btc/i.test(t) ? "📈 btc: 100 → 120 ↑20 over 5 checks." : null),
      runAgentFn: async () => { agentCalls++; return { reply: "x", steps: 1, tools: [] }; },
    });
    await handle(msg("how has btc moved this week", 5));
    expect(agentCalls).toBe(0);
    expect(sent[0]!.text).toMatch(/📈 btc: 100 → 120/);
  });
  it("a non-trend / unknown-watch message falls through to the agent", async () => {
    let ran = "";
    const { handle } = harness({
      watchTrend: () => null, // not a trend ask / no such watch
      runAgentFn: async (t) => { ran = t; return { reply: "ok", steps: 1, tools: [] }; },
    });
    await handle(msg("weather in Paris", 5));
    expect(ran).toBe("weather in Paris");
  });
});
