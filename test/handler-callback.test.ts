import { describe, it, expect } from "vitest";
import { createHandler, canOfferAutomation, answerIsWatchable, watchSlug, type HandlerDeps } from "../src/handler.js";
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
