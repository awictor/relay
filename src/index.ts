// Relay entrypoint. Telegram long-poll -> agent (Gemini + anvil browser) -> reply.
// Per-chat short memory so follow-ups have context. Falls back to a clear message
// if keys/anvil are missing so it never hangs silently.

import { selectChannel, type Channel } from "./channel.js";
import { anvilLive } from "./anvil.js";
import { GeminiClient, ClaudeClient } from "./llm.js";
import type { LLMMessage, LLMClient } from "./llm.js";
import { checkRateLimit, redactText } from "./safety.js";
import { handleCommand } from "./commands.js";
import { MemoryStore } from "./lib/memory-store.js";
import { Metrics } from "./lib/metrics.js";
import { createHandler } from "./handler.js";
import { createShutdown, installSignalHandlers, installCrashHandlers } from "./shutdown.js";
import { formatStatus, makeAnvilPinger } from "./lib/status.js";
import { makeMetricsHeartbeat } from "./lib/metrics-heartbeat.js";
import { runAgent } from "./agent.js";
import { formatReply } from "./lib/format-reply.js";
import { friendlyError } from "./lib/failure.js";
import { statePaths, writeMetricsSnapshot } from "./lib/state-paths.js";
import { ScheduleStore, parseSchedule } from "./lib/schedule.js";
import { makeScheduleRunner } from "./schedule-runner.js";
import { RecipeStore, parseRecipeCommand, parseRunCommand } from "./lib/recipes.js";
import { DigestStore, parseDigestCommand } from "./lib/digests.js";
import { runDigest } from "./digest-runner.js";
import { AlertStore, parseAlertCommand } from "./lib/alerts.js";
import { checkAlert } from "./alert-runner.js";
import { parseScheduleFor } from "./lib/schedule.js";

// Agent brain, chosen by LLM_PROVIDER (m24). Default gemini (free tier) — nothing changes unless
// set. `claude` uses the Anthropic Messages API adapter (needs ANTHROPIC_API_KEY, a paid key).
const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
const llm: LLMClient = LLM_PROVIDER === "claude" ? new ClaudeClient() : new GeminiClient();

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

// Durable-state file paths resolved through the shared module (ops-2), so `relay status` reads the
// exact same files the runtime writes.
const paths = statePaths();

// Rolling aggregate health; a summary line is emitted every N turns so the operator
// sees ok/fail rate, avg steps, latency percentiles + tool mix without parsing [out].
const metrics = new Metrics();
const METRICS_EVERY = Number(process.env.RELAY_METRICS_EVERY ?? 50);
let turnCount = 0;
function recordTurn(t: { steps: number; tools: string[]; elapsedMs: number; ok: boolean }) {
  metrics.record(t);
  if (++turnCount % METRICS_EVERY === 0) {
    console.log(metrics.format());
    // Persist a snapshot so `relay status` can show the last health window offline (ops-3).
    writeMetricsSnapshot(paths.metrics, metrics.summary(), Date.now());
  }
}

// DEV-0111: wall-clock heartbeat so a command-only / idle period still logs + snapshots metrics
// (the turn-count flush above never fires with zero agent turns). Disabled if RELAY_METRICS_HEARTBEAT_MS<=0.
const METRICS_HEARTBEAT_MS = Number(process.env.RELAY_METRICS_HEARTBEAT_MS ?? 300000); // 5 min default
const metricsHeartbeat = makeMetricsHeartbeat({
  emit: () => console.log(metrics.format()),
  snapshot: () => writeMetricsSnapshot(paths.metrics, metrics.summary(), Date.now()),
  periodMs: METRICS_HEARTBEAT_MS,
  onError: () => {},
});

// Per-chat rolling memory (last few turns). Bounded to keep prompts small, and PERSISTED to a local
// JSON file (DEV-0001) so a redeploy/restart no longer wipes every conversation. Path is env-tunable;
// the file is gitignored. Free-infra: a plain file, no DB.
const MEMORY_TURNS = 6;
const memory = new MemoryStore({
  file: paths.memory,
  maxTurns: MEMORY_TURNS * 2,
});

