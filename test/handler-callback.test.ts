import { describe, it, expect } from "vitest";
import { createHandler, canOfferAutomation, answerIsWatchable, answerIsStaticOneShot, watchSlug, type HandlerDeps } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";
import { encodeCallback, TRY_EXAMPLES } from "../src/lib/callbacks.js";

// inline-tap-buttons: a callback InboundMessage (a tapped button) is routed to the bounded action,
// acked, and never runs the agent flow. Offline via injected deps.
function harness(over: Partial<HandlerDeps> = {}) {
  const sent: Array<{ text: string; hasButtons: boolean }> = [];
  const acked: Array<string | undefined> = [];
  let agentCalls = 0;
  const deps: HandlerDeps = {
    llm: {} as HandlerDeps["llm"],
    memoryGet: () => [] as LLMMessage[], memorySet: () => {}, memoryClear: () => false,
    sendMessage: async (_id, text, kb) => { sent.push({ text, hasButtons: !!kb }); },
    answerCallback: async (_id, toast) => { acked.push(toast); },
    sendTyping: async () => {},
    handleCommand: () => null,
    checkRateLimit: () => ({ allowed: true }),
    redactText: (t) => t, hasModelKey: () => true, recordTurn: () => {}, now: () => 0,
    runAgentFn: async () => { agentCalls++; return { reply: "x", steps: 1, tools: [] }; },
    ...over,
  };
  return { handle: createHandler(deps), sent, acked, calls: () => agentCalls };
}
const tap = (data: string, chatId = 1): InboundMessage =>
  ({ chatId, from: "u", text: "", messageId: 0, callback: { data, callbackQueryId: "q1" } } as InboundMessage);

