// Relay entrypoint. Telegram long-poll -> agent (Gemini + anvil browser) -> reply.
// Per-chat short memory so follow-ups have context. Falls back to a clear message
// if keys/anvil are missing so it never hangs silently.

import { selectChannel, type Channel } from "./channel.js";
import { downloadFile, registerCommands, type InboundMessage } from "./telegram.js";
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
import { runAgent, defaultFetchText, defaultFetchBytes } from "./agent.js";
import { getWeather as getWeatherFn } from "./lib/weather.js";
import { describeWeatherCondition } from "./lib/weather-alert.js";
import { fetchFeedItems, resolveFeedSource, parseFollowCommand } from "./lib/feeds.js";
import { readQrFromBytes } from "./lib/qr-decode.js";
import { formatReply, formatReplyParts } from "./lib/format-reply.js";
import { friendlyError } from "./lib/failure.js";
import { statePaths, writeMetricsSnapshot } from "./lib/state-paths.js";
import { ScheduleStore, parseSchedule, parseSnoozeCommand, tzOffsetMin, quietUntilMs, PAUSE_INDEFINITE, isStickyAck } from "./lib/schedule.js";
import { formatWhen } from "./lib/format-when.js";
import { formatDashboard, type DashboardData } from "./lib/dashboard.js";
import { makeScheduleRunner } from "./schedule-runner.js";
import { RecipeStore, parseRecipeCommand, parseRunWithArgs, applySlots, hasSlots, slotsAmbiguous, slotNames, isChain, chainOverflow, MAX_CHAIN_STEPS } from "./lib/recipes.js";
import { matchRecipe } from "./lib/task-suggest.js";
import { DigestStore, parseDigestCommand } from "./lib/digests.js";
import { runDigest, type DigestOutcome } from "./digest-runner.js";
import { AlertStore, parseAlertCommand, parseAlertEdit, parseTrendRequest, summarizeSeries, isQuietDeferrable } from "./lib/alerts.js";
import { parseChartRequest, renderChart } from "./lib/chart.js";
import { ProfileStore, parseSetLocation, parseCityReply } from "./lib/profile.js";
import { NotesStore, parseRemember, parseForgetFact } from "./lib/notes.js";
import { SavedStore, parseSavePage, parseSavedRecall, hostLabel, readingRecap, isUnreadSavedRequest, formatUnreadNudge, parseUnreadNudgeToggle } from "./lib/readlater.js";
import { parseCountdown, countdownMilestones, formatCountdown, milestonePing } from "./lib/countdown.js";
import { PlacesStore, parseSavePlace, parseForgetPlace, isListPlacesRequest } from "./lib/places-store.js";
import { LogStore, parseLogCommand, parseLogQuery, sumSeries } from "./lib/logs.js";
import { ListStore, parseListCommand, parseListExport, splitItems, MAX_ITEMS_PER_LIST } from "./lib/lists.js";
import { ContactStore, parseSaveContact, parseForgetContact, parseFollowUp } from "./lib/contacts.js";
import { mailtoLink, smsLink } from "./lib/compose.js";
import { isTextualDoc, decodeTextDoc, buildDocPrompt } from "./lib/docs.js";
import { setCorruptHandler } from "./lib/safe-store.js";
import { AnswerLog, recallKeywords } from "./lib/answer-log.js";
import { BackgroundStore, planErrandReplay } from "./lib/background-store.js";
import { checkAlert } from "./alert-runner.js";
import { runChain } from "./chain-runner.js";
import { parseScheduleFor } from "./lib/schedule.js";

// Agent brain, chosen by LLM_PROVIDER (m24). Default gemini (free tier) — nothing changes unless
// set. `claude` uses the Anthropic Messages API adapter (needs ANTHROPIC_API_KEY, a paid key).
const { provider: LLM_PROVIDER, warning: LLM_PROVIDER_WARNING } = resolveProvider(process.env.LLM_PROVIDER);
if (LLM_PROVIDER_WARNING) console.warn(`WARNING: ${LLM_PROVIDER_WARNING}`);
const llm: LLMClient = LLM_PROVIDER === "claude" ? new ClaudeClient() : new GeminiClient();