// Proactive/scheduled tasks (m4): persisted schedules + a runner that fires them through
// the agent and texts the result unprompted. Free-infra: a JSON file + an interval, no cron.
const schedules = new ScheduleStore({ file: paths.schedules });
const recipes = new RecipeStore({ file: paths.recipes });
const digests = new DigestStore({ file: paths.digests });
const alerts = new AlertStore({ file: paths.alerts });
// Run a digest -> composed briefing text (member recipes -> one message). Shared by /run + schedule.
const digestRunText = (chatId: number, name: string): Promise<string | null> => {
  const d = digests.get(chatId, name);
  if (!d) return Promise.resolve(null);
  return runDigest(d, { llm, resolveRecipe: (c, n) => { const r = recipes.get(c, n); return r ? { task: r.task } : null; }, runAgent, formatReply });
};
// Check an alert -> the notify message ONLY if changed (null = silent). Shared by the runner.
const alertCheck = async (chatId: number, name: string): Promise<string | null> => {
  const a = alerts.get(chatId, name);
  if (!a) return null;
  const r = await checkAlert(a, { llm, runAgent, formatReply, setLast: (c, n, v) => alerts.setLast(c, n, v) });
  return r.notify ? r.message : null;
};
const ALERT_CADENCE = process.env.RELAY_ALERT_CADENCE ?? "every day at 09:00"; // default alert check cadence
const SCHED_TICK_MS = Number(process.env.RELAY_SCHED_TICK_MS ?? 30_000); // 0 disables
const scheduleRunner = makeScheduleRunner({
  store: schedules, llm, runAgent, send: sendMessage, formatReply,
  now: () => Date.now(), periodMs: SCHED_TICK_MS,
  log: (m) => console.log(m),
  recordTurn, // proactive fires count in the same Metrics as inbound turns (m8)
  maxPerChatPerHour: Number(process.env.RELAY_PROACTIVE_MAX_PER_HOUR ?? 10), // anti-spam (m8)
  digestRun: (chatId, name) => digestRunText(chatId, name), // scheduled digests (m9)
  alertCheck: (chatId, name) => alertCheck(chatId, name),   // scheduled alerts (m10): send only on change
  // m14 degrade-4: a failed ONE-SHOT reminder shouldn't vanish silently — tell the user, once,
  // with a friendly (non-leaking) line. A "daily" stays silent (it retries tomorrow; a misfiring
  // daily must not storm the chat with failure pings).
  failureNotice: (s, raw) =>
    s.kind === "once" ? `⏰ I tried to run "${s.task}" but ${friendlyError(raw).charAt(0).toLowerCase()}${friendlyError(raw).slice(1)}` : null,
});

