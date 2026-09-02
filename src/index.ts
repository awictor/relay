// Relay entrypoint. Telegram long-poll -> agent (Gemini + anvil browser) -> reply.
// Per-chat short memory so follow-ups have context. Falls back to a clear message
// if keys/anvil are missing so it never hangs silently.

import { selectChannel, type Channel } from "./channel.js";
import { downloadFile } from "./telegram.js";
import { anvilLive } from "./anvil.js";
import { GeminiClient, ClaudeClient, resolveProvider } from "./llm.js";
import type { LLMMessage, LLMClient } from "./llm.js";
import { checkRateLimit, redactText } from "./safety.js";
import { redactCookieValues, jarHosts } from "./lib/cookie-jar.js";
import { intEnv } from "./lib/env.js";
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
import { RecipeStore, parseRecipeCommand, parseRunWithArgs, applySlots, hasSlots } from "./lib/recipes.js";
import { DigestStore, parseDigestCommand } from "./lib/digests.js";
import { runDigest } from "./digest-runner.js";
import { AlertStore, parseAlertCommand, parseAlertEdit } from "./lib/alerts.js";
import { ProfileStore, parseSetLocation } from "./lib/profile.js";
import { checkAlert } from "./alert-runner.js";
import { parseScheduleFor } from "./lib/schedule.js";

// Agent brain, chosen by LLM_PROVIDER (m24). Default gemini (free tier) — nothing changes unless
// set. `claude` uses the Anthropic Messages API adapter (needs ANTHROPIC_API_KEY, a paid key).
const { provider: LLM_PROVIDER, warning: LLM_PROVIDER_WARNING } = resolveProvider(process.env.LLM_PROVIDER);
if (LLM_PROVIDER_WARNING) console.warn(`WARNING: ${LLM_PROVIDER_WARNING}`);
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
const ANVIL_PING_MS = intEnv(process.env.RELAY_ANVIL_PING_MS, { fallback: 60_000, allowZeroDisable: true }); // 0 disables the refresh
const anvilPinger = makeAnvilPinger({ probe: anvilLive, periodMs: ANVIL_PING_MS });

// Durable-state file paths resolved through the shared module (ops-2), so `relay status` reads the
// exact same files the runtime writes.
const paths = statePaths();

// Rolling aggregate health; a summary line is emitted every N turns so the operator
// sees ok/fail rate, avg steps, latency percentiles + tool mix without parsing [out].
const metrics = new Metrics();
const METRICS_EVERY = intEnv(process.env.RELAY_METRICS_EVERY, { fallback: 50, min: 1 });
let turnCount = 0;
function recordTurn(t: { steps: number; tools: string[]; elapsedMs: number; ok: boolean; degraded?: boolean }) {
  metrics.record(t);
  if (++turnCount % METRICS_EVERY === 0) {
    console.log(metrics.format());
    // Persist a snapshot so `relay status` can show the last health window offline (ops-3).
    writeMetricsSnapshot(paths.metrics, metrics.summary(), Date.now());
  }
}

