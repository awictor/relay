// The per-message handler wiring, factored out of index.ts so it's unit-testable with
// injected deps (no live Telegram/LLM/anvil). index.ts builds the real deps; tests pass
// fakes. Flow: slash-command short-circuit -> rate limit -> config check -> agent ->
// SMS-format reply -> persist memory -> per-turn [out]/[metrics] logging.

import type { InboundMessage } from "./telegram.js";
import type { LLMMessage, LLMClient } from "./llm.js";
import { runAgent, type AgentDeps } from "./agent.js";
import { formatReply } from "./lib/format-reply.js";
import { formatTurnLog } from "./lib/turn-log.js";

export interface HandlerDeps {
  llm: LLMClient;
  memoryGet: (chatId: number) => LLMMessage[];
  memorySet: (chatId: number, history: LLMMessage[]) => void;
  sendMessage: (chatId: number, text: string) => Promise<unknown>;
  // Send an image (screenshot tool, DEV-0027). Optional: when absent, a photo result is dropped
  // and only the text reply goes out (older wiring stays valid).
  sendPhoto?: (chatId: number, bytes: Uint8Array, caption?: string) => Promise<unknown>;
  sendTyping: (chatId: number) => Promise<unknown>;
  handleCommand: (text: string) => string | null;
  // Clear this chat's stored history (/reset). Returns true if there was anything to clear.
  memoryClear: (chatId: number) => boolean;
  // One-line health reply for /status (uptime + turns + browser reachability). Optional:
  // when absent, /status falls through to the agent (older wiring stays valid).
  statusLine?: () => string;
  checkRateLimit: (chatId: number) => { allowed: boolean; retryAfterSec?: number };
  redactText: (text: string) => string;
  hasModelKey: () => boolean;
  recordTurn: (t: { steps: number; tools: string[]; elapsedMs: number; ok: boolean }) => void;
  now: () => number;
  // Optional override so tests don't hit the real agent loop.
  runAgentFn?: (userText: string, deps: AgentDeps, history: LLMMessage[]) => Promise<{ reply: string; steps: number; tools: string[]; photo?: Uint8Array }>;
  log?: (line: string) => void;
}

/** Build the message handler. Returns an async (msg) => void. */
export function createHandler(deps: HandlerDeps): (msg: InboundMessage) => Promise<void> {
  const runIt = deps.runAgentFn ?? runAgent;
  const log = deps.log ?? console.log;

  return async function handle(msg: InboundMessage): Promise<void> {
    log(`[in] ${msg.from}: ${deps.redactText(msg.text).slice(0, 120)}`);

    // /reset (alias /clear): wipe THIS chat's memory. Needs chatId, so it's handled here rather
    // than in the pure handleCommand. Short-circuits before rate-limit/agent, like other commands.
    const first = msg.text.trim().toLowerCase().split(/\s+/)[0]?.split("@")[0];
    if (first === "/reset" || first === "/clear") {
      const had = deps.memoryClear(msg.chatId);
      await deps.sendMessage(msg.chatId, had ? "Cleared our conversation — starting fresh." : "Nothing to clear — we've got no history yet.");
      return;
    }

    // /status: one-line health (uptime + tasks handled + browser reachability). No agent run.
    if (first === "/status" && deps.statusLine) {
      await deps.sendMessage(msg.chatId, deps.statusLine());
      return;
    }

    // Slash commands reply instantly — no rate-limit/agent.
    const cmd = deps.handleCommand(msg.text);
    if (cmd) { await deps.sendMessage(msg.chatId, cmd); return; }

    const rl = deps.checkRateLimit(msg.chatId);
    if (!rl.allowed) {
      await deps.sendMessage(msg.chatId, `You're sending a lot — give me ${rl.retryAfterSec}s to catch up.`);
      return;
    }

    if (!deps.hasModelKey()) {
      await deps.sendMessage(msg.chatId, "I'm not fully configured yet (missing model key). Try again soon.");
      return;
    }

    const history = deps.memoryGet(msg.chatId);
    const startedAt = deps.now();
    try {
      await deps.sendTyping(msg.chatId);
      const { reply, steps, tools, photo } = await runIt(msg.text, { llm: deps.llm }, history);
      const out = formatReply(reply);
      // If the agent captured a screenshot, send the image first (with the reply as caption), then
      // the text — so the user sees the picture even if the caption is long. Falls back to text-only
      // when no sendPhoto is wired or no photo was taken.
      if (photo && deps.sendPhoto) {
        await deps.sendPhoto(msg.chatId, photo, out.slice(0, 1024));
        if (out.length > 1024) await deps.sendMessage(msg.chatId, out);
      } else {
        await deps.sendMessage(msg.chatId, out);
      }

      const next: LLMMessage[] = [...history, { role: "user", content: msg.text }, { role: "assistant", content: out }];
      deps.memorySet(msg.chatId, next);
      const elapsedMs = deps.now() - startedAt;
      log(formatTurnLog({ chatId: msg.chatId, steps, tools, elapsedMs, replyChars: out.length, ok: true }));
      deps.recordTurn({ steps, tools, elapsedMs, ok: true });
    } catch (e) {
      const emsg = e instanceof Error ? e.message : String(e);
      console.error("agent error:", emsg);
      const elapsedMs = deps.now() - startedAt;
      log(formatTurnLog({ chatId: msg.chatId, steps: 0, tools: [], elapsedMs, replyChars: 0, ok: false, error: emsg }));
      deps.recordTurn({ steps: 0, tools: [], elapsedMs, ok: false });
      if (/\b(503|429|UNAVAILABLE|high demand|overloaded|rate)/i.test(emsg)) {
        await deps.sendMessage(msg.chatId, "My brain's overloaded right now (free-tier model is busy). Try again in a moment.");
      } else {
        await deps.sendMessage(msg.chatId, `Sorry — something went wrong: ${emsg}`);
      }
    }
  };
}
