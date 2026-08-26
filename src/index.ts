// Relay entrypoint. Telegram long-poll -> agent (Gemini + anvil browser) -> reply.
// Per-chat short memory so follow-ups have context. Falls back to a clear message
// if keys/anvil are missing so it never hangs silently.

import { selectChannel, type Channel } from "./channel.js";
import { anvilLive } from "./anvil.js";
import { GeminiClient } from "./llm.js";
import type { LLMMessage } from "./llm.js";
import { checkRateLimit, redactText } from "./safety.js";
import { handleCommand } from "./commands.js";
import { MemoryStore } from "./lib/memory-store.js";
import { Metrics } from "./lib/metrics.js";
import { createHandler } from "./handler.js";
import { createShutdown, installSignalHandlers, installCrashHandlers } from "./shutdown.js";
import { formatStatus, makeAnvilPinger } from "./lib/status.js";
import { runAgent } from "./agent.js";
import { formatReply } from "./lib/format-reply.js";
import { ScheduleStore, parseSchedule } from "./lib/schedule.js";
import { makeScheduleRunner } from "./schedule-runner.js";
import { RecipeStore, parseRecipeCommand, parseRunCommand } from "./lib/recipes.js";

const llm = new GeminiClient();

// The transport Relay runs on (m5), chosen by RELAY_CHANNEL (telegram default | console).
const channel: Channel = selectChannel(process.env.RELAY_CHANNEL);
const sendMessage = (chatId: number, text: string) => channel.sendMessage(chatId, text);
const sendTyping = (chatId: number) => channel.sendTyping ? channel.sendTyping(chatId) : Promise.resolve();
const sendPhoto = channel.sendPhoto ? channel.sendPhoto.bind(channel) : undefined;
const sendDocument = channel.sendDocument ? channel.sendDocument.bind(channel) : undefined;

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

// Proactive/scheduled tasks (m4): persisted schedules + a runner that fires them through
// the agent and texts the result unprompted. Free-infra: a JSON file + an interval, no cron.
const schedules = new ScheduleStore({ file: process.env.RELAY_SCHEDULE_FILE ?? "data/relay-schedules.json" });
const recipes = new RecipeStore({ file: process.env.RELAY_RECIPE_FILE ?? "data/relay-recipes.json" });
const SCHED_TICK_MS = Number(process.env.RELAY_SCHED_TICK_MS ?? 30_000); // 0 disables
const scheduleRunner = makeScheduleRunner({
  store: schedules, llm, runAgent, send: sendMessage, formatReply,
  now: () => Date.now(), periodMs: SCHED_TICK_MS,
  log: (m) => console.log(m),
});

const handle = createHandler({
  llm,
  memoryGet: (id) => memory.get(id) as LLMMessage[],
  memorySet: (id, history) => memory.set(id, history),
  memoryClear: (id) => memory.delete(id),
  statusLine: () => formatStatus({ uptimeMs: Date.now() - startMs, turns: metrics.summary().turns, anvilOk: anvilPinger.current() }),
  scheduleAdd: (chatId, text, now) => {
    const p = parseSchedule(text, now);
    if (!p) return { ok: false, reason: "unparsed" };
    const rec = schedules.add(chatId, p, now);
    if (!rec) return { ok: false, reason: "capped" };
    return { ok: true, kind: rec.kind, task: rec.task, whenMs: rec.dueMs };
  },
  scheduleList: (chatId) => schedules.list(chatId).map((s) => ({ id: s.id, kind: s.kind, task: s.task, dueMs: s.dueMs })),
  scheduleCancel: (chatId, which) => {
    if (which.toLowerCase() === "all") {
      const all = schedules.list(chatId);
      let n = 0; for (const s of all) if (schedules.remove(s.id, chatId)) n++;
      return { removed: n };
    }
    return { removed: schedules.remove(which, chatId) ? 1 : 0 };
  },
  recipeSave: (chatId, text) => {
    const p = parseRecipeCommand(text);
    if (!p) return { ok: false, reason: "unparsed" };
    const rec = recipes.add(chatId, p, Date.now());
    if (!rec) return { ok: false, reason: "capped" };
    return { ok: true, name: rec.name };
  },
  recipeResolve: (chatId, text) => {
    const name = parseRunCommand(text);
    if (!name) return null;
    const rec = recipes.get(chatId, name);
    return rec ? { name: rec.name, task: rec.task } : null;
  },
  recipeList: (chatId) => recipes.list(chatId).map((r) => ({ name: r.name, task: r.task, schedule: r.schedule })),
  recipeForget: (chatId, name) => recipes.remove(chatId, name),
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
  if (!channel.ready()) {
    console.error(`Channel "${channel.name}" not configured (e.g. TELEGRAM_BOT_TOKEN) — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  await anvilPinger.tick();            // seed reachability now
  anvilPinger.start();                 // then keep it fresh (no-op if RELAY_ANVIL_PING_MS=0)
  const live = anvilPinger.current();
  console.log(`anvil reachable: ${live} (ANVIL_BASE_URL=${process.env.ANVIL_BASE_URL ?? "http://localhost:3000"})`);
  if (!live) console.warn("WARNING: anvil-engine not reachable — browsing tools will fail until it's running.");
  if (!process.env.GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEY not set — the agent can't run until it's provided.");

  scheduleRunner.start();              // fire proactive/scheduled tasks (no-op if RELAY_SCHED_TICK_MS=0)
  if (SCHED_TICK_MS > 0) console.log(`schedule runner on (${schedules.size()} pending, tick ${SCHED_TICK_MS}ms)`);

  console.log(`Relay listening on ${channel.name}…`);
  const poller = channel.start(handle);
  // Clean stop on docker stop / pm2 restart / Ctrl-C: halt polling, exit 0. Memory is
  // already durable (MemoryStore persists synchronously each turn).
  installSignalHandlers(createShutdown({
    stopPolling: () => { poller.stop(); anvilPinger.stop(); scheduleRunner.stop(); },
    onShutdown: () => console.log(metrics.format()), // flush the final metrics window (DEV-0041)
    log: (m) => console.log(m),
    exit: (code) => process.exit(code),
  }));

  // Last-breath handlers (DEV-0066): a stray throw / rejected promise otherwise kills the 24/7
  // worker with no log. Emit the final metrics window + a [fatal] line, then exit 1 so the
  // supervisor restarts.
  installCrashHandlers({
    log: (m) => console.error(m),
    onFatal: () => console.log(metrics.format()),
  });
}

main();