// DEV-0111: wall-clock heartbeat so a command-only / idle period still logs + snapshots metrics
// (the turn-count flush above never fires with zero agent turns). Disabled if RELAY_METRICS_HEARTBEAT_MS<=0.
const METRICS_HEARTBEAT_MS = intEnv(process.env.RELAY_METRICS_HEARTBEAT_MS, { fallback: 300000, allowZeroDisable: true }); // 5 min default; 0 disables
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
const profiles = new ProfileStore({ file: paths.profile });
// Run a digest -> composed briefing text (member recipes -> one message). Shared by /run + schedule.
const digestRunText = (chatId: number, name: string): Promise<string | null> => {
  const d = digests.get(chatId, name);
  if (!d) return Promise.resolve(null);
  return runDigest(d, { llm, resolveRecipe: (c, n) => { const r = recipes.get(c, n); return r ? { task: r.task } : null; }, runAgent, formatReply, contextFor: (c) => profiles.contextLine(c) });
};
// Check an alert -> the notify message ONLY if changed (null = silent). Shared by the runner.
const alertCheck = async (chatId: number, name: string): Promise<string | null> => {
  const a = alerts.get(chatId, name);
  if (!a) return null;
  const r = await checkAlert(a, { llm, runAgent, formatReply, setLast: (c, n, v) => alerts.setLast(c, n, v), contextFor: (c) => profiles.contextLine(c) });
  return r.notify ? r.message : null;
};
const ALERT_CADENCE = process.env.RELAY_ALERT_CADENCE ?? "every day at 09:00"; // default alert check cadence
const SCHED_TICK_MS = intEnv(process.env.RELAY_SCHED_TICK_MS, { fallback: 30_000, allowZeroDisable: true }); // 0 disables
const scheduleRunner = makeScheduleRunner({
  store: schedules, llm, runAgent, send: sendMessage, formatReply, contextFor: (c) => profiles.contextLine(c),
  now: () => Date.now(), periodMs: SCHED_TICK_MS,
  log: (m) => console.log(m),
  recordTurn, // proactive fires count in the same Metrics as inbound turns (m8)
  maxPerChatPerHour: intEnv(process.env.RELAY_PROACTIVE_MAX_PER_HOUR, { fallback: 10, allowZeroDisable: true }), // anti-spam (m8); 0 = unlimited
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
    const sum = metrics.summary();
    const cmds = Object.entries(sum.commands);
    const topCommand = cmds.length ? { name: cmds[0]![0], count: cmds[0]![1] } : undefined;
    return formatStatus({ uptimeMs: Date.now() - startMs, turns: sum.turns, anvilOk: anvilPinger.current(), topCommand, fail: sum.fail, degraded: sum.degraded });
  },
  // /sites (m30): hosts the cookie jar authorizes the agent for — names only, never values.
  sitesLine: () => {
    const hosts = jarHosts();
    return hosts.length
      ? `I'm signed in for these sites (via cookies you configured):\n${hosts.map((h) => `• ${h}`).join("\n")}`
      : "No site logins configured — I can only read public pages. (Set RELAY_COOKIES to authorize sites.)";
  },
  // Per-user profile (product-loop): parse+store "set my location", and hand the agent a context line.
  setLocation: (chatId, text) => {
    const p = parseSetLocation(text);
    if (!p) return null;
    const rec = profiles.set(chatId, p);
    return { location: rec.location!, units: rec.units, tzOffsetMin: rec.tzOffsetMin };
  },
  profileContext: (chatId) => profiles.contextLine(chatId),
  // Inbound photo (product-loop): download the Telegram file, ask the LLM to answer about it. Needs
  // a multimodal LLM (Gemini); absent describeImage -> handler tells the user images aren't supported.
  describeImage: llm.describeImage
    ? async (fileId, caption) => {
        const file = await downloadFile(fileId);
        if (!file) return "I couldn't download that image — try resending it.";
        const prompt = caption?.trim() || "What is this? Summarize it and flag anything important.";
        return llm.describeImage!(file.bytes, file.mimeType, prompt);
      }
    : undefined,
  // Inbound voice note (product-loop): download + transcribe to text (the handler then runs it).
  transcribeVoice: llm.transcribeAudio
    ? async (fileId) => {
        const file = await downloadFile(fileId);
        if (!file) return "";
        return llm.transcribeAudio!(file.bytes, file.mimeType);
      }
    : undefined,
  // Inbound document/PDF (product-loop): download + ask the multimodal LLM (Gemini reads PDFs via the
  // same inlineData path as images). Reuses describeImage; the downloaded mime (application/pdf) is
  // passed through so Gemini treats it as a document.
  describeDocument: llm.describeImage
    ? async (fileId, caption) => {
        const file = await downloadFile(fileId);
        if (!file) return "I couldn't download that file — try resending it.";
        const prompt = caption?.trim() || "Summarize this document and flag anything important (totals, dates, actions).";
        return llm.describeImage!(file.bytes, file.mimeType, prompt);
      }
    : undefined,
  scheduleAdd: (chatId, text, now) => {
    // Use the chat's own timezone (from their profile) so "every morning" fires at THEIR 9am,
    // not the deploy host's UTC. Falls back to the global RELAY_TZ_OFFSET_MIN when unset.
    const p = parseSchedule(text, now, profiles.offsetMin(chatId));
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
    // Parse name + args so a recipe with {slots} runs with the user's values (product-loop).
    const parsed = parseRunWithArgs(text);
    if (!parsed) return null;
    const rec = recipes.get(chatId, parsed.name);
    if (!rec) return null;
    // A slotted recipe run with no value would substitute empty + run a broken task — ask instead.
    if (hasSlots(rec.task) && !parsed.args.trim()) return { name: rec.name, missingArg: true };
    return { name: rec.name, task: applySlots(rec.task, parsed.args) };
  },
  recipeList: (chatId) => recipes.list(chatId).map((r) => ({ name: r.name, task: r.task, schedule: r.schedule })),
  recipeForget: (chatId, name) => recipes.remove(chatId, name),
  recipeSchedule: (chatId, name, whenClause, now) => {
    const rec = recipes.get(chatId, name);
    if (!rec) return { ok: false, reason: "unknown" };
    // A slotted recipe has no per-fire value on a schedule, so it would emit the literal "{slot}"
    // and return nonsense every day (product-loop) — refuse with a clear reason.
    if (hasSlots(rec.task)) return { ok: false, reason: "needsarg" };
    const p = parseScheduleFor(whenClause, rec.task, now, profiles.offsetMin(chatId));
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
    const p = parseScheduleFor(whenClause, `digest:${d.name}`, now, profiles.offsetMin(chatId));
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
    const sp = parseScheduleFor(ALERT_CADENCE, `alert:${rec.name}`, now, profiles.offsetMin(chatId));
    if (sp) schedules.add(chatId, sp, now);
    return { ok: true, name: rec.name };
  },
  // Run one check right after define (product-loop) via the same path the scheduler uses.
  alertRunNow: (chatId, name) => alertCheck(chatId, name),
  // Conversationally retune an existing alert's trigger (product-loop): parse -> update in place.
  alertEdit: (chatId, text) => {
    const e = parseAlertEdit(text);
    if (!e) return { ok: false, reason: "unparsed" };
    const rec = alerts.updateTrigger(chatId, e.name, { threshold: e.threshold, condition: e.condition });
    if (!rec) return { ok: false, reason: "unknown" };
    const summary = rec.condition
      ? rec.condition.op === "in_stock" ? "back in stock" : `${rec.condition.op} ${rec.condition.operand}`
      : `on any change of ${rec.threshold}`;
    return { ok: true, name: rec.name, summary: `now alerts ${summary}` };
  },
  alertList: (chatId) => alerts.list(chatId).map((a) => ({ name: a.name, task: a.task, lastValue: a.lastValue, threshold: a.threshold })),
  alertForget: (chatId, name) => alerts.remove(chatId, name),
  sendMessage,
  sendPhoto,
  sendDocument,
  sendTyping,
  handleCommand,
  checkRateLimit,
  // Redact secrets AND any seeded cookie values (m29 cookies-2) from logged/echoed text.
  redactText: (t: string) => redactCookieValues(redactText(t)),
  hasModelKey: () => !!(LLM_PROVIDER === "claude" ? process.env.ANTHROPIC_API_KEY : process.env.GEMINI_API_KEY),
  recordTurn,
  recordCommand: (name) => metrics.recordCommand(name),
  now: () => Date.now(),
  // Interim "still working" ping if an errand outlasts this (product-loop). 0 disables. Default 6s.
  progressDelayMs: Number(process.env.RELAY_PROGRESS_DELAY_MS ?? 6000),
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
