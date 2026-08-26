// Relay entrypoint. Telegram long-poll -> agent (Gemini + anvil browser) -> reply.
// Per-chat short memory so follow-ups have context. Falls back to a clear message
// if keys/anvil are missing so it never hangs silently.

import { startPolling, sendMessage, sendTyping, hasToken, type InboundMessage } from "./telegram.js";
import { anvilLive } from "./anvil.js";
import { runAgent } from "./agent.js";
import { GeminiClient } from "./llm.js";
import type { LLMMessage } from "./llm.js";
import { checkRateLimit, redactText } from "./safety.js";
import { handleCommand } from "./commands.js";

const llm = new GeminiClient();

// Per-chat rolling memory (last few turns). Bounded to keep prompts small.
const MEMORY_TURNS = 6;
const memory = new Map<number, LLMMessage[]>();

async function handle(msg: InboundMessage): Promise<void> {
  console.log(`[in] ${msg.from}: ${redactText(msg.text).slice(0, 120)}`);

  // Slash commands (/start, /help) reply instantly, no rate-limit/agent needed.
  const cmd = handleCommand(msg.text);
  if (cmd) { await sendMessage(msg.chatId, cmd); return; }

  const rl = checkRateLimit(msg.chatId);
  if (!rl.allowed) {
    await sendMessage(msg.chatId, `You're sending a lot — give me ${rl.retryAfterSec}s to catch up.`);
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    await sendMessage(msg.chatId, "I'm not fully configured yet (missing model key). Try again soon.");
    return;
  }

  const history = memory.get(msg.chatId) ?? [];
  try {
    await sendTyping(msg.chatId); // show "typing…" while the agent works
    const { reply } = await runAgent(msg.text, { llm }, history);
    await sendMessage(msg.chatId, reply);

    // Append this turn to memory (user + assistant), trim to MEMORY_TURNS.
    const next: LLMMessage[] = [...history, { role: "user", content: msg.text }, { role: "assistant", content: reply }];
    memory.set(msg.chatId, next.slice(-MEMORY_TURNS * 2));
  } catch (e) {
    console.error("agent error:", e instanceof Error ? e.message : String(e));
    await sendMessage(msg.chatId, `Sorry — something went wrong: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}

async function main() {
  if (!hasToken()) {
    console.error("TELEGRAM_BOT_TOKEN not set — copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  const live = await anvilLive();
  console.log(`anvil reachable: ${live} (ANVIL_BASE_URL=${process.env.ANVIL_BASE_URL ?? "http://localhost:3000"})`);
  if (!live) console.warn("WARNING: anvil-engine not reachable — browsing tools will fail until it's running.");
  if (!process.env.GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEY not set — the agent can't run until it's provided.");

  console.log("Relay polling Telegram…");
  startPolling(handle);
}

main();
