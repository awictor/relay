import { describe, it, expect } from "vitest";
import { makeConsoleChannel } from "../src/channels/console.js";
import type { InboundMessage } from "../src/channel.js";

// Drive makeConsoleChannel with an injected line-reader + writer — no real stdin.
function harness(chatId?: number) {
  let handler: ((line: string) => void) | null = null;
  let unsubbed = false;
  const written: string[] = [];
  const ch = makeConsoleChannel({
    onLine: (h) => { handler = h; return () => { unsubbed = true; }; },
    write: (t) => written.push(t),
    chatId,
  });
  return { ch, feed: (line: string) => handler?.(line), written, wasUnsubbed: () => unsubbed };
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
});