// The transport Relay runs on (m5), chosen by RELAY_CHANNEL (telegram default | console).
const channel: Channel = selectChannel(process.env.RELAY_CHANNEL);
import type { InlineKeyboard } from "./lib/callbacks.js";
const sendMessage = (chatId: number, text: string, keyboard?: InlineKeyboard) => channel.sendMessage(chatId, text, keyboard);
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
// Corrupt-store notice (corrupt-store-silent-wipe): a store file that won't parse loads empty (its data
// backed up to .corrupt), so a user's reminders/alerts/recipes vanish. Collect which stores corrupted
// AT LOAD (the handler installs this before constructing the stores below) so the next inbound message
// gets a one-time honest heads-up instead of the bot just going quiet. file -> human label.
const CORRUPT_LABELS: Record<string, string> = {
  [paths.schedules]: "reminders", [paths.recipes]: "saved recipes", [paths.digests]: "digests",
  [paths.alerts]: "watches/alerts", [paths.profile]: "your saved location/profile", [paths.notes]: "remembered facts",
  [paths.lists]: "your lists", [paths.contacts]: "contacts", [paths.places]: "your saved places", [paths.logs]: "your tracked logs",
};
const corruptedStores: string[] = [];
setCorruptHandler((file) => { const label = CORRUPT_LABELS[file] ?? file; if (!corruptedStores.includes(label)) corruptedStores.push(label); });

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
const notes = new NotesStore({ file: paths.notes });
const places = new PlacesStore({ file: paths.places });
const logs = new LogStore({ file: paths.logs });
const saved = new SavedStore({ file: paths.saved });
// A saved page is "stale-unread" after this long with no revisit (saved-page-unread-nudge). Default 7 days.
const SAVED_STALE_MS = Math.max(3_600_000, Number(process.env.RELAY_SAVED_STALE_MS) || 7 * 86_400_000);
const lists = new ListStore({ file: paths.lists });
const contacts = new ContactStore({ file: paths.contacts });
const answerLog = new AnswerLog({ file: paths.answers });
const backgroundStore = new BackgroundStore({ file: paths.background });
// Per-chat agent environment for PROACTIVE runs (proactive-runs-datetime-units-blind): the clock + tz +
// coords + units the inbound path already threads into runAgent, so a scheduled/alert/digest/chain task
// reasons from the real date and the user's units instead of the model's training date / a hardcoded °F.
// Uses homeCoords (durable, TTL-ignoring) not freshCoords: a STANDING automation the user set ("weather
// near me every morning") must keep resolving a location past the 6h privacy TTL, or it silently fires
// "which city?" into the void the same day (recurring-near-me-pin-ttl-breaks). The TTL still guards the
// ad-hoc inbound path (index wires weatherCoords: freshCoords there).
const agentEnvFor = (chatId: number) => ({
  nowMs: Date.now(),
  // DST-correct offset at NOW (current-datetime-dst-stale): the frozen tzOffsetMin would make the agent's
  // "current time"/"today" line an hour off + wrong calendar day near midnight after a DST boundary.
  tzOffsetMin: profiles.offsetMinAt(chatId, Date.now()) ?? tzOffsetMin(),
  weatherCoords: profiles.homeCoords(chatId),
  weatherUnits: profiles.get(chatId)?.units,
  // Read-it-later (read-it-later-capture): let the agent file a page it just found into this chat's saved
  // list, so "find X and save it" completes in one turn. Chat-bound here; the model supplies title/summary
  // (it just read the page), so no extra fetch — falls back to a host-label title inside SavedStore.
  savePage: (url: string, title?: string, summary?: string) => {
    const r = saved.add(chatId, { url, title, summary: summary ?? title ?? url }, Date.now());
    return { title: r.page.title, saved: r.saved, dup: r.dup }; // dup -> agent says "Updated" not "Saved"
  },
});
// Run a digest -> composed briefing text (member recipes -> one message). Shared by /run + schedule.
const digestRunText = (chatId: number, name: string): Promise<DigestOutcome> => {
  const d = digests.get(chatId, name);
  if (!d) return Promise.resolve(null);
  return runDigest(d, { llm, resolveRecipe: (c, n) => { const r = recipes.get(c, n); return r ? { task: r.task } : null; }, runAgent, formatReply, contextFor: (c) => profiles.contextLine(c, Date.now()), agentEnv: agentEnvFor,
    // Reading-list recap member (saved-page-digest-integration): fold recent saves into the briefing. The
    // recap shows the most-recent saves, so stamp them recalled (saved-page-unread-nudge) — a page that
    // appears in the daily recap isn't "forgotten".
    savedRecap: (c) => { const list = saved.list(c); const recap = readingRecap(list); if (recap) saved.markRecalled(c, [...list].sort((a, b) => b.created - a.created).slice(0, 5).map((p) => p.url), Date.now()); return recap; },
    // A chained-recipe member runs as a sequential workflow, not a literal task (digest-chain-member-literal).
    runChain: async (c, task) => (await runChain(c, task, { llm, runAgent, formatReply, contextFor: (cc) => profiles.contextLine(cc, Date.now()), agentEnv: agentEnvFor })).final });
};
// Check an alert -> { message (null = silent), commit }. The caller MUST call commit() AFTER a
// successful send so a failed send leaves the baseline un-advanced + the crossing re-fires next
// check (alert-notify-send-fail). Silent path already committed inside checkAlert (commit is a noop).
const alertCheck = async (chatId: number, name: string): Promise<{ message: string | null; commit: () => void; softFail?: boolean; deadMembers?: string[] }> => {
  const a = alerts.get(chatId, name);
  if (!a) return { message: null, commit: () => {} };
  const r = await checkAlert(a, {
    llm, runAgent, formatReply, agentEnv: agentEnvFor,
    setLast: (c, n, v) => alerts.setLast(c, n, v),
    recordSeen: (c, n, keys) => alerts.recordSeen(c, n, keys),
    recordPoint: (c, n, v, t) => alerts.recordPoint(c, n, v, t),
    seriesOf: (c, n) => alerts.seriesOf(c, n), // good-deal-price-verdict: read history for the ping verdict
    setMemberLasts: (c, n, updates) => alerts.setMemberLasts(c, n, updates),
    fetchFeed: (src) => fetchFeedItems(src, defaultFetchText), // follow-feed-subscriptions: keyless direct fetch
    fetchPage: (url) => defaultFetchText(url), // watch-any-page-diff: SSRF-guarded direct page fetch
    // Weather-conditional (weather-conditional-alert): forecast for the alert's named place, else the
    // chat's saved home coords (a standing automation ignores the coord TTL, like the digest weather).
    fetchWeather: (chatId, place) => getWeatherFn(place ? { place, near: profiles.homeCoords(chatId) } : (profiles.homeCoords(chatId) ? { lat: profiles.homeCoords(chatId)!.lat, lng: profiles.homeCoords(chatId)!.lng } : {}), defaultFetchText),
    bumpFlap: (c, n) => alerts.bumpFlap(c, n),  // page-diff-flap-guard
    resetFlap: (c, n) => alerts.resetFlap(c, n),
    // Auto-mute a flapping page watch: pause its schedule indefinitely (user resumes by name). Reuse the
    // snooze machinery — pausing the "alert:<name>" schedule stops the runner firing it.
    muteWatch: (c, n) => { schedules.pause(c, `alert:${n}`, PAUSE_INDEFINITE); },
    now: () => Date.now(),
    contextFor: (c) => profiles.contextLine(c, Date.now()),
    // Trigger-to-action (trigger-to-action-alerts): run the named recipe's CURRENT task on fire.
    runThen: async (c, recipeName) => {
      const rec = recipes.get(c, recipeName);
      if (!rec) return null;
      // A slotted recipe ('{item}') has no per-fire value here, and a '>>' chain is a workflow — running
      // either as one literal agent task appends garbage to the ping (trigger-to-action-recipe-shape,
      // the one recipe-execution path missed when the chain/slot guards were added to /run + schedule +
      // digest). Skip a slotted recipe; run a chain via runChain like every other path.
      if (hasSlots(rec.task)) return null;
      if (isChain(rec.task)) {
        const chained = (await runChain(c, rec.task, { llm, runAgent, formatReply, contextFor: (cc) => profiles.contextLine(cc, Date.now()), agentEnv: agentEnvFor })).final;
        return chained?.trim() ? chained : null;
      }
      const out = await runAgent(rec.task, { llm, context: profiles.contextLine(c, Date.now()) || undefined, ...agentEnvFor(c) }, []);
      return out.degraded ? null : formatReply(out.reply);
    },
  });
  return { message: r.notify ? r.message : null, commit: r.commit, softFail: r.softFail, deadMembers: r.deadMembers };
};
const ALERT_CADENCE = process.env.RELAY_ALERT_CADENCE ?? "every day at 09:00"; // default alert check cadence
// How long after a sticky reminder last pinged a bare "ok"/"done" still counts as dismissing IT
// (sticky-ack-only-when-recent). Longer than a typical nag interval + reply lag; env-tunable. Default 90m.
const STICKY_ACK_WINDOW_MS = intEnv(process.env.RELAY_STICKY_ACK_WINDOW_MS, { fallback: 90 * 60_000, min: 60_000 });
// Quiet-hours window (hours 0-23, local per-chat tz). Equal start===end (default) = disabled. Set
// RELAY_QUIET_START/END (e.g. 22 and 7) to hold proactive sends overnight until the window ends.
const QUIET_START = intEnv(process.env.RELAY_QUIET_START, { fallback: 0, min: 0 }) % 24;
const QUIET_END = intEnv(process.env.RELAY_QUIET_END, { fallback: 0, min: 0 }) % 24;
const SCHED_TICK_MS = intEnv(process.env.RELAY_SCHED_TICK_MS, { fallback: 30_000, allowZeroDisable: true }); // 0 disables
// Shared last-result cache (proactive-ping-drilldown-cache): the handler stores answers here + the
// runner records proactive sends, so "more"/"send the link" works after an unprompted ping too.
const lastResultStore = new Map<number, { full: string; sent: number; ping?: { full: string; sent: number } }>();
// Shared pick-list cache (picker-on-proactive-pings): the handler caches an inbound list reply's items
// here + the schedule-runner caches a proactive list ping's items, so a "pick N" button tap resolves
// against whichever list the chat last saw — inbound answer or unprompted ping.
import type { ResultItem } from "./lib/result-list.js";
const pickListStore = new Map<number, ResultItem[]>();
const scheduleRunner = makeScheduleRunner({
  store: schedules, llm, runAgent, send: sendMessage, formatReply, formatReplyParts, contextFor: (c) => profiles.contextLine(c, Date.now()), agentEnv: agentEnvFor,
  now: () => Date.now(), periodMs: SCHED_TICK_MS,
  log: (m) => console.log(m),
  recordTurn, // proactive fires count in the same Metrics as inbound turns (m8)
  maxPerChatPerHour: intEnv(process.env.RELAY_PROACTIVE_MAX_PER_HOUR, { fallback: 10, allowZeroDisable: true }), // anti-spam (m8); 0 = unlimited
  digestRun: (chatId, name) => digestRunText(chatId, name), // scheduled digests (m9)
  // Weekly read-it-later nudge (weekly-unread-proactive-nudge): pure store read; null when nothing's
  // stale-unread (stay silent). Stamps the nudged pages recalled so they don't re-surface next week.
  unreadNudge: (chatId) => {
    const pages = saved.unread(chatId, SAVED_STALE_MS, Date.now());
    const note = formatUnreadNudge(pages);
    if (note) saved.markRecalled(chatId, pages.map((p) => p.url), Date.now());
    return note;
  },
  alertCheck: (chatId, name) => alertCheck(chatId, name),   // scheduled alerts (m10): send only on change
  recipeResolveTask: (chatId, name) => { const r = recipes.get(chatId, name); return r ? r.task : null; }, // scheduled recipes: resolve current task at fire time
  // Scheduled chained recipe = sequential workflow. Return the structured result (final + stoppedEarly)
  // so the runner flags a partial briefing instead of pushing an intermediate step as complete
  // (scheduled-chain-partial-unflagged).
  runChain: async (chatId, task) => { const r = await runChain(chatId, task, { llm, runAgent, formatReply, contextFor: (c) => profiles.contextLine(c, Date.now()), agentEnv: agentEnvFor }); return { final: r.final, stoppedEarly: r.stoppedEarly, stepsDone: r.steps.filter((s) => !s.skipped).length, stepsTotal: r.steps.length }; },
  // Proactive ping -> its OWN slot (drilldown + follow-up context), preserving the inbound answer's
  // pageable state so a ping mid-conversation can't eat the answer's unshown tail (proactive-clobbers-
  // drilldown-cache). The ping is sent whole (untrimmed), so its paging offset starts at full length
  // ("more" after a ping only pages a still-unshown ANSWER tail); links/context still read the ping.
  recordSend: (chatId, full, sentLen) => { const e = lastResultStore.get(chatId); lastResultStore.set(chatId, { full: e?.full ?? "", sent: e?.sent ?? 0, ping: { full, sent: sentLen ?? full.length } }); },
  pickListStore, // proactive list pings get pick buttons too (picker-on-proactive-pings)
  // Quiet hours (quiet-hours): defer a proactive send that lands in the window to its end, in the
  // chat's tz. Off unless RELAY_QUIET_START/END set (default start===end 0 = no window).
  quietUntil: (chatId, now) => quietUntilMs(now, QUIET_START, QUIET_END, profiles.offsetMin(chatId) ?? tzOffsetMin()),
  deferTo: (id, whenMs) => { schedules.deferTo(id, whenMs); },
  // Quiet-hours alert classification (quiet-hours-persistent-alerts + unthrottled-change-watch): a watch
  // whose signal PERSISTS to morning is safe to defer to quiet-end (nothing lost, no 3am buzz). Only a
  // PREDICATE (below/above/in_stock) or WEATHER alert is genuinely edge-triggered — a crossing can revert
  // overnight and be missed if the CHECK is deferred, so those stay exempt (run on cadence). Everything
  // else — a plain/threshold change-watch (its new value is still there in the morning), a watchlist (a
  // group of change-watches), a feed/page-diff — is deferrable. This ALSO fixes a plain "watch btc: price
  // of bitcoin" (no threshold, level-triggered) spamming all night: it now batches to quiet-end instead
  // of pinging every cadence check overnight. Unknown alert -> not deferrable (safe default: keep exempt).
  alertQuietDeferrable: (chatId, name) => {
    const a = alerts.get(chatId, name);
    return a ? isQuietDeferrable(a) : false; // unknown alert -> not deferrable (safe default: keep exempt)
  },
  // m14 degrade-4: a failed ONE-SHOT reminder shouldn't vanish silently — tell the user, once,
  // with a friendly (non-leaking) line. A "daily" stays silent (it retries tomorrow; a misfiring
  // daily must not storm the chat with failure pings).
  failureNotice: (s, raw) =>
    s.kind === "once" ? `⏰ I tried to run "${s.task}" but ${friendlyError(raw).charAt(0).toLowerCase()}${friendlyError(raw).slice(1)}` : null,
  // Failed-watch receipt (failed-watch-receipts): after N straight failures of a recurring task, tell
  // the user once so a dead watch/digest/schedule doesn't read as 'no news'. Names the human task
  // (strips the digest:/alert:/recipe: marker) so it's recognizable.
  failStreakNotice: (s, streak) => {
    const label = s.task.replace(/^(?:digest|alert|recipe):/, "");
    return `⚠️ Heads up — "${label}" has failed ${streak} checks in a row. The site may have changed or a login expired; check it or /cancel + re-add it.`;
  },
  // Watchlist dead-member receipt (watchlist-member-dead-no-receipt): one specific item in a basket keeps
  // failing to read while the others are fine, so the basket looks healthy — name the dead member so the
  // user can fix/drop it rather than believing all N are tracked.
  deadMemberNotice: (_chatId, alertName, member) =>
    `⚠️ Heads up — in your "${alertName}" watchlist, "${member}" keeps failing to load (bad link, renamed, or a login expired). I'm still tracking the others. Fix or remove that one with "change ${alertName}: ..." or /forget-alert ${alertName}.`,
  // Empty-content notice (digest-silent-on-member-delete): a scheduled digest/recipe whose content was
  // deleted no-shows silently forever — tell the user once why + how to fix, and stop it firing.
  goneNotice: (s, what, name) => {
    schedules.removeByTask(s.chatId, `${what}:${name}`); // stop the dead schedule from firing again
    return what === "digest"
      ? `⚠️ Your scheduled "${name}" briefing stopped — all the recipes it bundled were removed, so there's nothing left to send. I've turned it off. Rebuild it with "define digest ${name}: ..." to bring it back.`
      : `⚠️ Your scheduled "${name}" stopped — that recipe was deleted, so there's nothing to run. I've turned off its schedule. Re-save it with "save ${name}: ..." and schedule it again if you want it back.`;
  },
});

