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
import { MemoryStore } from "./lib/memory-store.js";
import { formatReply } from "./lib/format-reply.js";
import { formatTurnLog } from "./lib/turn-log.js";
import { Metrics } from "./lib/metrics.js";

const llm = new GeminiClient();

// Rolling aggregate health; a summary line is emitted every N turns so the operator
// sees ok/fail rate, avg steps, latency percentiles + tool mix without parsing [out].
const metrics = new Metrics();
const METRICS_EVERY = Number(process.env.RELAY_METRICS_EVERY ?? 50);
let turnCount = 0;
function recordTurn(t: { steps: number; tools: string[]; elapsedMs: number; ok: boolean }) {
  metrics.record(t);
  if (++turnCount % METRICS_EVERY === 0) console.log(metrics.format());
}

// Per-chat rolling memory (last few turns). Bounded to keep prompts small, and PERSISTED to a local
// JSON file (DEV-0001) so a redeploy/restart no longer wipes every conversation. Path is env-tunable;
// the file is gitignored. Free-infra: a plain file, no DB.
const MEMORY_TURNS = 6;
const memory = new MemoryStore({
  file: process.env.RELAY_MEMORY_FILE ?? "data/relay-memory.json",
  maxTurns: MEMORY_TURNS * 2,
});

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

  const history = memory.get(msg.chatId) as LLMMessage[];
  const startedAt = Date.now();
  try {
    await sendTyping(msg.chatId); // show "typing…" while the agent works
    const { reply, steps, tools } = await runAgent(msg.text, { llm }, history);
    const out = formatReply(reply); // SMS-friendly: render stray JSON as lines, trim length
    await sendMessage(msg.chatId, out);

    // Append this turn to memory (user + assistant); the store trims to its maxTurns + persists.
    const next: LLMMessage[] = [...history, { role: "user", content: msg.text }, { role: "assistant", content: out }];
    memory.set(msg.chatId, next);
    const elapsedMs = Date.now() - startedAt;
    console.log(formatTurnLog({ chatId: msg.chatId, steps, tools, elapsedMs, replyChars: out.length, ok: true }));
    recordTurn({ steps, tools, elapsedMs, ok: true });
  } catch (e) {
    const emsg = e instanceof Error ? e.message : String(e);
    console.error("agent error:", emsg);
    const elapsedMs = Date.now() - startedAt;
    console.log(formatTurnLog({ chatId: msg.chatId, steps: 0, tools: [], elapsedMs, replyChars: 0, ok: false, error: emsg }));
    recordTurn({ steps: 0, tools: [], elapsedMs, ok: false });
    // Friendlier message for the common transient model-overload case.
    if (/\b(503|429|UNAVAILABLE|high demand|overloaded|rate)/i.test(emsg)) {
      await sendMessage(msg.chatId, "My brain's overloaded right now (free-tier model is busy). Try again in a moment.");
    } else {
      await sendMessage(msg.chatId, `Sorry — something went wrong: ${emsg}`);
    }
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
