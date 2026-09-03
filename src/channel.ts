// Channel interface (m5): the transport Relay talks to, so the agent core is
// transport-agnostic. Telegram was the only channel; this abstracts send/receive so a
// 2nd transport (console, Discord, ...) drops in without touching the agent/handler.
// The handler + scheduler already take send fns as deps — a Channel just bundles them
// per transport.

import type { InboundMessage } from "./telegram.js";
import type { InlineKeyboard } from "./lib/callbacks.js";

export type { InboundMessage };

export interface Channel {
  readonly name: string;
  /** Begin receiving; each inbound message is handed to onMessage. Returns a stop handle. */
  start(onMessage: (msg: InboundMessage) => Promise<void>): { stop: () => void };
  /** Send text, optionally with a one-tap inline keyboard (inline-tap-buttons). A channel that can't
   * render buttons (console) ignores the keyboard and sends the text. */
  sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<unknown>;
  /** Acknowledge an inline-button tap (inline-tap-buttons) so the client clears its spinner; optional
   * toast confirms. Optional — a channel without inline buttons (console) omits it. */
  answerCallback?(callbackQueryId: string, toast?: string): Promise<unknown>;
  sendTyping?(chatId: number): Promise<unknown>;
  sendPhoto?(chatId: number, bytes: Uint8Array, caption?: string): Promise<unknown>;
  sendDocument?(chatId: number, bytes: Uint8Array, filename?: string, caption?: string): Promise<unknown>;
  /** Send a message with a one-tap "share location" affordance (one-shot-location-button). Optional —
   * a channel without it (console) just falls back to a plain sendMessage in the handler. */
  requestLocation?(chatId: number, text: string): Promise<unknown>;
  /** True when the channel is configured enough to run (e.g. token present). */
  ready(): boolean;
}

// TelegramChannel: wraps the existing src/telegram.ts functions as a Channel. No behavior
// change — index.ts just talks to this instead of importing telegram fns directly.
import { startPolling, sendMessage, sendTyping, sendPhoto, sendDocument, sendLocationRequest, answerCallback, hasToken } from "./telegram.js";

export const telegramChannel: Channel = {
  name: "telegram",
  start: (onMessage) => startPolling(onMessage),
  sendMessage: (chatId, text, keyboard) => sendMessage(chatId, text, keyboard),
  answerCallback: (id, toast) => answerCallback(id, toast),
  sendTyping: (chatId) => sendTyping(chatId),
  sendPhoto: (chatId, bytes, caption) => sendPhoto(chatId, bytes, caption),
  sendDocument: (chatId, bytes, filename, caption) => sendDocument(chatId, bytes, filename, caption),
  requestLocation: (chatId, text) => sendLocationRequest(chatId, text),
  ready: () => hasToken(),
};

import { nodeConsoleChannel } from "./channels/console.js";

/**
 * Pick the transport by name (RELAY_CHANNEL: telegram | console). nodeConsoleChannel
 * only opens stdin when constructed, so building it here is fine. Unknown names fall
 * back to telegram. Pure selection given an env value.
 */
export function selectChannel(name: string | undefined): Channel {
  switch ((name ?? "telegram").toLowerCase()) {
    case "console": return nodeConsoleChannel();
    case "telegram":
    default:        return telegramChannel;
  }
}
