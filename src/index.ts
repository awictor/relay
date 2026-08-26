// Relay entrypoint. Telegram long-poll -> agent (Gemini + anvil browser) -> reply.
// Per-chat short memory so follow-ups have context. Falls back to a clear message
// if keys/anvil are missing so it never hangs silently.

import { startPolling, sendMessage, sendPhoto, sendDocument, sendTyping, hasToken } from "./telegram.js";
import { anvilLive } from "./anvil.js";
import { GeminiClient } from "./llm.js";
import type { LLMMessage } from "./llm.js";
import { checkRateLimit, redactText } from "./safety.js";
import { handleCommand } from "./commands.js";
import { MemoryStore } from "./lib/memory-store.js";
import { Metrics } from "./lib/metrics.js";
import { createHandler } from "./handler.js";
import { createShutdown, installSignalHandlers } from "./shutdown.js";
import { formatStatus, makeAnvilPinger } from "./lib/status.js";

const llm = new GeminiClient();

// Process start, for /status uptime (DEV-0024). Anvil reachability is kept fresh by a periodic
// pinger (DEV-0025) instead of a boot-only seed, so /status doesn't go stale when the browser drops.
const startMs = Date.now();
const ANVIL_PING_MS = Number(process.env.RELAY_ANVIL_PING_MS ?? 60_000); // 0 disables the refresh
const anvilPinger = makeAnvilPinger({ probe: anvilLive, periodMs: ANVIL_PING_MS });

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

const handle = createHandler({
  llm,
  memoryGet: (id) => memory.get(id) as LLMMessage[],
  memorySet: (id, history) => memory.set(id, history),
  memoryClear: (id) => memory.delete(id),
  statusLine: () => formatStatus({ uptimeMs: Date.now() - startMs, turns: metrics.summary().turns, anvilOk: anvilPinger.current() }),
  sendMessage,
  sendPhoto,
  sendDocument,
  sendTyping,
  handleCommand,
  checkRateLimit,
  redactText,
  hasModelKey: () => !!process.env.GEMINI_API_KEY,
  recordTurn,
  now: () => Date.now(),
});

async function main() {
  if (!hasToken()) {
    console.error("TELEGRAM_BOT_TOKEN not set — copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  await anvilPinger.tick();            // seed reachability now
  anvilPinger.start();                 // then keep it fresh (no-op if RELAY_ANVIL_PING_MS=0)
  const live = anvilPinger.current();
  console.log(`anvil reachable: ${live} (ANVIL_BASE_URL=${process.env.ANVIL_BASE_URL ?? "http://localhost:3000"})`);
  if (!live) console.warn("WARNING: anvil-engine not reachable — browsing tools will fail until it's running.");
  if (!process.env.GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEY not set — the agent can't run until it's provided.");

  console.log("Relay polling Telegram…");
  const poller = startPolling(handle);
  // Clean stop on docker stop / pm2 restart / Ctrl-C: halt polling, exit 0. Memory is
  // already durable (MemoryStore persists synchronously each turn).
  installSignalHandlers(createShutdown({
    stopPolling: () => { poller.stop(); anvilPinger.stop(); },
    onShutdown: () => console.log(metrics.format()), // flush the final metrics window (DEV-0041)
    log: (m) => console.log(m),
    exit: (code) => process.exit(code),
  }));
}

main();
