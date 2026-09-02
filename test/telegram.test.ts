import { describe, it, expect } from "vitest";
import { parseUpdates, dispatchBatch } from "../src/telegram.js";
import type { InboundMessage } from "../src/telegram.js";

// Minimal Telegram update fixtures (only the fields parseUpdates reads).
const textMsg = (updateId: number, chatId: number, text: string, from?: { username?: string; first_name?: string }, messageId = 1) =>
  ({ update_id: updateId, message: { message_id: messageId, chat: { id: chatId }, text, from } });

describe("parseUpdates — inbound delivery contract", () => {
  it("maps a text message to an InboundMessage", () => {
    const { messages } = parseUpdates([textMsg(10, 555, "hello", { username: "alex" }, 7)], 0);
    expect(messages).toEqual([{ chatId: 555, text: "hello", from: "alex", messageId: 7 }]);
  });

  it("advances offset to max(update_id)+1", () => {
    const { nextOffset } = parseUpdates([textMsg(10, 1, "a"), textMsg(12, 1, "b"), textMsg(11, 1, "c")], 0);
    expect(nextOffset).toBe(13);
  });

  it("advances offset past a SKIPPED update so it can't redeliver forever", () => {
    // A non-text update (e.g. a sticker) — no message.text. Must still bump the offset.
    const sticker = { update_id: 20, message: { message_id: 1, chat: { id: 9 } } }; // no text
    const { messages, nextOffset } = parseUpdates([sticker], 0);
    expect(messages).toEqual([]);
    expect(nextOffset).toBe(21);
  });

  it("drops text-less and non-message updates but keeps the good ones", () => {
    const updates = [
      textMsg(1, 100, "keep me", { first_name: "Bob" }),
      { update_id: 2, edited_message: { message_id: 5, chat: { id: 100 }, text: "edited" } }, // not `message`
      { update_id: 3, message: { message_id: 6, chat: { id: 100 } } }, // no text
      textMsg(4, 200, "also keep"),
    ] as Parameters<typeof parseUpdates>[0];
    const { messages, nextOffset } = parseUpdates(updates, 0);
    expect(messages.map((m) => m.text)).toEqual(["keep me", "also keep"]);
    expect(nextOffset).toBe(5);
  });

  it("maps a photo message to an InboundMessage with photoFileId + caption as text (product-loop)", () => {
    const photo = { update_id: 30, message: { message_id: 8, chat: { id: 77 }, caption: "what's the total?",
      photo: [{ file_id: "small" }, { file_id: "large" }], from: { username: "alex" } } } as Parameters<typeof parseUpdates>[0][0];
    const { messages } = parseUpdates([photo], 0);
    expect(messages).toEqual([{ chatId: 77, text: "what's the total?", from: "alex", messageId: 8, photoFileId: "large" }]);
  });

  it("a captionless photo still delivers (empty text, largest file_id)", () => {
    const photo = { update_id: 31, message: { message_id: 9, chat: { id: 77 }, photo: [{ file_id: "only" }] } } as Parameters<typeof parseUpdates>[0][0];
    const { messages } = parseUpdates([photo], 0);
    expect(messages[0]).toMatchObject({ chatId: 77, text: "", photoFileId: "only" });
  });

  it("from falls back username -> first_name -> chatId string", () => {
    const r1 = parseUpdates([textMsg(1, 42, "x", { username: "u", first_name: "F" })], 0);
    expect(r1.messages[0].from).toBe("u");
    const r2 = parseUpdates([textMsg(1, 42, "x", { first_name: "F" })], 0);
    expect(r2.messages[0].from).toBe("F");
    const r3 = parseUpdates([textMsg(1, 42, "x", {})], 0);
    expect(r3.messages[0].from).toBe("42");
  });

  it("empty batch leaves offset unchanged", () => {
    expect(parseUpdates([], 99)).toEqual({ messages: [], nextOffset: 99 });
    expect(parseUpdates(undefined as unknown as [], 99)).toEqual({ messages: [], nextOffset: 99 });
  });

  it("never lowers the offset (out-of-order or stale batch)", () => {
    // offset already 50; a batch of older update_ids must not rewind it.
    const { nextOffset } = parseUpdates([textMsg(10, 1, "old")], 50);
    expect(nextOffset).toBe(50);
  });
});

describe("dispatchBatch (DEV-0037 concurrent, no head-of-line block)", () => {
  const im = (chatId: number, text: string): InboundMessage => ({ chatId, text, from: "u", messageId: 1 } as InboundMessage);

  it("a slow chat does NOT delay a fast chat's handler START", async () => {
    const started: number[] = [];
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => { releaseSlow = r; });
    const onMessage = async (m: InboundMessage) => {
      started.push(m.chatId);
      if (m.chatId === 1) await slow; // chat 1 blocks until released
    };
    // chat 1 (slow) is first in the batch; chat 2 must still start immediately
    const p = dispatchBatch([im(1, "slow"), im(2, "fast")], onMessage);
    await Promise.resolve(); await Promise.resolve();
    expect(started).toContain(2); // fast chat started despite slow chat pending (sequential would NOT)
    releaseSlow();
    await p;
  });

  it("one handler throwing does not sink the rest of the batch", async () => {
    const done: number[] = [];
    const errors: unknown[] = [];
    const onMessage = async (m: InboundMessage) => {
      if (m.chatId === 1) throw new Error("boom");
      done.push(m.chatId);
    };
    await dispatchBatch([im(1, "bad"), im(2, "ok"), im(3, "ok")], onMessage, (e) => errors.push(e));
    expect(done.sort()).toEqual([2, 3]);
    expect(errors).toHaveLength(1);
  });

  it("resolves only after ALL handlers settle", async () => {
    let finished = 0;
    const onMessage = async () => { await Promise.resolve(); finished++; };
    await dispatchBatch([im(1, "a"), im(2, "b")], onMessage);
    expect(finished).toBe(2);
  });

  it("DEV-0141: bounds in-flight handlers at DISPATCH_CONCURRENCY (default 4) while still running all", async () => {
    // 9 chats, default cap 4: an active-counter proves no more than 4 handlers run at once (protects
    // the bounded anvil session pool), yet every handler still runs and the promise settles after all.
    let active = 0, maxActive = 0, done = 0;
    const onMessage = async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--; done++;
    };
    const batch = Array.from({ length: 9 }, (_, i) => im(i + 1, "x"));
    await dispatchBatch(batch, onMessage);
    expect(maxActive).toBeLessThanOrEqual(4); // never more than the cap concurrently
    expect(maxActive).toBeGreaterThan(1); // but genuinely concurrent, not sequential
    expect(done).toBe(9); // all handlers ran
  });

  it("DEV-0141: bound still isolates a throwing handler (onError per message, batch survives)", async () => {
    const done: number[] = [];
    const errors: unknown[] = [];
    const onMessage = async (m: InboundMessage) => {
      await new Promise((r) => setTimeout(r, 5));
      if (m.chatId % 3 === 0) throw new Error("boom");
      done.push(m.chatId);
    };
    const batch = Array.from({ length: 9 }, (_, i) => im(i + 1, "x"));
    await dispatchBatch(batch, onMessage, (e) => errors.push(e));
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 4, 5, 7, 8]); // non-multiples of 3
    expect(errors).toHaveLength(3); // 3, 6, 9 threw, each caught individually
  });
});
