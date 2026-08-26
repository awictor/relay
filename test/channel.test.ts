import { describe, it, expect } from "vitest";
import { telegramChannel, selectChannel, type Channel } from "../src/channel.js";
import { createHandler } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";
import type { LLMMessage } from "../src/llm.js";

describe("telegramChannel — Channel contract", () => {
  it("implements the interface surface", () => {
    expect(telegramChannel.name).toBe("telegram");
    expect(typeof telegramChannel.start).toBe("function");
    expect(typeof telegramChannel.sendMessage).toBe("function");
    expect(typeof telegramChannel.ready).toBe("function");
    // optional senders present for telegram
    expect(typeof telegramChannel.sendTyping).toBe("function");
    expect(typeof telegramChannel.sendPhoto).toBe("function");
    expect(typeof telegramChannel.sendDocument).toBe("function");
  });

  it("ready() reflects token presence without throwing", () => {
    expect(typeof telegramChannel.ready()).toBe("boolean");
  });
});

describe("selectChannel", () => {
  it("defaults to telegram (undefined / unknown / explicit)", () => {
    // Don't select "console" here — nodeConsoleChannel opens stdin on construct.
    expect(selectChannel(undefined).name).toBe("telegram");
    expect(selectChannel("telegram").name).toBe("telegram");
    expect(selectChannel("TELEGRAM").name).toBe("telegram"); // case-insensitive
    expect(selectChannel("nonsense").name).toBe("telegram"); // unknown -> fallback
  });
});

// Prove the agent core is transport-agnostic: a fake in-memory Channel drives the SAME
// handler and gets the reply. No Telegram/network.
describe("handler over an arbitrary Channel", () => {
  it("routes a normal message through any channel's sendMessage", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const fake: Channel = {
      name: "fake",
      start: (onMessage) => { void onMessage; return { stop: () => {} }; },
      sendMessage: async (chatId, text) => { sent.push({ chatId, text }); },
      ready: () => true,
    };

    const handle = createHandler({
      llm: {} as never,
      memoryGet: () => [] as LLMMessage[],
      memorySet: () => {},
      memoryClear: () => false,
      sendMessage: (id, t) => fake.sendMessage(id, t),
      sendTyping: async () => {},
      handleCommand: () => null,
      checkRateLimit: () => ({ allowed: true }),
      redactText: (t) => t,
      hasModelKey: () => true,
      recordTurn: () => {},
      now: () => 0,
      runAgentFn: async () => ({ reply: "answer from agent", steps: 1, tools: [] }),
    });

    const msg: InboundMessage = { chatId: 7, text: "hi", from: "u", messageId: 1 } as InboundMessage;
    await handle(msg);
    expect(sent).toEqual([{ chatId: 7, text: "answer from agent" }]);
  });
});
