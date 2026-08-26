// ConsoleChannel (m5 chan-2): a 2nd transport behind the Channel interface — read lines
// from stdin, print replies to stdout. Lets you drive the REAL agent from a terminal
// (dev/demo win) and proves >1 transport works with the unchanged agent/handler. Free,
// offline. The line-reader is injectable so it's unit-tested without real stdin.

import readline from "node:readline";
import type { Channel, InboundMessage } from "../channel.js";

export interface ConsoleChannelDeps {
  // A subscribe-style reader: calls onLine for each input line, returns an unsubscribe.
  onLine: (handler: (line: string) => void) => () => void;
  write: (text: string) => void;
  chatId?: number; // console is single-user; a fixed id (default 1)
}

/** Build a ConsoleChannel. Prod wiring passes a readline-backed onLine + console.log. */
export function makeConsoleChannel(deps: ConsoleChannelDeps): Channel {
  const chatId = deps.chatId ?? 1;
  return {
    name: "console",
    ready: () => true, // no credentials needed
    start(onMessage: (msg: InboundMessage) => Promise<void>) {
      const unsub = deps.onLine((line) => {
        const text = line.trim();
        if (!text) return;
        const msg: InboundMessage = { chatId, text, from: "console", messageId: Date.now() % 1_000_000 };
        void onMessage(msg).catch((e) => deps.write(`[error] ${e instanceof Error ? e.message : String(e)}`));
      });
      return { stop: () => unsub() };
    },
    async sendMessage(_chatId: number, text: string) {
      deps.write(text);
    },
    async sendTyping() { /* no-op on console */ },
    // No photo/document on a text console — omitted so the handler falls back to text.
  };
}

/**
 * Production ConsoleChannel backed by Node's readline over stdin/stdout. Kept out of the
 * pure factory so tests never touch real stdin. Import lazily where wired.
 */
export function nodeConsoleChannel(): Channel {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  let closed = false;
  // Re-prompt only while open. On EOF (piped input / Ctrl-D) readline fires "close"; prompting after
  // that throws ERR_USE_AFTER_CLOSE, so guard it (this crashed `npm run demo` on piped stdin).
  const reprompt = () => { if (closed) return; try { rl.prompt(); } catch { closed = true; } };
  return makeConsoleChannel({
    onLine: (handler) => {
      const fn = (line: string) => { handler(line); reprompt(); };
      rl.on("line", fn);
      rl.once("close", () => { closed = true; });
      reprompt();
      return () => { closed = true; rl.off("line", fn); rl.close(); };
    },
    write: (text) => { process.stdout.write("\n" + text + "\n"); }, // always print, even a reply that lands after EOF
  });
}
