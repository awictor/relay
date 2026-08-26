import { describe, it, expect } from "vitest";
import { makeConsoleChannel } from "../src/channels/console.js";
import type { InboundMessage } from "../src/channel.js";

// Drive makeConsoleChannel with an injected line-reader + writer — no real stdin.
function harness(chatId?: number) {
  let handler: ((line: string) => void) | null = null;
  let unsubbed = false;
  const written: string[] = [];
  let thinking = 0;
  let quit = 0;
  const ch = makeConsoleChannel({
    onLine: (h) => { handler = h; return () => { unsubbed = true; }; },
    write: (t) => written.push(t),
    chatId,
    onThinking: () => { thinking++; },
    onQuit: () => { quit++; },
  });
  return { ch, feed: (line: string) => handler?.(line), written, wasUnsubbed: () => unsubbed, thinking: () => thinking, quit: () => quit };
}

describe("ConsoleChannel — Channel contract", () => {
  it("has name console + is always ready", () => {
    const { ch } = harness();
    expect(ch.name).toBe("console");
    expect(ch.ready()).toBe(true);
  });

  it("sendMessage writes to the writer", async () => {
    const { ch, written } = harness();
    await ch.sendMessage(1, "hello there");
    expect(written).toEqual(["hello there"]);
  });

  it("start() turns each input line into an InboundMessage handed to onMessage", async () => {
    const { ch, feed } = harness(99);
    const got: InboundMessage[] = [];
    ch.start(async (m) => { got.push(m); });
    feed("  top HN story  ");
    // allow the void-promise microtask to flush
    await Promise.resolve();
    expect(got).toHaveLength(1);
    expect(got[0]!.chatId).toBe(99);
    expect(got[0]!.text).toBe("top HN story"); // trimmed
    expect(got[0]!.from).toBe("console");
  });

  it("blank lines are ignored", async () => {
    const { ch, feed } = harness();
    const got: InboundMessage[] = [];
    ch.start(async (m) => { got.push(m); });
    feed("   ");
    feed("");
    await Promise.resolve();
    expect(got).toHaveLength(0);
  });

  it("a handler error is written, not thrown", async () => {
    const { ch, feed, written } = harness();
    ch.start(async () => { throw new Error("boom"); });
    feed("do it");
    await new Promise((r) => setTimeout(r, 5));
    expect(written.some((w) => /error/i.test(w) && /boom/.test(w))).toBe(true);
  });

  it("stop() unsubscribes the reader", () => {
    const { ch, wasUnsubbed } = harness();
    const h = ch.start(async () => {});
    h.stop();
    expect(wasUnsubbed()).toBe(true);
  });

  // m25 demo-2: UX hooks.
  it("fires onThinking when a real task is accepted (before the agent runs)", async () => {
    const { ch, feed, thinking } = harness();
    ch.start(async () => {});
    feed("what's the weather?");
    await Promise.resolve();
    expect(thinking()).toBe(1);
  });

  it("/quit ends the session: onQuit fires, a bye is written, no agent run", async () => {
    const { ch, feed, written, quit, thinking } = harness();
    const got: InboundMessage[] = [];
    ch.start(async (m) => { got.push(m); });
    feed("/quit");
    await Promise.resolve();
    expect(quit()).toBe(1);
    expect(written.some((w) => /bye/i.test(w))).toBe(true);
    expect(got).toHaveLength(0);      // never handed to the agent
    expect(thinking()).toBe(0);       // and no thinking indicator for a quit
  });

  it("/exit is an alias for /quit", async () => {
    const { ch, feed, quit } = harness();
    ch.start(async () => {});
    feed("/exit");
    await Promise.resolve();
    expect(quit()).toBe(1);
  });

  it("input after /quit is ignored (session stopped)", async () => {
    const { ch, feed } = harness();
    const got: InboundMessage[] = [];
    ch.start(async (m) => { got.push(m); });
    feed("/quit");
    feed("still here?");
    await Promise.resolve();
    expect(got).toHaveLength(0);
  });
});
