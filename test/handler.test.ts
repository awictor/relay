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