const handle = createHandler({
  llm,
  memoryGet: (id) => memory.get(id) as LLMMessage[],
  memorySet: (id, history) => memory.set(id, history),
  memoryClear: (id) => memory.delete(id),
  statusLine: () => {
    const cmds = Object.entries(metrics.summary().commands);
    const topCommand = cmds.length ? { name: cmds[0]![0], count: cmds[0]![1] } : undefined;
    return formatStatus({ uptimeMs: Date.now() - startMs, turns: metrics.summary().turns, anvilOk: anvilPinger.current(), topCommand });
  },
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
  recipeSchedule: (chatId, name, whenClause, now) => {
    const rec = recipes.get(chatId, name);
    if (!rec) return { ok: false, reason: "unknown" };
    const p = parseScheduleFor(whenClause, rec.task, now);
    if (!p) return { ok: false, reason: "unparsed" };
    const s = schedules.add(chatId, p, now);
    if (!s) return { ok: false, reason: "capped" };
    return { ok: true, kind: s.kind };
  },
  digestDefine: (chatId, text) => {
    const p = parseDigestCommand(text);
    if (!p) return { ok: false, reason: "unparsed" };
    const rec = digests.add(chatId, p, Date.now());
    if (!rec) return { ok: false, reason: "capped" };
    return { ok: true, name: rec.name, members: rec.members.length };
  },
  digestList: (chatId) => digests.list(chatId).map((d) => ({ name: d.name, members: d.members, schedule: d.schedule })),
  digestForget: (chatId, name) => digests.remove(chatId, name),
  isDigest: (chatId, name) => !!digests.get(chatId, name),
  digestRun: (chatId, name) => digestRunText(chatId, name),
  digestSchedule: (chatId, name, whenClause, now) => {
    const d = digests.get(chatId, name);
    if (!d) return { ok: false, reason: "unknown" };
    // Schedule a marker task; when it fires, the runner runs the digest. Encode as "digest:<name>".
    const p = parseScheduleFor(whenClause, `digest:${d.name}`, now);
    if (!p) return { ok: false, reason: "unparsed" };
    const s = schedules.add(chatId, p, now);
    if (!s) return { ok: false, reason: "capped" };
    return { ok: true, kind: s.kind };
  },
  alertDefine: (chatId, text, now) => {
    const p = parseAlertCommand(text);
    if (!p) return { ok: false, reason: "unparsed" };
    const rec = alerts.add(chatId, p, now);
    if (!rec) return { ok: false, reason: "capped" };
    // Auto-schedule the check (marker "alert:<name>"); the runner runs checkAlert on fire.
    const sp = parseScheduleFor(ALERT_CADENCE, `alert:${rec.name}`, now);
    if (sp) schedules.add(chatId, sp, now);
    return { ok: true, name: rec.name };
  },
  alertList: (chatId) => alerts.list(chatId).map((a) => ({ name: a.name, task: a.task, lastValue: a.lastValue, threshold: a.threshold })),
  alertForget: (chatId, name) => alerts.remove(chatId, name),
  sendMessage,
  sendPhoto,
  sendDocument,
  sendTyping,
  handleCommand,
  checkRateLimit,
  redactText,
  hasModelKey: () => !!(LLM_PROVIDER === "claude" ? process.env.ANTHROPIC_API_KEY : process.env.GEMINI_API_KEY),
  recordTurn,
  recordCommand: (name) => metrics.recordCommand(name),
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
  const modelKeyVar = LLM_PROVIDER === "claude" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
  if (!process.env[modelKeyVar]) console.warn(`WARNING: ${modelKeyVar} not set — the agent (LLM_PROVIDER=${LLM_PROVIDER}) can't run until it's provided.`);
  else console.log(`agent brain: ${LLM_PROVIDER}`);

  scheduleRunner.start();              // fire proactive/scheduled tasks (no-op if RELAY_SCHED_TICK_MS=0)
  metricsHeartbeat.start();            // periodic metrics flush (no-op if RELAY_METRICS_HEARTBEAT_MS=0)
  if (SCHED_TICK_MS > 0) console.log(`schedule runner on (${schedules.size()} pending, tick ${SCHED_TICK_MS}ms)`);

  console.log(`Relay listening on ${channel.name}…`);
  const poller = channel.start(handle);
  // Clean stop on docker stop / pm2 restart / Ctrl-C: halt polling, exit 0. Memory is
  // already durable (MemoryStore persists synchronously each turn).
  installSignalHandlers(createShutdown({
    stopPolling: () => { poller.stop(); anvilPinger.stop(); scheduleRunner.stop(); metricsHeartbeat.stop(); },
    onShutdown: () => { console.log(metrics.format()); writeMetricsSnapshot(paths.metrics, metrics.summary(), Date.now()); }, // flush + persist the final window (DEV-0041, ops-3)
    log: (m) => console.log(m),
    exit: (code) => process.exit(code),
  }));

  // Last-breath handlers (DEV-0066): a stray throw / rejected promise otherwise kills the 24/7
  // worker with no log. Emit the final metrics window + a [fatal] line, then exit 1 so the
  // supervisor restarts.
  installCrashHandlers({
    log: (m) => console.error(m),
    onFatal: () => { console.log(metrics.format()); writeMetricsSnapshot(paths.metrics, metrics.summary(), Date.now()); },
  });
}

main();
