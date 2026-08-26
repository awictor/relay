import { describe, it, expect } from "vitest";
import { parseUpdates } from "../src/telegram.js";

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