describe("handler — inline-button callbacks", () => {
  it("alert Refresh: fires the check, sends result + buttons, acks", async () => {
    let committed = false;
    const { handle, sent, acked, calls } = harness({
      alertRunNow: async () => ({ message: "🔔 btc crossed $65k", commit: () => { committed = true; } }),
    });
    await handle(tap(encodeCallback({ kind: "alert", action: "refresh", name: "btc" })!));
    expect(sent[0]!.text).toMatch(/crossed/);
    expect(sent[0]!.hasButtons).toBe(true);
    expect(committed).toBe(true);
    expect(acked[0]).toMatch(/Refreshed/);
    expect(calls()).toBe(0);
  });

  it("alert Refresh whose crossing-ping FAILS to send does NOT commit (immediate-alert-commit-not-send-gated)", async () => {
    let committed = false;
    const { handle } = harness({
      sendMessage: async () => false, // delivery fails
      alertRunNow: async () => ({ message: "🔔 btc crossed $65k", commit: () => { committed = true; } }),
    });
    await handle(tap(encodeCallback({ kind: "alert", action: "refresh", name: "btc" })!));
    expect(committed).toBe(false); // baseline NOT advanced -> the crossing re-fires next check
  });

  it("alert Refresh with no change says so + commits", async () => {
    let committed = false;
    const { handle, sent, acked } = harness({
      alertRunNow: async () => ({ message: null, commit: () => { committed = true; } }),
    });
    await handle(tap(encodeCallback({ kind: "alert", action: "refresh", name: "btc" })!));
    expect(sent[0]!.text).toMatch(/no change/i);
    expect(committed).toBe(true);
    expect(acked[0]).toMatch(/No change/);
  });

  it("alert Snooze pauses the watch 1 day", async () => {
    const calls: string[] = [];
    const { handle, sent, acked } = harness({
      scheduleSnooze: (_c, text) => { calls.push(text); return { action: "pause", count: 1, which: "btc", untilText: "tomorrow 9am" }; },
    });
    await handle(tap(encodeCallback({ kind: "alert", action: "snooze", name: "btc" })!));
    expect(calls[0]).toMatch(/snooze btc 1 day/);
    expect(sent[0]!.text).toMatch(/Snoozed "btc"/);
    expect(acked[0]).toMatch(/Snoozed/);
  });

  it("alert Stop forgets the watch", async () => {
    let forgot = "";
    const { handle, sent, acked } = harness({ alertForget: (_c, name) => { forgot = name; return true; } });
    await handle(tap(encodeCallback({ kind: "alert", action: "stop", name: "btc" })!));
    expect(forgot).toBe("btc");
    expect(sent[0]!.text).toMatch(/Stopped watching "btc"/);
    expect(acked[0]).toMatch(/Stopped/);
  });

  it("alert Stop retires the tapped ping's buttons in place (callback-edit-in-place)", async () => {
    const edits: Array<{ chatId: number; messageId: number; keyboard: unknown }> = [];
    const { handle } = harness({
      alertForget: () => true,
      editReplyMarkup: async (chatId, messageId, keyboard) => { edits.push({ chatId, messageId, keyboard }); },
    });
    // A tap carries the pinged message's id (42 here) so the edit targets the right card.
    const t = { chatId: 1, from: "u", text: "", messageId: 42, callback: { data: encodeCallback({ kind: "alert", action: "stop", name: "btc" })!, callbackQueryId: "q1" } } as InboundMessage;
    await handle(t);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ chatId: 1, messageId: 42 });
    expect(edits[0]!.keyboard).toBeUndefined(); // no keyboard passed = strip the buttons
  });

  it("alert Stop that finds nothing to forget does NOT strip buttons (only on a real stop)", async () => {
    const edits: number[] = [];
    const { handle } = harness({
      alertForget: () => false, // wasn't an active watch
      editReplyMarkup: async (_c, messageId) => { edits.push(messageId); },
    });
    const t = { chatId: 1, from: "u", text: "", messageId: 42, callback: { data: encodeCallback({ kind: "alert", action: "stop", name: "gone" })!, callbackQueryId: "q1" } } as InboundMessage;
    await handle(t);
    expect(edits).toHaveLength(0);
  });

  it("digest Run again composes + sends with a Run-again button", async () => {
    const { handle, sent, acked } = harness({ digestRun: async () => "☀️ Morning brief: ..." });
    await handle(tap(encodeCallback({ kind: "digest", action: "run", name: "morning" })!));
    expect(sent[0]!.text).toMatch(/Morning brief/);
    expect(sent[0]!.hasButtons).toBe(true);
    expect(acked[0]).toMatch(/Done/);
  });

  it("recipe Run again runs by name", async () => {
    let ran = "";
    const { handle, sent } = harness({ recipeRunByName: async (_c, name) => { ran = name; return "flight found: $220"; } });
    await handle(tap(encodeCallback({ kind: "recipe", action: "run", name: "flights" })!));
    expect(ran).toBe("flights");
    expect(sent[0]!.text).toMatch(/flight found/);
  });

  it("alert Snooze retires the tapped card's buttons so a Refresh can't defeat the snooze (callback-edit-terminal-actions-more)", async () => {
    const edits: number[] = [];
    const { handle } = harness({
      scheduleSnooze: () => ({ count: 1, untilText: "tomorrow 9am" }),
      editReplyMarkup: async (_c, messageId) => { edits.push(messageId); },
    });
    const t = { chatId: 1, from: "u", text: "", messageId: 42, callback: { data: encodeCallback({ kind: "alert", action: "snooze", name: "btc" })!, callbackQueryId: "q1" } } as InboundMessage;
    await handle(t);
    expect(edits).toEqual([42]);
  });
  it("digest Run again on a GONE digest retires the stale card's button (callback-edit-terminal-actions-more)", async () => {
    const edits: number[] = [];
    const { handle, sent } = harness({
      digestRun: async () => null, // removed
      editReplyMarkup: async (_c, messageId) => { edits.push(messageId); },
    });
    const t = { chatId: 1, from: "u", text: "", messageId: 42, callback: { data: encodeCallback({ kind: "digest", action: "run", name: "gone" })!, callbackQueryId: "q1" } } as InboundMessage;
    await handle(t);
    expect(edits).toEqual([42]);
    expect(sent[0]!.text).toMatch(/may have been removed/);
    expect(sent[0]!.hasButtons).toBe(false); // the new message carries no button either
  });
  it("recipe Run again on a GONE recipe retires the stale card's button", async () => {
    const edits: number[] = [];
    const { handle } = harness({
      recipeRunByName: async () => null,
      editReplyMarkup: async (_c, messageId) => { edits.push(messageId); },
    });
    const t = { chatId: 1, from: "u", text: "", messageId: 42, callback: { data: encodeCallback({ kind: "recipe", action: "run", name: "gone" })!, callbackQueryId: "q1" } } as InboundMessage;
    await handle(t);
    expect(edits).toEqual([42]);
  });
  it("a SUCCESSFUL digest/recipe run does NOT strip buttons (keeps Run-again live)", async () => {
    const edits: number[] = [];
    const { handle } = harness({
      digestRun: async () => "brief content",
      editReplyMarkup: async (_c, messageId) => { edits.push(messageId); },
    });
    const t = { chatId: 1, from: "u", text: "", messageId: 42, callback: { data: encodeCallback({ kind: "digest", action: "run", name: "morning" })!, callbackQueryId: "q1" } } as InboundMessage;
    await handle(t);
    expect(edits).toHaveLength(0);
  });

  it("a stale/garbage payload is handled gracefully, no agent", async () => {
    const { handle, sent, acked, calls } = harness();
    await handle(tap("zz|nope"));
    expect(sent[0]!.text).toMatch(/no longer valid/i);
    expect(acked[0]).toMatch(/Expired/);
    expect(calls()).toBe(0);
  });

  it("a list reply attaches pick buttons, and a pick tap resends that item (inline-result-picker)", async () => {
    const { handle, sent } = harness({
      handleCommand: () => null,
      runAgentFn: async () => ({ reply: "1. LAX→JFK $220 https://k.com/a\n2. LAX→EWR $260\n3. LAX→BUR $275", steps: 1, tools: [] }),
    });
    // A normal text task -> the agent returns a numbered list; the reply should carry pick buttons.
    await handle({ chatId: 1, from: "u", text: "cheapest flights", messageId: 1 } as InboundMessage);
    const listSend = sent[sent.length - 1]!;
    expect(listSend.hasButtons).toBe(true);
    // Tap "pick index 1" -> resends option 2.
    await handle(tap(encodeCallback({ kind: "pick", index: 1 })!));
    expect(sent[sent.length - 1]!.text).toMatch(/2\. LAX→EWR/);
  });

  it("picking by TEXT ('open the 2nd', 'the last one') resends that list item (open-nth-result)", async () => {
    const { handle, sent } = harness({
      handleCommand: () => null,
      runAgentFn: async () => ({ reply: "1. LAX→JFK $220\n2. LAX→EWR $260\n3. LAX→BUR $275", steps: 1, tools: [] }),
    });
    await handle({ chatId: 1, from: "u", text: "cheapest flights", messageId: 1 } as InboundMessage);
    await handle({ chatId: 1, from: "u", text: "open the 2nd", messageId: 2 } as InboundMessage);
    expect(sent[sent.length - 1]!.text).toMatch(/2\. LAX→EWR/);
    await handle({ chatId: 1, from: "u", text: "the last one", messageId: 3 } as InboundMessage);
    expect(sent[sent.length - 1]!.text).toMatch(/3\. LAX→BUR/);
  });

  it("picking an out-of-range index by text gives an honest count, not a wrong item", async () => {
    const { handle, sent } = harness({
      handleCommand: () => null,
      runAgentFn: async () => ({ reply: "1. only\n2. two", steps: 1, tools: [] }),
    });
    await handle({ chatId: 1, from: "u", text: "list", messageId: 1 } as InboundMessage);
    await handle({ chatId: 1, from: "u", text: "open the 5th", messageId: 2 } as InboundMessage);
    expect(sent[sent.length - 1]!.text).toMatch(/only have 2 items/i);
  });

  it("a pick on an item with a mid-text URL appends a 🔗 link line", async () => {
    const { handle, sent } = harness({
      runAgentFn: async () => ({ reply: "1. Cheap flight https://k.com/a to JFK\n2. Other option", steps: 1, tools: [] }),
    });
    await handle({ chatId: 1, from: "u", text: "flights", messageId: 1 } as InboundMessage);
    await handle(tap(encodeCallback({ kind: "pick", index: 0 })!));
    expect(sent[sent.length - 1]!.text).toMatch(/🔗 https:\/\/k\.com\/a/);
  });

  it("a pick with no cached list is handled gracefully", async () => {
    const { handle, sent, acked } = harness();
    await handle(tap(encodeCallback({ kind: "pick", index: 0 })!));
    expect(sent[0]!.text).toMatch(/isn't available/i);
    expect(acked[0]).toMatch(/Expired/);
  });

  it("a first /start reply carries tap-to-try buttons (onboarding-tap-to-try)", async () => {
    const { handle, sent } = harness({ handleCommand: (t) => (t === "/start" ? "👋 I'm Relay..." : null) });
    await handle({ chatId: 1, from: "u", text: "/start", messageId: 1 } as InboundMessage);
    expect(sent[0]!.hasButtons).toBe(true);
  });

  it("a returning user's /start (non-empty history) gets NO buttons", async () => {
    const { handle, sent } = harness({
      handleCommand: (t) => (t === "/start" ? "👋 I'm Relay..." : null),
      memoryGet: () => [{ role: "user", content: "prior" }] as never,
    });
    await handle({ chatId: 1, from: "u", text: "/start", messageId: 1 } as InboundMessage);
    expect(sent[0]!.hasButtons).toBe(false);
  });

  it("a try tap runs the canned example through the normal flow", async () => {
    let ranText = "";
    const { handle, sent, acked } = harness({
      handleCommand: () => null,
      runAgentFn: async (text) => { ranText = text; return { reply: "sunny, 72°", steps: 1, tools: [] }; },
    });
    // index 0 is "weather" — a keyless example. Tap it.
    await handle(tap(encodeCallback({ kind: "try", index: 0 })!));
    expect(ranText).toBe(TRY_EXAMPLES[0]!.text);
    expect(sent[sent.length - 1]!.text).toMatch(/sunny/);
    expect(acked[0]).toBeTruthy();
  });

  it("canOfferAutomation / answerIsWatchable / watchSlug gate + shape the tap-to-watch offer", () => {
    expect(canOfferAutomation("price of bitcoin")).toBe(true);
    expect(canOfferAutomation("top news today")).toBe(true);
    expect(canOfferAutomation("hi")).toBe(false);            // trivial
    expect(canOfferAutomation("watch btc: ...")).toBe(false); // already an automation
    expect(canOfferAutomation("/help")).toBe(false);          // command
    expect(canOfferAutomation("more")).toBe(false);           // follow-up
    expect(answerIsWatchable("price of bitcoin", "$65,000")).toBe(true);
    expect(answerIsWatchable("top news", "Headlines: ...")).toBe(false);
    expect(watchSlug("price of bitcoin")).toBe("bitcoin");
    expect(watchSlug("AAPL stock price")).toBe("aapl");
  });

  it("answerIsStaticOneShot suppresses the daily CTA only on answers that won't change tomorrow", () => {
    // Static one-shots -> no "every morning" button.
    for (const t of ["what does escrow mean", "define obsequious", "convert 100 usd to eur", "180c to f", "how many days until christmas", "calories in a banana", "how do you say hello in spanish"]) {
      expect(answerIsStaticOneShot(t), t).toBe(true);
    }
    // Time-varying asks -> keep the daily button.
    for (const t of ["what's the weather", "top news", "price of bitcoin", "did the lakers win", "what's on the hacker news front page"]) {
      expect(answerIsStaticOneShot(t), t).toBe(false);
    }
  });

  it("a clean answer offers tap-to-watch buttons; tapping 'Every morning' schedules it (tap-to-watch-on-answers)", async () => {
    const scheduled: string[] = [];
    const { handle, sent, acked } = harness({
      handleCommand: () => null,
      scheduleAdd: (_c, text) => { scheduled.push(text); return { ok: true, kind: "daily", task: text, whenMs: 0 }; },
      runAgentFn: async () => ({ reply: "Cloudy, 60°F.", steps: 1, tools: [] }),
    });
    await handle({ chatId: 1, from: "u", text: "weather in Paris", messageId: 1 } as InboundMessage);
    expect(sent[sent.length - 1]!.hasButtons).toBe(true);
    // Tap "Every morning" -> synthesizes "every morning weather in Paris" through the schedule path.
    await handle(tap(encodeCallback({ kind: "act", mode: "daily" })!));
    expect(scheduled.some((t) => /every morning weather in Paris/i.test(t))).toBe(true);
    expect(acked.some((a) => /Every morning/.test(a ?? ""))).toBe(true);
  });

  it("tapping 'Watch this' synthesizes a watch command from the last answer", async () => {
    let defined = "";
    const { handle } = harness({
      handleCommand: () => null,
      scheduleAdd: () => ({ ok: true, kind: "daily", task: "x", whenMs: 0 }),
      alertDefine: (_c, text) => { defined = text; return { ok: true, name: "bitcoin" }; },
      runAgentFn: async () => ({ reply: "$65,000", steps: 1, tools: [] }),
    });
    await handle({ chatId: 1, from: "u", text: "price of bitcoin", messageId: 1 } as InboundMessage);
    await handle(tap(encodeCallback({ kind: "act", mode: "watch" })!));
    expect(defined).toMatch(/watch bitcoin:.*price of bitcoin/i);
  });

  it("a stale act tap (no cached task) is handled gracefully", async () => {
    const { handle, sent, acked } = harness({ scheduleAdd: () => ({ ok: true, kind: "daily", task: "x", whenMs: 0 }) });
    await handle(tap(encodeCallback({ kind: "act", mode: "daily" })!));
    expect(sent[0]!.text).toMatch(/can't set that up/i);
    expect(acked[0]).toMatch(/Expired/);
  });

  it("an install tap saves the starter recipe (starter-automation-gallery)", async () => {
    const saved: Array<{ name: string; task: string }> = [];
    const { handle, sent, acked } = harness({
      recipeSaveNamed: (_c, name, task) => { saved.push({ name, task }); return { ok: true, name }; },
    });
    await handle(tap(encodeCallback({ kind: "install", id: "morning" })!));
    expect(saved[0]!.name).toBe("morning");
    expect(sent[0]!.text).toMatch(/Installed "morning"/);
    expect(acked[0]).toMatch(/Installed/);
  });

  it("an install tap for an unknown template is handled gracefully", async () => {
    const { handle, sent } = harness({ recipeSaveNamed: () => ({ ok: true, name: "x" }) });
    await handle(tap(encodeCallback({ kind: "install", id: "bogus" })!));
    expect(sent[0]!.text).toMatch(/isn't available/i);
  });

  it("rate-limited tap does not act", async () => {
    let refreshed = false;
    const { handle, acked } = harness({
      checkRateLimit: () => ({ allowed: false, retryAfterSec: 9 }),
      alertRunNow: async () => { refreshed = true; return { message: "x", commit: () => {} }; },
    });
    await handle(tap(encodeCallback({ kind: "alert", action: "refresh", name: "btc" })!));
    expect(refreshed).toBe(false);
    expect(acked[0]).toMatch(/Slow down/);
  });
});

describe("confirm-to-act button taps (confirm-to-act)", () => {
  const msg = (text: string, chatId = 1): InboundMessage => ({ chatId, from: "u", text, messageId: 0 } as InboundMessage);
  it("stash via a text turn (buttons attached), then a YES tap runs the click", async () => {
    const clicks: Array<{ url: string; selector: string }> = [];
    const edits: number[] = [];
    const { handle, sent } = harness({
      editReplyMarkup: async (_c, mid) => { edits.push(mid); },
      confirmAction: async (a) => { clicks.push(a); return { ok: true }; },
      runAgentFn: async () => ({ reply: "⚠️ click Buy? YES/NO", steps: 2, tools: ["browse"], pendingAction: { selector: "#buy", label: "Buy", url: "https://x.com/co" } }),
    });
    await handle(msg("buy it", 7));                     // agent previews -> stash + confirm buttons
    expect(sent.some((s) => s.hasButtons && /YES\/NO/.test(s.text))).toBe(true);
    await handle(tap(encodeCallback({ kind: "confirm", decision: "yes" })!, 7)); // tap YES
    expect(clicks).toEqual([{ url: "https://x.com/co", selector: "#buy" }]);
    expect(sent.some((s) => /Done — clicked "Buy"/.test(s.text))).toBe(true);
  });
  it("a NO tap discards without clicking", async () => {
    const clicks: unknown[] = [];
    const { handle, sent } = harness({
      editReplyMarkup: async () => {},
      confirmAction: async (a) => { clicks.push(a); return { ok: true }; },
      runAgentFn: async () => ({ reply: "…YES/NO", steps: 1, tools: [], pendingAction: { selector: "#pay", label: "Pay", url: "https://x.com" } }),
    });
    await handle(msg("pay", 7));
    await handle(tap(encodeCallback({ kind: "confirm", decision: "no" })!, 7));
    expect(clicks).toHaveLength(0);
    expect(sent.some((s) => /cancelled/i.test(s.text))).toBe(true);
  });
  it("a YES tap with nothing pending gives an honest 'no longer active' note", async () => {
    const { handle, sent } = harness({ editReplyMarkup: async () => {}, confirmAction: async () => ({ ok: true }) });
    await handle(tap(encodeCallback({ kind: "confirm", decision: "yes" })!, 7));
    expect(sent.some((s) => /no longer active/i.test(s.text))).toBe(true);
  });
});

describe("multi-turn browse continuity (persist-browse-session-across-turns)", () => {
  const mkMsg = (text: string, chatId = 1, messageId = 1): InboundMessage => ({ chatId, from: "u", text, messageId } as InboundMessage);

  it("carries an open session across turns (flag ON): turn 2 resumes turn 1's session", async () => {
    const prev = process.env.RELAY_BROWSE_CONTINUITY;
    process.env.RELAY_BROWSE_CONTINUITY = "1";
    try {
      const resumed: Array<string | undefined> = [];
      const released: string[] = [];
      let turn = 0;
      const { handle } = harness({
        handleCommand: () => null,
        releaseBrowseSession: (sid) => { released.push(sid); },
        runAgentFn: async (_text, d) => {
          resumed.push((d as { resumeSessionId?: string }).resumeSessionId);
          turn++;
          return { reply: `t${turn}`, steps: 1, tools: ["browse"], openSessionId: "sess-X" }; // keeps a session open
        },
      });
      await handle(mkMsg("open the flights page", 1, 1)); // turn 1 opens sess-X
      await handle(mkMsg("now sort by price", 1, 2));      // turn 2 should resume sess-X
      expect(resumed[0]).toBeUndefined();                  // turn 1 had nothing to resume
      expect(resumed[1]).toBe("sess-X");                   // turn 2 resumed the carried session
      expect(released).toEqual([]);                        // same session kept, nothing released mid-thread
    } finally {
      if (prev === undefined) delete process.env.RELAY_BROWSE_CONTINUITY; else process.env.RELAY_BROWSE_CONTINUITY = prev;
    }
  });

  it("flag OFF (default): no resume passed, session not carried", async () => {
    const prev = process.env.RELAY_BROWSE_CONTINUITY;
    delete process.env.RELAY_BROWSE_CONTINUITY;
    try {
      const resumed: Array<string | undefined> = [];
      const { handle } = harness({
        handleCommand: () => null,
        releaseBrowseSession: () => {},
        runAgentFn: async (_text, d) => { resumed.push((d as { resumeSessionId?: string }).resumeSessionId); return { reply: "x", steps: 1, tools: ["browse"], openSessionId: "sess-Y" }; },
      });
      await handle(mkMsg("browse a page", 1, 1));
      await handle(mkMsg("again", 1, 2));
      expect(resumed).toEqual([undefined, undefined]);     // continuity inert without the flag
    } finally {
      if (prev === undefined) delete process.env.RELAY_BROWSE_CONTINUITY; else process.env.RELAY_BROWSE_CONTINUITY = prev;
    }
  });

  it("hints ONCE that a page is held, and 'done' closes it (session-status-surface)", async () => {
    const prev = process.env.RELAY_BROWSE_CONTINUITY;
    process.env.RELAY_BROWSE_CONTINUITY = "1";
    try {
      const released: string[] = [];
      const { handle, sent } = harness({
        handleCommand: () => null,
        releaseBrowseSession: (sid) => { released.push(sid); },
        runAgentFn: async () => ({ reply: "here are the results", steps: 1, tools: ["browse"], openSessionId: "sess-H" }),
      });
      await handle(mkMsg("filter the flights", 1, 1));
      expect(sent[sent.length - 1]!.text).toMatch(/kept that page open/i);   // hinted turn 1
      await handle(mkMsg("filter more", 1, 2));
      expect(sent[sent.length - 1]!.text).not.toMatch(/kept that page open/i); // NOT re-hinted turn 2
      await handle(mkMsg("done", 1, 3));                                       // close intent
      expect(sent[sent.length - 1]!.text).toMatch(/closed that page/i);
      expect(released).toContain("sess-H");
    } finally {
      if (prev === undefined) delete process.env.RELAY_BROWSE_CONTINUITY; else process.env.RELAY_BROWSE_CONTINUITY = prev;
    }
  });

  it("a turn that stops browsing drops the carried session (flag ON)", async () => {
    const prev = process.env.RELAY_BROWSE_CONTINUITY;
    process.env.RELAY_BROWSE_CONTINUITY = "1";
    try {
      const released: string[] = [];
      let turn = 0;
      const { handle } = harness({
        handleCommand: () => null,
        releaseBrowseSession: (sid) => { released.push(sid); },
        runAgentFn: async () => { turn++; return turn === 1 ? { reply: "opened", steps: 1, tools: ["browse"], openSessionId: "sess-Z" } : { reply: "plain answer", steps: 1, tools: [] }; },
      });
      await handle(mkMsg("open a page", 1, 1)); // carries sess-Z
      await handle(mkMsg("what's 2+2", 1, 2));   // no browse -> drop + release sess-Z
      expect(released).toContain("sess-Z");
    } finally {
      if (prev === undefined) delete process.env.RELAY_BROWSE_CONTINUITY; else process.env.RELAY_BROWSE_CONTINUITY = prev;
    }
  });
});
