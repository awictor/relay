// Channel interface (m5): the transport Relay talks to, so the agent core is
// transport-agnostic. Telegram was the only channel; this abstracts send/receive so a
// 2nd transport (console, Discord, ...) drops in without touching the agent/handler.
// The handler + scheduler already take send fns as deps — a Channel just bundles them
// per transport.

import type { InboundMessage } from "./telegram.js";

export type { InboundMessage };

export interface Channel {
  readonly name: string;
  /** Begin receiving; each inbound message is handed to onMessage. Returns a stop handle. */
  start(onMessage: (msg: InboundMessage) => Promise<void>): { stop: () => void };
  sendMessage(chatId: number, text: string): Promise<unknown>;
  sendTyping?(chatId: number): Promise<unknown>;
  sendPhoto?(chatId: number, bytes: Uint8Array, caption?: string): Promise<unknown>;
  sendDocument?(chatId: number, bytes: Uint8Array, filename?: string, caption?: string): Promise<unknown>;
  /** True when the channel is configured enough to run (e.g. token present). */
  ready(): boolean;
}

// TelegramChannel: wraps the existing src/telegram.ts functions as a Channel. No behavior
// change — index.ts just talks to this instead of importing telegram fns directly.
import { startPolling, sendMessage, sendTyping, sendPhoto, sendDocument, hasToken } from "./telegram.js";

export const telegramChannel: Channel = {
  name: "telegram",
  start: (onMessage) => startPolling(onMessage),
  sendMessage: (chatId, text) => sendMessage(chatId, text),
  sendTyping: (chatId) => sendTyping(chatId),
  sendPhoto: (chatId, bytes, caption) => sendPhoto(chatId, bytes, caption),
  sendDocument: (chatId, bytes, filename, caption) => sendDocument(chatId, bytes, filename, caption),
  ready: () => hasToken(),
};