const handle = createHandler({
  llm,
  memoryGet: (id) => memory.get(id) as LLMMessage[],
  memorySet: (id, history) => memory.set(id, history),
  memoryClear: (id) => memory.delete(id),
  // Did the last memory write reach disk? (memory-write-silent-fail) The handler warns ONCE per chat if
  // a persist failed, so a full/unwritable disk silently dropping conversation isn't invisible.
  memorySaveOk: () => memory.lastSaveOk(),
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
    const p = parseSetLocation(text, Date.now()); // DST-correct inferred offset at "now" (reminder-wrong-timezone-dst)
    if (!p) return null;
    const rec = profiles.set(chatId, p);
    // Re-stamp recurring reminders to the new tz so a daily/weekly created before the user set their
    // timezone stops firing at the wrong hour (tz-restamp-on-setlocation). Only when a tz was given.
    const restamped = rec.tzOffsetMin !== undefined ? schedules.restampTz(chatId, rec.tzOffsetMin, Date.now(), profiles.zone(chatId)) : 0;
    return { location: rec.location!, units: rec.units, tzOffsetMin: rec.tzOffsetMin, restamped, saved: profiles.lastSaveOk() };
  },
  // Agent context = profile (location/units/tz) + remembered facts (remember-facts-store), so every
  // answer is filtered through both without the user re-stating them.
  profileContext: (chatId) => [profiles.contextLine(chatId, Date.now()), notes.contextLine(chatId), places.contextLine(chatId)].filter(Boolean).join("; "),
  chatTzOffsetMin: (chatId) => profiles.offsetMinAt(chatId, Date.now()) ?? tzOffsetMin(), // DST-correct at now (current-datetime-dst-stale)

  // /profile view + clear (product-loop): echo the stored profile so a wrong city/tz is visible.
  profileView: (chatId) => { const l = profiles.contextLine(chatId); return l ? l.charAt(0).toUpperCase() + l.slice(1) : null; },
  // saved: whether the clear reached disk (delete-persist-hedge) — a failed write brings the saved
  // location/tz back on restart, so the handler hedges. saved is moot when there was nothing to clear.
  profileClear: (chatId) => { const had = profiles.clear(chatId); return { had, saved: !had || profiles.lastSaveOk() }; },
  // Long-term memory (remember-facts-store): parse+store "remember X", forget matching facts, list them.
  rememberFact: (chatId, text) => { const f = parseRemember(text); if (!f) return null; const r = notes.add(chatId, f, Date.now()); return { fact: f, evicted: r.evicted, saved: r.saved }; },
  forgetFact: (chatId, text) => {
    const p = parseForgetFact(text);
    if (!p) return null;
    // Report whether the delete reached disk (delete-persist-hedge): an unhedged failed forget resurrects
    // the fact on restart — and it keeps getting injected into every answer, so a privacy request silently
    // reverts. saved is meaningful only when something was actually removed.
    if ("all" in p) { const removed = notes.clear(chatId); return { removed, all: true, forgotten: [], saved: removed === 0 || notes.lastSaveOk() }; }
    const forgotten = notes.forget(chatId, p.term);
    return { removed: forgotten.length, all: false, forgotten, saved: forgotten.length === 0 || notes.lastSaveOk() };
  },
  notesList: (chatId) => notes.list(chatId).map((n) => n.text),
  // Read-it-later (read-it-later-capture): "save this <link>" -> summarize the page via the agent + store
  // it; "what did I save about X" / "my reading list" -> search the store. The summarize goes through the
  // same runAgent path as a normal read (SSRF-guarded fetch, anvil when needed), so a save captures the
  // real gist once for offline recall.
  savePage: async (chatId, text) => {
    const url = parseSavePage(text);
    if (!url) return null;
    let summary = "", title = "";
    try {
      const res = await runAgent(`Summarize the page at ${url} in 2-4 sentences: what it is + its key points. Start with a short title line "TITLE: <page title>".`,
        { llm, context: profiles.contextLine(chatId, Date.now()) || undefined, ...agentEnvFor(chatId) }, []);
      const body = formatReply(res.reply);
      const tm = body.match(/^\s*TITLE:\s*(.+)$/im);
      title = tm ? tm[1]!.trim() : "";
      summary = body.replace(/^\s*TITLE:\s*.+$/im, "").trim() || body.trim();
      if (res.degraded || !summary) return { error: `I couldn't read ${hostLabel(url)} to save it just now — the page didn't load. Try again in a bit.` };
    } catch {
      return { error: `I couldn't reach ${hostLabel(url)} to save it. Try again in a bit.` };
    }
    const r = saved.add(chatId, { url, title, summary }, Date.now());
    return { title: r.page.title, url, saved: r.saved, dup: r.dup };
  },
  recallSaved: (chatId, text) => {
    // "what haven't I read" -> the stale-unread nudge (saved-page-unread-nudge), checked before the
    // general recall so it isn't shadowed by the broader recall matcher.
    if (isUnreadSavedRequest(text)) {
      const pages = saved.unread(chatId, SAVED_STALE_MS, Date.now());
      const nudge = formatUnreadNudge(pages);
      if (!nudge) return "Nothing saved that you haven't already revisited. Save a page with \"save this <link>\".";
      saved.markRecalled(chatId, pages.map((p) => p.url), Date.now()); // seeing them here counts as a revisit
      return nudge;
    }
    const q = parseSavedRecall(text);
    if (!q) return null;
    const hits = saved.search(chatId, q.topic, 8);
    if (!hits.length) {
      return q.topic
        ? `Nothing saved matching "${q.topic}". Save a page with "save this <link>".`
        : `You haven't saved anything yet. Send "save this <link>" and I'll summarize + file it for recall.`;
    }
    saved.markRecalled(chatId, hits.map((p) => p.url), Date.now()); // recalled = revisited, don't nudge these
    const head = q.topic ? `Saved pages about "${q.topic}":` : "Your recent saved pages:";
    const body = hits.map((p) => `• ${p.title} — ${p.summary}\n  ${p.url}`).join("\n\n");
    return `${head}\n${body}`;
  },
  // Saved named places (saved-named-places): "my work is 500 5th Ave" / "save gym: ..." stores an alias
  // -> address; it's injected into the agent context so "weather at the gym"/"coffee near work" resolve
  // without re-asking the city. forget/list manage them. All null when the message isn't a place command.
  savePlace: (chatId, text) => {
    const p = parseSavePlace(text);
    if (!p) return null;
    const r = places.save(chatId, p.name, p.address, Date.now());
    return { name: r.place.name, address: r.place.address, saved: r.saved };
  },
  forgetPlace: (chatId, text) => {
    const name = parseForgetPlace(text);
    if (!name) return null;
    // saved reflects whether the removal persisted (delete-persist-hedge) — a failed write brings the
    // alias back on restart, so the handler hedges instead of a clean "forgot it".
    return places.forget(chatId, name) ? { name, saved: places.lastSaveOk() } : { name, saved: true, notFound: true };
  },
  isListPlacesRequest: (text) => isListPlacesRequest(text),
  placeList: (chatId) => places.list(chatId).map((p) => ({ name: p.name, address: p.address })),
  // Quick-log tracker (quick-log-tracker): "log weight 182" / "spent $14 on lunch" -> append a tagged
  // point; "show my weight this month" / "how much did I spend on food" -> a summary (+ chart PNG for a
  // trend). null when the message isn't a log command/query. Reuses summarizeSeries + renderChart.
  logAdd: (chatId, text, now) => {
    const cmd = parseLogCommand(text);
    if (!cmd) return null;
    const r = logs.add(chatId, cmd.tag, cmd.value, now, cmd.unit);
    if (!r) return { ok: false, reason: "capped" };
    return { ok: true, tag: cmd.tag, value: cmd.value, unit: cmd.unit ?? logs.unitOf(chatId, cmd.tag), count: r.count, saved: r.saved };
  },
  logQuery: async (chatId, text, now) => {
    const q = parseLogQuery(text, now);
    if (!q) return null;
    const points = logs.seriesOf(chatId, q.tag);
    if (!points.length) return { tag: q.tag, text: `I don't have any "${q.tag}" logged yet. Track it with "log ${q.tag} <value>" (or "spent $X on ${q.tag}").` };
    const unit = logs.unitOf(chatId, q.tag);
    if (q.mode === "sum") {
      const { total, count } = sumSeries(points, q.sinceMs);
      const when = q.sinceMs ? " in that window" : " total";
      return { tag: q.tag, text: `You've spent ${unit === "$" ? "$" : ""}${total % 1 === 0 ? total : total.toFixed(2)}${unit && unit !== "$" ? ` ${unit}` : ""} on ${q.tag}${when} (${count} entr${count === 1 ? "y" : "ies"}).` };
    }
    // trend: text summary + a chart PNG (falls back to text if the render fails / not enough points).
    const summary = summarizeSeries(points, now, q.sinceMs);
    const png = await renderChart(q.tag, points, defaultFetchBytes, q.sinceMs);
    return { tag: q.tag, text: summary ? `📈 ${q.tag}: ${summary}` : `Not enough "${q.tag}" data to chart yet — log a few more.`, ...(png ? { png } : {}) };
  },
  // Contacts book (contacts-book-compose): save/resolve/forget/list a name -> email/phone.
  saveContact: (chatId, text) => {
    const p = parseSaveContact(text);
    if (!p) return null;
    const c = contacts.save(chatId, p, Date.now());
    if (!c) return null;
    return { name: c.name, ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}), saved: contacts.lastSaveOk() };
  },
  resolveContact: (chatId, name) => {
    const c = contacts.get(chatId, name);
    return c ? { name: c.name, ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}) } : null;
  },
  forgetContact: (chatId, text) => {
    const name = parseForgetContact(text);
    if (!name) return null;
    // saved reflects whether the removal persisted (delete-persist-hedge) — a failed write brings the
    // contact back on restart, so the handler hedges instead of a clean "forgot it".
    return contacts.forget(chatId, name) ? { name, saved: contacts.lastSaveOk() } : null;
  },
  contactList: (chatId) => contacts.list(chatId).map((c) => ({ name: c.name, ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}) })),
  // Named lists (personal-notes-lists-store): parse a list op + render the reply. Null falls through
  // to the scheduler/agent when it isn't a list command. Reads back the full list on every mutation so
  // the user sees the current state (a grocery list is only useful if you can see what's on it).
  // Export a named list as CSV (csv-export-tabular): parse the export command + hand the handler the
  // list's items (it builds the .csv + sends it). null when it isn't an export command.
  listExport: (chatId, text) => {
    const p = parseListExport(text);
    if (!p) return null;
    return { name: p.list, items: lists.show(chatId, p.list) };
  },
  listCommand: (chatId, text) => {
    const cmd = parseListCommand(text);
    if (!cmd) return null;
    const label = cmd.list === "list" ? "list" : `${cmd.list} list`;
    const render = (items: string[]) =>
      items.length ? items.map((i) => `• ${i}`).join("\n") : "(empty)";
    if (cmd.op === "add") {
      const items = splitItems(cmd.item);
      if (!items.length) return null;
      const r = lists.add(chatId, cmd.list, items);
      if (!r) return `You've hit my limit of saved lists — clear one first with "clear my <name> list".`;
      // Items dropped because the list is FULL (lists-cap-silent-drop): tell the user which + that the list
      // is at its cap, instead of silently losing them. Shown whether or not anything else was added.
      const cappedNote = r.capped.length
        ? `\n\n⚠️ Your ${label} is full (${MAX_ITEMS_PER_LIST} max), so I couldn't add: ${r.capped.map((i) => `"${i}"`).join(", ")}. Remove a few first.`
        : "";
      if (!r.added.length) {
        return r.capped.length
          ? `Your ${label} is full (${MAX_ITEMS_PER_LIST} max) — I couldn't add ${r.capped.map((i) => `"${i}"`).join(", ")}. Remove some with "remove <item> from my ${label}".`
          : `Already on your ${label}. It has:\n${render(r.list)}`;
      }
      const what = r.added.length === 1 ? `"${r.added[0]}"` : `${r.added.length} items`;
      // saved=false: the disk write failed. Don't claim it's kept — tell the truth so the user can retry
      // (lists-remove-atomic-write-failure). It's in memory this session but won't survive a restart.
      const warn = r.saved ? "" : `\n\n⚠️ Heads up — I couldn't save that to disk, so it may be lost if I restart. Try again in a moment.`;
      return `Added ${what} to your ${label}. Now:\n${render(r.list)}${cappedNote}${warn}`;
    }
    // A failed disk write on a delete brings the item back on restart, contradicting the confirmation —
    // hedge it (delete-persist-hedge), mirroring the add path's warn.
    const persistWarn = `\n\n⚠️ Heads up — I couldn't save that change to disk, so it may come back if I restart. Try again in a moment.`;
    if (cmd.op === "remove") {
      const removed = lists.remove(chatId, cmd.list, cmd.item);
      if (!removed.length) return `I couldn't find "${cmd.item}" on your ${label}. It has:\n${render(lists.show(chatId, cmd.list))}`;
      const warn = lists.lastSaveOk() ? "" : persistWarn;
      return `Removed ${removed.map((i) => `"${i}"`).join(", ")} from your ${label}. Now:\n${render(lists.show(chatId, cmd.list))}${warn}`;
    }
    if (cmd.op === "clear") {
      const n = lists.clear(chatId, cmd.list);
      if (!n) return `Your ${label} was already empty.`;
      const warn = lists.lastSaveOk() ? "" : persistWarn;
      return `Cleared your ${label} (${n} item${n === 1 ? "" : "s"}).${warn}`;
    }
    // show
    const items = lists.show(chatId, cmd.list);
    return items.length
      ? `Your ${label}:\n${render(items)}`
      : `Your ${label} is empty. Add to it with "add <item> to my ${label}".`;
  },
  // Answer history (answer-history-recall): search past answers by keyword; log a fresh clean answer.
  recallAnswers: (chatId, text) => answerLog.search(chatId, recallKeywords(text), 3),
  logAnswer: (chatId, task, reply) => answerLog.record(chatId, task, reply, Date.now()),
  // Watch time series (watch-time-series): "how has <watch> moved this week" answered from stored points.
  watchTrend: (chatId, text) => {
    const req = parseTrendRequest(text, Date.now());
    if (!req) return null;
    const a = alerts.get(chatId, req.name);
    if (!a) return null; // not a watch by that name — let it fall through to the agent
    const summary = summarizeSeries(alerts.seriesOf(chatId, req.name), Date.now(), req.sinceMs);
    return summary ? `📈 ${a.name}: ${summary}` : `I haven't logged enough checks of "${a.name}" yet to show a trend — give it a few more.`;
  },
  // Chart a watch (chart-it-tool): "chart btc" / "graph my btc watch this week" -> a PNG line chart of
  // the watch's recorded series via keyless quickchart.io. Returns {png} to send as a photo, {text} for
  // a not-enough-data / unknown-watch note, or null (not a chart ask -> falls through). The handler
  // sends the photo via its existing sendPhoto path.
  chartWatch: async (chatId, text) => {
    const req = parseChartRequest(text, Date.now());
    if (!req) return null;
    const a = alerts.get(chatId, req.name);
    if (!a) return { text: `I don't have a watch called "${req.name}" to chart. Set one with "watch ${req.name}: ..." first, or ask me to chart an existing watch (see /alerts).` };
    const png = await renderChart(a.name, alerts.seriesOf(chatId, req.name), defaultFetchBytes, req.sinceMs);
    if (!png) return { text: `I haven't logged enough checks of "${a.name}" yet to chart it — give it a few more.` };
    return { png, caption: `📈 ${a.name}${req.sinceMs ? " (recent)" : ""}` };
  },
  // First-run location capture (first-location-capture): does this chat have a home location yet, and
  // save a bare "which city?" reply (+re-stamp recurring reminders if a tz came with it).
  hasLocation: (chatId) => { const p = profiles.get(chatId); return !!(p?.location || profiles.freshCoords(chatId, Date.now())); },
  saveCoords: (chatId, lat, lng) => { profiles.set(chatId, { lat, lng, coordsAt: Date.now() }); return profiles.lastSaveOk(); },
  weatherCoords: (chatId) => profiles.freshCoords(chatId, Date.now()),
  weatherUnits: (chatId) => profiles.get(chatId)?.units,
  captureLocation: (chatId, text) => {
    const c = parseCityReply(text, Date.now()); // DST-correct inferred offset at "now" (reminder-wrong-timezone-dst)
    if (!c) return null;
    const rec = profiles.set(chatId, { location: c.location, ...(c.tzOffsetMin !== undefined ? { tzOffsetMin: c.tzOffsetMin } : {}) });
    if (c.tzOffsetMin !== undefined) schedules.restampTz(chatId, c.tzOffsetMin, Date.now(), profiles.zone(chatId));
    return { location: rec.location!, tzOffsetMin: rec.tzOffsetMin, saved: profiles.lastSaveOk() };
  },
  suggestSaves: true, // offer to save a repeated ask as a recipe (product-loop retention nudge)
  lastResultStore, // shared with the schedule runner so drilldown works on proactive pings too
  pickListStore,   // shared so a "pick N" tap resolves against an inbound OR proactive list (picker-on-proactive-pings)
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
  // Decode a QR/barcode from a sent photo (read-qr-from-photo): download the image, POST it multipart to
  // the keyless api.qrserver.com reader. Fixed host (no user-supplied URL) so no SSRF surface.
  readQr: async (fileId) => {
    const file = await downloadFile(fileId);
    if (!file) return null;
    return readQrFromBytes(file.bytes, async (url, bytes) => {
      const fd = new FormData();
      fd.append("file", new Blob([bytes], { type: file.mimeType || "image/png" }), "qr.png");
      const r = await fetch(url, { method: "POST", body: fd });
      return r.text();
    });
  },
  // Inbound voice note (product-loop): download + transcribe to text (the handler then runs it).
  transcribeVoice: llm.transcribeAudio
    ? async (fileId) => {
        const file = await downloadFile(fileId);
        if (!file) return "";
        return llm.transcribeAudio!(file.bytes, file.mimeType);
      }
    : undefined,
  // Inbound document (product-loop / inbound-document-handling): download, then split by type.
  //  - TEXTUAL (csv/json/txt/md/log): decode the bytes + answer via the TEXT model (complete). A CSV
  //    handed to the vision path came back as garbage (bytes mislabeled image/jpeg) — this is the fix.
  //  - VISION (pdf/image scan): keep the multimodal inlineData path (needs describeImage/Gemini).
  // Always defined (complete() always exists), so textual docs work even on a text-only provider.
  describeDocument: async (fileId, caption, fileName, mimeType) => {
    const file = await downloadFile(fileId);
    if (!file) return "I couldn't download that file — try resending it.";
    const mime = mimeType || file.mimeType;
    if (isTextualDoc(mime, fileName)) {
      const text = decodeTextDoc(file.bytes);
      if (!text.trim()) return "That file looks empty or I couldn't read it as text — try resending it.";
      const prompt = buildDocPrompt(text, caption ?? "", fileName);
      const r = await llm.complete([{ role: "user", content: prompt }], []);
      return r.text?.trim() || "I read the file but couldn't produce an answer — try asking about a specific part.";
    }
    if (!llm.describeImage) return "That looks like a scanned/PDF file, and I can't read those on this setup yet — if it's a CSV or text file, resend it as one and I'll read it.";
    const prompt = caption?.trim() || "Summarize this document and flag anything important (totals, dates, actions).";
    return llm.describeImage(file.bytes, mime, prompt);
  },
  scheduleAdd: (chatId, text, now) => {
    // Use the chat's own timezone (from their profile) so "every morning" fires at THEIR 9am,
    // not the deploy host's UTC. Falls back to the global RELAY_TZ_OFFSET_MIN when unset.
    const p = parseSchedule(text, now, profiles.offsetMin(chatId));
    if (!p) return { ok: false, reason: "unparsed" };
    const zone = profiles.zone(chatId); // stamp the IANA zone so a recurring reschedule stays DST-correct
    if (zone) p.zone = zone;
    const rec = schedules.add(chatId, p, now);
    if (!rec) return { ok: false, reason: "capped" };
    // Resolved next-fire time in the chat's own zone, so a wrong/absent tz is visible before it fires.
    const whenText = formatWhen(rec.dueMs, profiles.offsetMin(chatId) ?? tzOffsetMin(), now);
    // Flag a CLOCK-TIME schedule (daily/weekly, or a once "at <time>") created with NO saved timezone:
    // it resolves against UTC, so a new user's "remind me at 8am" fires in the middle of their night.
    // A relative "in N min/hours" reminder has no wall-clock dependency, so it's never flagged.
    const isClockTime = rec.kind === "daily" || rec.kind === "weekly" || rec.kind === "monthly" || rec.kind === "yearly" || /\bat\s+\d/i.test(text) || /\b(morning|evening|night|noon|midnight)\b/i.test(text);
    const noTz = isClockTime && profiles.offsetMin(chatId) === undefined && tzOffsetMin() === 0;
    return { ok: true, kind: rec.kind, task: rec.task, whenMs: rec.dueMs, whenText, noTz, saved: schedules.lastSaveOk(), ...(rec.sticky ? { sticky: true } : {}) };
  },
  // Countdown (countdown-tracker): parse "countdown to X on <date>" + schedule milestone reminder-onces
  // (a week out / day before / morning of) so Relay pings as the day nears, then confirm with the day
  // count. Reuses the ScheduleStore (each milestone is a reminderOnly clock-time once) — no new runner.
  countdownAdd: (chatId, text, now) => {
    const off = profiles.offsetMin(chatId) ?? tzOffsetMin();
    // The chat's LOCAL today (now shifted into its tz), so "Dec 20" counts from the user's calendar day.
    const local = new Date(now + off * 60_000);
    const today = { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
    const c = parseCountdown(text, today);
    if (!c) return null;
    if (c.daysAway < 0) return { ok: false, reason: "past", message: formatCountdown(c) };
    // Schedule the future milestones as reminder-onces (skip if the countdown is same-day — the
    // confirmation already says "today"). clockTime so a later tz change re-stamps them.
    const milestones = countdownMilestones(c.target, now, off);
    let scheduled = 0;
    for (const ms of milestones) {
      const rec = schedules.add(chatId, { kind: "once", task: milestonePing(c.label, ms.daysBefore), dueMs: ms.whenMs, reminderOnly: true, clockTime: true, offsetMin: off }, now);
      if (rec) scheduled++;
    }
    return { ok: true, message: formatCountdown(c), milestones: scheduled, saved: schedules.lastSaveOk() };
  },
  // Contact follow-up nudge (contact-followup-nudge): "follow up with Sarah in 3 days" -> a reminder
  // that, on fire, names the person + (if saved) carries their handle + a one-tap draft link. Resolves
  // the contact NOW and bakes the handle into the reminder text, so the fire-time echo is self-contained
  // (no lookup needed in the runner). reminderOnly so it echoes rather than running the agent.
  followUpAdd: (chatId, text, now) => {
    const p = parseFollowUp(text);
    if (!p) return null;
    const c = contacts.get(chatId, p.name);
    const label = c?.name ?? p.name;
    // Build the fire-time reminder text: "follow up with <name>" + their handle + a tap-to-draft link.
    let task = `follow up with ${label}`;
    if (c?.email) task += `\n✉️ ${c.email} — tap to draft: ${mailtoLink({ kind: "email", to: c.email, body: "" })}`;
    else if (c?.phone) task += `\n💬 ${c.phone} — tap to text: ${smsLink({ kind: "message", to: c.phone, body: "" })}`;
    // Reuse the schedule parser for the WHEN clause (relative "in 3 days" / "on Friday" / "next week").
    const sp = parseScheduleFor(p.when, task, now, profiles.offsetMin(chatId));
    if (!sp) return { ok: false, reason: "unparsed" };
    const rec = schedules.add(chatId, { ...sp, reminderOnly: true }, now);
    if (!rec) return { ok: false, reason: "capped" };
    const whenText = formatWhen(rec.dueMs, profiles.offsetMin(chatId) ?? tzOffsetMin(), now);
    return { ok: true, name: label, whenText, hasContact: !!c, saved: schedules.lastSaveOk() };
  },
  // First-reminder tz (first-reminder-tz-ask): would this message schedule a CLOCK-TIME task with no
  // saved tz? If so the handler asks the city first (city→tz) rather than scheduling wrong-at-UTC.
  scheduleNeedsTz: (chatId, text, now) => {
    if (profiles.offsetMin(chatId) !== undefined || tzOffsetMin() !== 0) return false; // tz already known
    const p = parseSchedule(text, now, profiles.offsetMin(chatId));
    if (!p) return false;
    const isClockTime = p.kind === "daily" || p.kind === "weekly" || p.kind === "monthly" || p.kind === "yearly" || /\bat\s+\d/i.test(text) || /\b(morning|evening|night|noon|midnight)\b/i.test(text);
    return isClockTime;
  },
  scheduleList: (chatId) => schedules.list(chatId).map((s) => ({ id: s.id, kind: s.kind, task: s.task, dueMs: s.dueMs })),
  // Unified dashboard (unified-dashboard): aggregate every store into one rollup. Pure read — it gathers
  // from the live stores (owning the tz offset + pause state) and hands formatDashboard ready strings.
  dashboardView: (chatId) => {
    const now = Date.now();
    const off = profiles.offsetMin(chatId) ?? tzOffsetMin();
    const sched = schedules.list(chatId);
    // A schedule whose task is an alert:/digest:/recipe: marker drives another automation — surface its
    // PAUSE state under that automation, not as a raw reminder. Map marker-name -> its pause info.
    const markerPause = new Map<string, { paused: boolean; untilText?: string }>();
    const pauseInfo = (s: (typeof sched)[number]) => {
      const paused = s.pausedUntil !== undefined && now < s.pausedUntil;
      const untilText = paused && s.pausedUntil !== Number.MAX_SAFE_INTEGER ? formatWhen(s.pausedUntil!, off, now) : undefined;
      return { paused, ...(untilText ? { untilText } : {}) };
    };
    for (const s of sched) {
      const m = s.task.match(/^(alert|digest|recipe):(.+)$/i);
      if (m) markerPause.set(`${m[1]!.toLowerCase()}:${m[2]!.toLowerCase()}`, pauseInfo(s));
    }
    const data: DashboardData = {
      // Reminders: schedules that AREN'T markers (a real "remind me"/"every morning" task).
      schedules: sched.filter((s) => !/^(alert|digest|recipe):/i.test(s.task)).map((s) => {
        const p = pauseInfo(s);
        return { kind: s.kind, task: s.task, whenText: formatWhen(s.dueMs, off, now), paused: p.paused, pausedUntilText: p.untilText };
      }),
      alerts: alerts.list(chatId).map((a) => {
        const trigger = a.members?.length ? `watchlist, ${a.members.length} items`
          : a.feed ? "new items"
          : a.condition ? (a.condition.op === "in_stock" ? "in stock" : `${a.condition.op} ${a.condition.operand}`)
          : a.threshold ? `±${a.threshold}` : "on change";
        const p = markerPause.get(`alert:${a.name.toLowerCase()}`) ?? { paused: false };
        return { name: a.name, trigger, lastValue: a.lastValue, paused: p.paused, pausedUntilText: p.untilText };
      }),
      digests: digests.list(chatId).map((d) => {
        const p = markerPause.get(`digest:${d.name.toLowerCase()}`) ?? { paused: false };
        return { name: d.name, memberCount: d.members.length, scheduleText: d.schedule, paused: p.paused, pausedUntilText: p.untilText };
      }),
      recipes: recipes.list(chatId).map((r) => {
        const p = markerPause.get(`recipe:${r.name.toLowerCase()}`) ?? { paused: false };
        return { name: r.name, scheduled: !!r.schedule, scheduleText: r.schedule, paused: p.paused, pausedUntilText: p.untilText };
      }),
    };
    return formatDashboard(data);
  },
  scheduleCancel: (chatId, which) => {
    // saved reflects whether the removal reached disk (delete-persist-hedge): a failed write means the
    // cancelled reminder re-fires after a restart, so the handler hedges instead of a clean "cancelled".
    if (which.toLowerCase() === "all") {
      const all = schedules.list(chatId);
      let n = 0; for (const s of all) if (schedules.remove(s.id, chatId)) n++;
      return { removed: n, saved: n === 0 || schedules.lastSaveOk() };
    }
    const removed = schedules.remove(which, chatId) ? 1 : 0;
    return { removed, saved: removed === 0 || schedules.lastSaveOk() };
  },
  // Snooze (snooze-automations): pause/resume a schedule/alert/digest by name or id, non-destructively.
  scheduleSnooze: (chatId, text, now) => {
    const p = parseSnoozeCommand(text, now);
    if (!p) return null;
    if (p.action === "resume") {
      return { action: "resume", count: schedules.resume(chatId, p.which, now), which: p.which };
    }
    const untilMs = p.untilMs ?? PAUSE_INDEFINITE;
    const count = schedules.pause(chatId, p.which, untilMs);
    const untilText = p.untilMs !== undefined ? formatWhen(untilMs, profiles.offsetMin(chatId) ?? tzOffsetMin(), now) : undefined;
    return { action: "pause", count, which: p.which, ...(untilText ? { untilText } : {}) };
  },
  // Sticky ack (sticky-acknowledged-reminders): a bare "done"/"stop" stops the chat's re-pinging sticky
  // reminders. Returns [] when the chat has none (so the handler leaves a normal "done" alone).
  // Gate on a RECENTLY-fired (or not-yet-fired) sticky (sticky-ack-only-when-recent): a bare "ok"/"got
  // it" replying to some UNRELATED answer hours after the nag last pinged used to silently DELETE the
  // meds/water safety-net reminder. Only treat the ack as dismissing the nag when a sticky pinged within
  // the window (the user is plausibly replying to it) or hasn't fired yet (the ack is about the setup).
  stickyAck: (chatId, text) => {
    if (!isStickyAck(text) || !schedules.hasSticky(chatId)) return [];
    if (!schedules.hasRecentlyFiredSticky(chatId, Date.now(), STICKY_ACK_WINDOW_MS)) return [];
    return schedules.acknowledgeSticky(chatId).map((s) => s.task);
  },
  recipeSave: (chatId, text) => {
    const p = parseRecipeCommand(text);
    if (!p) return { ok: false, reason: "unparsed" };
    const rec = recipes.add(chatId, p, Date.now());
    if (!rec) return { ok: false, reason: "capped" };
    const droppedSteps = chainOverflow(p.task); // chain steps past the cap (chain-step-cap-silent-drop)
    return { ok: true, name: rec.name, saved: recipes.lastSaveOk(), ...(droppedSteps ? { droppedSteps } : {}) };
  },
  // "save that as <name>" (product-loop): store a name + the handler-supplied prior task.
  recipeSaveNamed: (chatId, name, task) => {
    const rec = recipes.add(chatId, { name, task }, Date.now());
    if (!rec) return { ok: false, reason: "capped" };
    const droppedSteps = chainOverflow(task);
    return { ok: true, name: rec.name, saved: recipes.lastSaveOk(), ...(droppedSteps ? { droppedSteps } : {}) };
  },
  recipeResolve: (chatId, text) => {
    // Parse name + args so a recipe with {slots} runs with the user's values (product-loop).
    const parsed = parseRunWithArgs(text);
    if (!parsed) return null;
    const rec = recipes.get(chatId, parsed.name);
    if (!rec) return null;
    // A slotted recipe run with no value would substitute empty + run a broken task — ask instead.
    if (hasSlots(rec.task) && !parsed.args.trim()) return { name: rec.name, missingArg: true };
    // A multi-slot recipe filled positionally with a token/slot mismatch (a multi-word value, no commas/
    // pairs) would silently mis-map — ask for a clearer form instead of a confident wrong run.
    if (slotsAmbiguous(rec.task, parsed.args)) return { name: rec.name, ambiguousArgs: true, slots: slotNames(rec.task) };
    return { name: rec.name, task: applySlots(rec.task, parsed.args) };
  },
  // Run a chained recipe (">>"-separated steps) sequentially, feeding each step's output to the next.
  runChainRecipe: async (chatId, task) => {
    const r = await runChain(chatId, task, { llm, runAgent, formatReply, contextFor: (c) => profiles.contextLine(c, Date.now()), agentEnv: agentEnvFor });
    // Surface stoppedEarly + step counts so the handler flags a partial answer (chain-progress-partial).
    return { final: r.final, stoppedEarly: r.stoppedEarly, stepsDone: r.steps.filter((s) => !s.skipped).length, stepsTotal: r.steps.length };
  },
  recipeList: (chatId) => recipes.list(chatId).map((r) => ({ name: r.name, task: r.task, schedule: r.schedule })),
  // recipe-auto-recall: offer a saved recipe when a free-text message strongly matches its task. Skip
  // command-shaped messages (a /run|save|watch... already routes elsewhere) so we never double-handle.
  recipeMatch: (chatId, text) => {
    if (/^\s*(?:\/|run\b|save\b|watch\b|alert\b|change\b|remind|every\b|schedule\b|digest\b)/i.test(text)) return null;
    return matchRecipe(text, recipes.list(chatId).map((r) => ({ name: r.name, task: r.task })));
  },
  recipeForget: (chatId, name) => {
    // Cancel the scheduled "recipe:<name>" marker too, else the runner keeps firing after the recipe
    // is gone (orphaned-schedule-on-forget). A stable marker (not the raw task) means this matches
    // even if the recipe's task was edited after it was scheduled.
    const rec = recipes.get(chatId, name);
    const removed = recipes.remove(chatId, name);
    if (removed && rec) schedules.removeByTask(chatId, `recipe:${rec.name}`);
    return removed;
  },
  recipeSchedule: (chatId, name, whenClause, now) => {
    const rec = recipes.get(chatId, name);
    if (!rec) return { ok: false, reason: "unknown" };
    // A slotted recipe has no per-fire value on a schedule, so it would emit the literal "{slot}"
    // and return nonsense every day (product-loop) — refuse with a clear reason.
    if (hasSlots(rec.task)) return { ok: false, reason: "needsarg" };
    // Schedule a STABLE "recipe:<name>" marker (like digest:/alert:); the runner resolves the recipe's
    // CURRENT task at fire time, so editing the recipe changes what fires + forgetting it stops it.
    const p = parseScheduleFor(whenClause, `recipe:${rec.name}`, now, profiles.offsetMin(chatId));
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
    const dropped = digests.lastDroppedForCap(); // members past the per-digest cap (digest-recipe-cap-silent-drop)
    return { ok: true, name: rec.name, members: rec.members.length, saved: digests.lastSaveOk(), ...(dropped.length ? { dropped } : {}) };
  },
  digestList: (chatId) => digests.list(chatId).map((d) => ({ name: d.name, members: d.members, schedule: d.schedule })),
  digestForget: (chatId, name) => {
    // Also cancel the scheduled "digest:<name>" marker so a removed digest stops firing "(digest is
    // empty or was removed)" every morning (orphaned-schedule-on-forget). Use the canonical stored
    // name before removal so the marker matches what digestSchedule wrote.
    const d = digests.get(chatId, name);
    const removed = digests.remove(chatId, name);
    if (removed && d) schedules.removeByTask(chatId, `digest:${d.name}`);
    return removed;
  },
  isDigest: (chatId, name) => !!digests.get(chatId, name),
  digestRun: (chatId, name) => digestRunText(chatId, name),
  // Weekly unread-nudge opt-in (weekly-unread-proactive-nudge): add/remove a WEEKLY "unread:" schedule the
  // runner fires via the unreadNudge dep. One per chat (removeByTask first so a re-opt-in doesn't stack).
  unreadNudgeToggle: (chatId, text) => {
    const t = parseUnreadNudgeToggle(text);
    if (!t) return null;
    schedules.removeByTask(chatId, "unread:reading-list");
    // A failed disk write means the toggle silently reverts on restart while the user was told it stuck
    // (delete-persist-hedge / lists-remove-atomic-write-failure) — hedge both directions on !lastSaveOk.
    if (!t.on) {
      const warn = schedules.lastSaveOk() ? "" : " (⚠️ but I couldn't save that to disk — the nudges may come back if I restart; try again in a moment.)";
      return `Okay, I've turned off your weekly reading-list nudges.${warn}`;
    }
    const p = parseScheduleFor("every monday at 9am", "unread:reading-list", Date.now(), profiles.offsetMin(chatId));
    if (!p) return "I couldn't set that up just now — try again.";
    const s = schedules.add(chatId, p, Date.now());
    if (!s) return "You have a lot of automations already — remove one and try again.";
    const warn = schedules.lastSaveOk() ? "" : "\n\n⚠️ But I couldn't save that to disk — the nudge may be lost if I restart. Try again in a moment.";
    return `Done — every Monday morning I'll remind you of saved pages you haven't gotten back to. Say "stop reading list nudges" to turn it off.${warn}`;
  },
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
    // Auto-schedule the check (marker "alert:<name>"). alerts.add UPDATES in place when the name
    // already exists, so re-stating a watch ("watch btc: ..." then "watch btc: ... in USD") must NOT
    // stack a 2nd/3rd cadence row — each would run a redundant anvil check forever + fill /schedules.
    // Clear any existing marker first so the schedule is idempotent per alert name (audit 15 B#1).
    schedules.removeByTask(chatId, `alert:${rec.name}`);
    const alertSaved = alerts.lastSaveOk();
    const sp = parseScheduleFor(ALERT_CADENCE, `alert:${rec.name}`, now, profiles.offsetMin(chatId));
    if (sp) schedules.add(chatId, sp, now);
    // saved = both the alert row AND its cadence schedule reached disk (either failing means the watch
    // won't survive a restart / won't actually fire) — persist-bool-all-stores.
    const saved = alertSaved && (!sp || schedules.lastSaveOk());
    return { ok: true, name: rec.name, feed: rec.feed, then: rec.then, members: rec.members?.length, ...(p.droppedMembers?.length ? { droppedMembers: p.droppedMembers } : {}), ...(rec.pageUrl ? { pageUrl: rec.pageUrl } : {}), ...(rec.weather ? { weather: describeWeatherCondition(rec.weather) } : {}), saved };
  },
  // Follow-feed subscriptions (follow-feed-subscriptions): "follow r/x / a blog / HN topic / a YT
  // channel" -> a feed watch backed by a KEYLESS direct fetch (feedSource), auto-scheduled on the same
  // cadence as alerts. Reuses the whole feed-watch new-item path; only the source differs. Returns null
  // when the target can't be resolved to a keyless feed (handler then suggests the agent "watch ... for
  // new items" form).
  followFeed: (chatId, text, now) => {
    const parsed = parseFollowCommand(text);
    if (!parsed) return null;
    const src = resolveFeedSource(parsed.target);
    if (!src) return { ok: false, reason: "unresolved" };
    const rec = alerts.add(chatId, { name: parsed.name, task: `follow ${src.label}`, feed: true, feedSource: src }, now);
    if (!rec) return { ok: false, reason: "capped" };
    schedules.removeByTask(chatId, `alert:${rec.name}`);
    const alertSaved = alerts.lastSaveOk();
    const sp = parseScheduleFor(ALERT_CADENCE, `alert:${rec.name}`, now, profiles.offsetMin(chatId));
    if (sp) schedules.add(chatId, sp, now);
    const saved = alertSaved && (!sp || schedules.lastSaveOk());
    return { ok: true, name: rec.name, label: src.label, saved };
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
    // saved reflects whether the trigger change reached disk (alert-edit-persist-hedge): a failed write
    // silently reverts to the old threshold on restart, so the handler hedges like every other write path.
    return { ok: true, name: rec.name, summary: `now alerts ${summary}`, saved: alerts.lastSaveOk() };
  },
  alertList: (chatId) => alerts.list(chatId).map((a) => ({ name: a.name, task: a.task, lastValue: a.lastValue, threshold: a.threshold, feed: a.feed, then: a.then, members: a.members?.length })),
  alertForget: (chatId, name) => {
    // Also cancel the auto-scheduled "alert:<name>" check so a forgotten alert stops running on its
    // cadence forever (orphaned-schedule-on-forget).
    const a = alerts.get(chatId, name);
    const removed = alerts.remove(chatId, name);
    if (removed && a) schedules.removeByTask(chatId, `alert:${a.name}`);
    return removed;
  },
  sendMessage: (chatId, text, keyboard) => channel.sendMessage(chatId, text, keyboard),
  // Inline-button tap ack (inline-tap-buttons): telegram channel clears the spinner + shows a toast;
  // console channel has no callbacks, so this is absent there.
  answerCallback: channel.answerCallback ? (id, toast) => channel.answerCallback!(id, toast) : undefined,
  editReplyMarkup: channel.editReplyMarkup ? (chatId, messageId, keyboard) => channel.editReplyMarkup!(chatId, messageId, keyboard) : undefined,
  // "Run again" on a scheduled-recipe ping (inline-tap-buttons): resolve + run the recipe's CURRENT
  // task by name, chain-aware, mirroring the scheduler's runThen path. null when gone/slotted/degraded.
  recipeRunByName: async (chatId, name) => {
    const rec = recipes.get(chatId, name);
    if (!rec || hasSlots(rec.task)) return null;
    if (isChain(rec.task)) {
      const chained = (await runChain(chatId, rec.task, { llm, runAgent, formatReply, contextFor: (c) => profiles.contextLine(c, Date.now()), agentEnv: agentEnvFor })).final;
      return chained?.trim() ? chained : null;
    }
    const out = await runAgent(rec.task, { llm, context: profiles.contextLine(chatId, Date.now()) || undefined, ...agentEnvFor(chatId) }, []);
    return out.degraded ? null : formatReply(out.reply);
  },
  sendPhoto,
  sendDocument,
  sendTyping,
  requestLocation: channel.requestLocation ? (chatId, text) => channel.requestLocation!(chatId, text) : undefined,
  handleCommand,
  checkRateLimit,
  // Redact secrets AND any seeded cookie values (m29 cookies-2) from logged/echoed text.
  redactText: (t: string) => redactCookieValues(redactText(t)),
  hasModelKey: () => !!(LLM_PROVIDER === "claude" ? process.env.ANTHROPIC_API_KEY : process.env.GEMINI_API_KEY),
  recordTurn,
  recordCommand: (name) => metrics.recordCommand(name),
  // Corrupt-store notice (corrupt-store-silent-wipe): one-time message naming which stores failed to
  // load. PEEK-only (does NOT drain) so a failed send doesn't lose it (corrupt-notice-lost-if-send-fails)
  // — the handler acks it via corruptNoticeAck only after a confirmed delivery. Null when clean.
  corruptNotice: () => {
    if (!corruptedStores.length) return null;
    const which = corruptedStores.join(", ");
    return `⚠️ Heads up — some of my saved data (${which}) couldn't be loaded and may have been reset (I kept a backup of the unreadable file). If something you set up is missing, please set it up again.`;
  },
  // Drain the corrupt-store list once its notice was actually delivered, so it fires ONCE per startup.
  corruptNoticeAck: () => { corruptedStores.splice(0); },
  now: () => Date.now(),
  // Interim "still working" ping if an errand outlasts this (product-loop). 0 disables. Default 6s.
  progressDelayMs: Number(process.env.RELAY_PROGRESS_DELAY_MS ?? 6000),
  // Background errands (async-background-errands): ACK + run detached a large "get back to me" task.
  // On by default; set RELAY_BACKGROUND_ERRANDS=0 to force every task synchronous.
  enableBackgroundErrands: process.env.RELAY_BACKGROUND_ERRANDS !== "0",
  bgErrandAdd: (chatId, text) => backgroundStore.add(chatId, text, Date.now()),
  bgErrandDelivered: (id) => backgroundStore.markDelivered(id), // bg-errand-double-fire: persist delivered before the send
  bgErrandDone: (id) => backgroundStore.remove(id),
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

  // Register the Telegram "/" command menu so the native picker shows our commands + descriptions
  // (product-loop). Best-effort + telegram-only (no-op without a token / on the console channel).
  if (channel.name === "telegram") void registerCommands().then((ok) => { if (ok) console.log("telegram command menu registered"); });

  scheduleRunner.start();              // fire proactive/scheduled tasks (no-op if RELAY_SCHED_TICK_MS=0)
  metricsHeartbeat.start();            // periodic metrics flush (no-op if RELAY_METRICS_HEARTBEAT_MS=0)
  if (SCHED_TICK_MS > 0) console.log(`schedule runner on (${schedules.size()} pending, tick ${SCHED_TICK_MS}ms)`);

  console.log(`Relay listening on ${channel.name}…`);
  const poller = channel.start(handle);

  // Background-errand recovery (background-errand-persist): any errand still pending in the store was
  // interrupted by the last stop/crash. Per errand: replay the fresh ones under their EXISTING id via
  // resumeErrand (no drain-gap data loss, no second ACK, and attempts accrue so a poison task that
  // crashes every boot is dropped after MAX_ERRAND_ATTEMPTS), and just notify for stale/poison ones —
  // removing those from the store so they don't linger. Best-effort.
  const interrupted = backgroundStore.list();
  if (interrupted.length) {
    console.log(`[background] recovering ${interrupted.length} interrupted errand(s)`);
    for (const { errand, replay, notice } of planErrandReplay(interrupted, Date.now())) {
      // notice:null (bg-errand-double-fire): an already-delivered errand — the result went out before the
      // crash, so say nothing + just drop the stale record (below), no duplicate ping.
      if (notice) void sendMessage(errand.chatId, notice).catch(() => {});
      if (replay) {
        // Bump attempts + keep the same id (reinstate is a no-op-if-present safety); then re-dispatch.
        backgroundStore.reinstate(errand, Date.now());
        handle.resumeErrand(errand.chatId, errand.text, errand.id);
      } else {
        backgroundStore.remove(errand.id); // stale/poison -> stop tracking, notice already sent
      }
    }
  }
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
