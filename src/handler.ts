// The per-message handler wiring, factored out of index.ts so it's unit-testable with
// injected deps (no live Telegram/LLM/anvil). index.ts builds the real deps; tests pass
// fakes. Flow: slash-command short-circuit -> rate limit -> config check -> agent ->
// SMS-format reply -> persist memory -> per-turn [out]/[metrics] logging.

import type { InboundMessage } from "./telegram.js";
import type { LLMMessage, LLMClient } from "./llm.js";
import { runAgent, type AgentDeps } from "./agent.js";
import { formatReply, formatReplyParts } from "./lib/format-reply.js";
import { isMoreRequest, isLinkRequest, extractLinks, chunkFrom, deliveredLen } from "./lib/last-result.js";
import { formatTurnLog } from "./lib/turn-log.js";
import { friendlyError } from "./lib/failure.js";
import { splitScheduleCommand } from "./lib/schedule.js";
import { repeatedTaskNudge, recurringCta } from "./lib/task-suggest.js";
import { formatUtcOffset } from "./lib/profile.js";
import { isRecallRequest } from "./lib/notes.js";
import { needsLocationContext } from "./lib/profile.js";
import { isBackgroundErrand, stripDispatchPhrasing, BACKGROUND_MAX_STEPS } from "./lib/background.js";
import { isAnswerRecall, relativeAge } from "./lib/answer-log.js";
import { parseSaveThatAs, parseWatchThat, parseScheduleThat, isChain } from "./lib/recipes.js";
import { getTemplate, templateCatalog, templateButtons } from "./lib/templates.js";
import { photoNeedsAgent, photoIsQrScan } from "./lib/photo-intent.js";
import { decodeCallback, alertButtons as buildAlertKeyboard, digestButtons as buildDigestKeyboard, recipeButtons as buildRecipeKeyboard, pickButtons, tryButtons as buildTryButtons, actButtons, installButtons, TRY_EXAMPLES, type InlineKeyboard } from "./lib/callbacks.js";
import { parseResultList, firstUrl, type ResultItem } from "./lib/result-list.js";
import { rowsToCsv } from "./lib/to-csv.js";
import type { DigestOutcome } from "./digest-runner.js";

// Coerce a digest outcome to what an INBOUND /run or callback shows: real content as-is, the all-failed
// `note` verbatim (the user asked right now, so the honest "couldn't build it" is correct — unlike the
// scheduler, which streaks all-failed silently), or null for a gone/empty digest (caller supplies copy).
function digestDisplay(outcome: DigestOutcome): string | null {
  if (outcome && typeof outcome === "object" && "allFailed" in outcome) return outcome.note;
  return outcome;
}

// Tap-to-watch gating (tap-to-watch-on-answers). Only offer the "make this recurring" buttons on a
// task that's a plausible standing errand — NOT a command-shaped message (already an automation / a
// save / a slash command), NOT a trivial one-word ask, NOT a follow-up ("more"/"why"). Conservative so
// the buttons don't clutter every reply.
const AUTOMATION_SKIP_RE = /^\s*(?:\/|run\b|save\b|watch\b|alert\b|change\b|remind|every\b|schedule\b|digest\b|follow\b|snooze\b|pause\b|resume\b|more\b|why\b|link\b)/i;
export function canOfferAutomation(text: string): boolean {
  const t = String(text ?? "").trim();
  if (t.length < 6) return false;                 // too trivial to be a standing errand
  if (t.split(/\s+/).length < 2) return false;    // a single token ("weather" is fine at >=6 chars, "hi" isn't)
  if (AUTOMATION_SKIP_RE.test(t)) return false;   // already a command/automation/follow-up
  return true;
}
// A short watch name derived from a task (tap-to-watch-on-answers): the first salient word(s), so
// "price of bitcoin" -> "bitcoin", "AAPL stock price" -> "aapl". Falls back to "watch" if nothing
// salient. The user can rename via the normal alert flow later; this just needs to be a stable handle.
const SLUG_STOP = new Set(["the", "a", "an", "of", "for", "price", "cost", "what", "whats", "is", "how", "much", "to", "in", "on", "my", "me", "get", "show", "current"]);
export function watchSlug(task: string): string {
  const words = String(task ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const salient = words.filter((w) => w.length > 1 && !SLUG_STOP.has(w));
  return (salient[0] ?? words[0] ?? "watch").slice(0, 20);
}
// True when an answer is a price/number worth a change-watch (so we add "🔔 Watch this"), mirroring
// recurringCta's price signal: a money amount anywhere, or a price/cost ask that returned a number.
export function answerIsWatchable(userText: string, reply: string): boolean {
  const both = `${userText} ${reply}`;
  if (/[$€£]\s?\d/.test(both)) return true;
  return /\b(price|cost|worth|how much|in stock|back in stock|stock|rate)\b/i.test(userText) && /\d/.test(reply);
}

export interface HandlerDeps {
  llm: LLMClient;
  memoryGet: (chatId: number) => LLMMessage[];
  memorySet: (chatId: number, history: LLMMessage[]) => void;
  // Send text, optionally with a one-tap inline keyboard (inline-tap-buttons). The keyboard param is
  // ignored by a channel that can't render buttons (console). Existing callers pass text only.
  sendMessage: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>;
  // Acknowledge an inline-button tap (inline-tap-buttons) so the client clears its spinner + shows an
  // optional toast. Optional; absent -> a callback tap is still routed, just without the spinner ack.
  answerCallback?: (callbackQueryId: string, toast?: string) => Promise<unknown>;
  // Re-run a saved recipe BY NAME (inline-tap-buttons "Run again" button), chain/slot-aware like the
  // scheduled path. Returns the reply text, or null when the recipe is gone / slotted / degraded.
  // Optional; absent -> a recipe "Run again" tap replies that it couldn't run.
  recipeRunByName?: (chatId: number, name: string) => Promise<string | null>;
  // Send an image (screenshot tool, DEV-0027). Optional: when absent, a photo result is dropped
  // and only the text reply goes out (older wiring stays valid).
  sendPhoto?: (chatId: number, bytes: Uint8Array, caption?: string) => Promise<unknown>;
  // Send a document (pdf tool, DEV-0032). Optional: absent -> a doc result falls back to text.
  sendDocument?: (chatId: number, bytes: Uint8Array, filename?: string, caption?: string) => Promise<unknown>;
  sendTyping: (chatId: number) => Promise<unknown>;
  handleCommand: (text: string) => string | null;
  // Clear this chat's stored history (/reset). Returns true if there was anything to clear.
  memoryClear: (chatId: number) => boolean;
  // Did the last memory persist reach disk? (memory-write-silent-fail) Optional; when wired, the handler
  // warns ONCE per chat after a failed write so a full/unwritable disk silently losing conversation on
  // the next restart isn't invisible. Absent -> no check (previous behavior).
  memorySaveOk?: () => boolean;
  // One-line health reply for /status (uptime + turns + browser reachability). Optional:
  // when absent, /status falls through to the agent (older wiring stays valid).
  statusLine?: () => string;
  // /sites reply (m30): the hosts the cookie jar authorizes the agent for — NAMES only, never
  // values. Optional; absent -> /sites falls through to the agent.
  sitesLine?: () => string;
  // Per-user profile (product-loop). setLocation parses + stores a "set my location" message (null
  // if it isn't one); profileContext returns the agent context line for a chat (""/absent = none).
  // All optional so older wiring/tests are unaffected.
  setLocation?: (chatId: number, text: string) => { location: string; units?: string; tzOffsetMin?: number; restamped?: number; saved?: boolean } | null;
  profileContext?: (chatId: number) => string;
  // The chat's tz offset (minutes east of UTC) for the agent's current-datetime line + reasoning
  // (inject-current-datetime). Optional; absent -> UTC (0).
  chatTzOffsetMin?: (chatId: number) => number | undefined;
  // /profile (product-loop): echo the stored location/units/tz so a typo'd "UTC-5" or wrong city is
  // visible, not silently wrong on every weather/reminder. profileClear forgets it. Both optional.
  profileView?: (chatId: number) => string | null; // human-readable summary, or null if nothing set
  profileClear?: (chatId: number) => { had: boolean; saved: boolean }; // had: a profile existed; saved: the clear persisted (delete-persist-hedge)
  // First-run location capture (first-location-capture): hasLocation tells the handler whether this
  // chat has a saved home location; captureLocation parses a bare "which city?" reply + stores it
  // (returns the saved location, or null if the reply isn't a place). When both are present, the first
  // location-dependent errand ("weather", "near me") with no saved location offers to save the city
  // once, then re-runs the original errand — instead of the agent asking the city every time. Optional.
  hasLocation?: (chatId: number) => boolean;
  captureLocation?: (chatId: number, text: string) => { location: string; tzOffsetMin?: number; saved?: boolean } | null;
  // Shared location pin (telegram-location-pin): save the chat's precise coords so "near me"/directions
  // resolve against them. Optional; absent -> a location pin just gets a generic ack.
  saveCoords?: (chatId: number, lat: number, lng: number) => void;
  // One-tap location share (one-shot-location-button): send a message with a Telegram request_location
  // reply-keyboard button so a cold user's first "near me"/"weather" is one tap, not a typed city. Falls
  // back to a plain sendMessage when absent (e.g. the console channel). Optional.
  requestLocation?: (chatId: number, text: string) => Promise<unknown>;
  // Weather (geo-tool-cluster): the chat's saved coords + unit preference, passed to the agent so
  // get_weather with no place uses their location and renders in their units. Optional.
  weatherCoords?: (chatId: number) => { lat: number; lng: number } | undefined;
  weatherUnits?: (chatId: number) => "metric" | "imperial" | undefined;
  // Answer history (answer-history-recall): recallAnswers searches this chat's PAST answers by keyword
  // ("what was that sushi place you found", "resend the flights") and returns the matches (task + reply
  // + when); logAnswer records a fresh answer. When both are wired, a recall ask is served from the log
  // with no agent run. Optional; absent -> no answer history.
  recallAnswers?: (chatId: number, text: string) => Array<{ task: string; reply: string; at: number }>;
  logAnswer?: (chatId: number, task: string, reply: string) => void;
  // Contacts book (contacts-book-compose): saveContact stores a "mom's number is ..." message (returns
  // the saved contact, or null if it isn't one); resolveContact looks a NAME up to its email/phone so
  // compose can address a draft; forgetContact deletes one; contactList lists them. All optional.
  saveContact?: (chatId: number, text: string) => { name: string; email?: string; phone?: string; saved: boolean } | null;
  resolveContact?: (chatId: number, name: string) => { name: string; email?: string; phone?: string } | null;
  forgetContact?: (chatId: number, text: string) => { name: string; saved?: boolean } | null;
  contactList?: (chatId: number) => Array<{ name: string; email?: string; phone?: string }>;
  // Watch time series (watch-time-series): answer "how has <watch> moved this week" from the alert's
  // recorded points, no agent run. Returns a one-line trend summary, or null when there's no such
  // watch / not enough data. Optional; absent -> a trend ask falls through to the agent.
  watchTrend?: (chatId: number, text: string) => string | null;
  // Chart a watch (chart-it-tool): "chart btc" -> a PNG of the watch's series (sent via sendPhoto), or a
  // text note (not enough data / unknown watch), or null (not a chart ask -> falls through). Async (it
  // fetches the render). Optional; absent -> a chart ask falls through to the agent.
  chartWatch?: (chatId: number, text: string) => Promise<{ png: Uint8Array; caption?: string } | { text: string } | null>;
  // Long-term memory (remember-facts-store): rememberFact parses + stores a "remember X" message
  // (returns the stored fact, or null if it isn't one); forgetFact deletes matching facts (returns a
  // count, or a "cleared all" total); notesList returns the remembered facts for a "what do you know
  // about me" recall. profileContext already carries facts into the agent via the wired contextLine.
  // All optional so older wiring/tests are unaffected.
  rememberFact?: (chatId: number, text: string) => { fact: string; evicted: string[]; saved?: boolean } | null;
  forgetFact?: (chatId: number, text: string) => { removed: number; all: boolean; forgotten: string[]; saved?: boolean } | null;
  notesList?: (chatId: number) => string[];
  // Read-it-later (read-it-later-capture): savePage handles "save this <link>" — scrape+summarize the URL
  // + store it — returning a confirmation (or null if it isn't a save command / had no URL); recallSaved
  // handles "what did I save about X" / "my reading list" from the store, no agent run. Both optional so
  // older wiring/tests are unaffected. savePage is async (it fetches the page to summarize).
  savePage?: (chatId: number, text: string) => Promise<{ title: string; url: string; saved: boolean; dup: boolean } | { error: string } | null>;
  recallSaved?: (chatId: number, text: string) => string | null;
  // Weekly unread nudge opt-in (weekly-unread-proactive-nudge): "nudge me about my reading list" starts a
  // weekly proactive "you saved these but never read them" ping; "stop reading list nudges" cancels it.
  // Returns a confirmation, or null if it isn't a toggle command. Optional.
  unreadNudgeToggle?: (chatId: number, text: string) => string | null;
  // Countdown (countdown-tracker): parse "countdown to X on <date>" / "days until X <date>" and schedule
  // milestone pings (a week out / day before / morning of), returning the immediate day-count. null when
  // it isn't a countdown command; { ok:false, reason:"past" } for an already-passed date. Optional.
  countdownAdd?: (chatId: number, text: string, now: number) =>
    { ok: true; message: string; milestones: number; saved?: boolean } | { ok: false; reason: "past"; message: string } | null;
  // Saved named places (saved-named-places): savePlace parses + stores "my work is <addr>" / "save gym:
  // <addr>" (null if not one); forgetPlace deletes by alias; placeList lists them; isListPlacesRequest
  // is a whole-message "what places do you have". Aliases are injected into the agent via profileContext,
  // so a saved place resolves without re-asking the city. All optional so older wiring is unaffected.
  savePlace?: (chatId: number, text: string) => { name: string; address: string; saved: boolean } | null;
  forgetPlace?: (chatId: number, text: string) => { name: string; saved?: boolean; notFound?: boolean } | null;
  isListPlacesRequest?: (text: string) => boolean;
  placeList?: (chatId: number) => Array<{ name: string; address: string }>;
  // Quick-log tracker (quick-log-tracker): logAdd parses + stores "log weight 182"/"spent $14 on lunch"
  // (null if not a log command); logQuery answers "show my weight this month"/"how much did I spend on
  // food" with a text summary + optional chart PNG (null if not a log query). Both optional.
  logAdd?: (chatId: number, text: string, now: number) =>
    { ok: true; tag: string; value: number; unit?: string; count: number; saved?: boolean } | { ok: false; reason: "capped" } | null;
  logQuery?: (chatId: number, text: string, now: number) => Promise<{ tag: string; text: string; png?: Uint8Array } | null>;
  // Contact follow-up nudge (contact-followup-nudge): "follow up with Sarah in 3 days" -> resolve the
  // saved contact + schedule a reminder that, when it fires, names the person + carries their handle + a
  // one-tap draft link. Returns the confirmation, { ok:false, reason } (unparsed time / cap), or null
  // (not a follow-up command). Optional; reuses schedule + contacts + compose.
  followUpAdd?: (chatId: number, text: string, now: number) =>
    { ok: true; name: string; whenText?: string; hasContact: boolean; saved?: boolean } | { ok: false; reason: "unparsed" | "capped" } | null;
  // Named lists (personal-notes-lists-store): a durable, editable collection the user reads back +
  // checks off ("add eggs to my grocery list", "what's on my list"). Distinct from remembered FACTS
  // (which get injected into every answer) — a list is data the user manages, not context. Returns a
  // rendered reply string (op-specific: added/removed/shown/cleared), or null if the message isn't a
  // list command (so it falls through to the scheduler + agent). Optional so older wiring is unaffected.
  listCommand?: (chatId: number, text: string) => string | null;
  // Export a named list as CSV (csv-export-tabular): "export/download my grocery list [as csv]" -> the
  // list's items so the handler sends a keepable .csv document via sendDocument. Returns null when it's
  // not an export command, or { name, items:[] } for an unknown/empty list (handler says so). Optional.
  listExport?: (chatId: number, text: string) => { name: string; items: string[] } | null;
  // Auto-suggest saving a repeated ask as a recipe (product-loop). When true, a reply to a task that
  // closely matches an earlier one this chat asked gets a one-line "want me to save this?" nudge.
  suggestSaves?: boolean;
  // Shared last-result cache (proactive-ping-drilldown-cache): when provided, the handler stores each
  // answer here AND the schedule-runner writes its proactive sends here, so "more"/"send the link"
  // works after an unprompted digest/alert ping too. Absent -> handler uses a private map (inbound only).
  // A proactive ping used to CLOBBER the answer slot (set sent=text.length), so a scheduled digest
  // firing between an answer and a "more" made "more" say "that's the whole answer" — the dropped tail
  // was unrecoverable (proactive-clobbers-drilldown-cache). Now the answer (full/sent, pageable) and the
  // last proactive ping (ping: pageable + follow-up context) are SEPARATE slots; a ping never touches
  // the answer's paging.
  lastResultStore?: Map<number, { full: string; sent: number; ping?: { full: string; sent: number } }>;
  // Shared pick-list cache (inline-result-picker / picker-on-proactive-pings): the 0-based items of the
  // last numbered/bulleted list sent to a chat, so a "pick N" button tap resends that item. When shared
  // with the schedule-runner, a PROACTIVE list ping is pickable too. Absent -> handler uses a private map.
  pickListStore?: Map<number, ResultItem[]>;
  // Inbound photo (product-loop): when a message carries photoFileId, describeImage answers about it
  // (caption = the question). Optional; absent -> a photo message gets a "can't read images yet" note.
  describeImage?: (fileId: string, caption: string) => Promise<string>;
  // Decode a QR/barcode from a sent photo (read-qr-from-photo): downloads the image + reads its payload
  // via a keyless decoder. Returns the decoded string, or null when there's no readable code. Optional;
  // absent -> a QR-scan caption falls back to the vision describe.
  readQr?: (fileId: string) => Promise<string | null>;
  // Inbound voice note (product-loop): transcribe the audio to text; the handler then runs the
  // transcript as a normal task. Optional; absent -> a voice note gets a "can't do voice" note.
  transcribeVoice?: (fileId: string) => Promise<string>;
  // Inbound document/PDF (product-loop): describe/answer about a forwarded file (caption = question).
  // Optional; absent -> a document gets a "can't read files" note.
  describeDocument?: (fileId: string, caption: string, fileName?: string, mimeType?: string) => Promise<string>;
  // Scheduled/proactive tasks (m4 sched-3). All optional so older wiring stays valid; when
  // absent, a "remind me" message just falls through to the normal agent.
  scheduleAdd?: (chatId: number, text: string, now: number) => { ok: true; kind: string; task: string; whenMs: number; whenText?: string; noTz?: boolean; saved?: boolean; sticky?: boolean } | { ok: false; reason: "unparsed" | "capped" };
  // First-reminder tz (first-reminder-tz-ask): true when this message parses to a CLOCK-TIME schedule
  // AND the chat has no timezone set — so the handler asks "what city are you in?" (city→tz infer)
  // BEFORE scheduling, instead of scheduling wrong-at-UTC then warning. Optional.
  scheduleNeedsTz?: (chatId: number, text: string, now: number) => boolean;
  scheduleList?: (chatId: number) => Array<{ id: string; kind: string; task: string; dueMs: number }>;
  // Unified dashboard (unified-dashboard): one rollup of every automation (schedules/alerts/digests/
  // recipes) with next-fire + last-value + paused status. Returns a ready-to-send string. Optional.
  dashboardView?: (chatId: number) => string;
  scheduleCancel?: (chatId: number, which: string) => { removed: number; saved?: boolean };
  // Snooze (snooze-automations): pause/resume a schedule/alert/digest by name or id instead of the
  // destructive /cancel|/forget. Returns how many were paused/resumed. Optional.
  scheduleSnooze?: (chatId: number, text: string, now: number) => { action: "pause" | "resume"; count: number; which: string; untilText?: string } | null;
  // Sticky reminders (sticky-acknowledged-reminders): a bare "done"/"stop" reply acknowledges + stops any
  // re-pinging sticky reminder. Returns the tasks that were stopped (empty = the chat had none, so the
  // handler treats the message as normal text). Optional; absent -> "done" is a normal message.
  stickyAck?: (chatId: number, text: string) => string[] | null;
  // Saved recipes (m7 recipe-2). All optional so older wiring stays valid. recipeSave parses a
  // "save <name>: <task>" message (null if it isn't one); recipeResolve returns a saved task by
  // name (null if unknown); recipeList/recipeForget manage them.
  recipeSave?: (chatId: number, text: string) => { ok: true; name: string; saved?: boolean } | { ok: false; reason: "unparsed" | "capped" };
  // "save that as <name>" (product-loop): save a name + an explicit task (the prior turn's task,
  // resolved by the handler from memory) without the user retyping it. Optional.
  recipeSaveNamed?: (chatId: number, name: string, task: string) => { ok: true; name: string; saved?: boolean } | { ok: false; reason: "capped" };
  // parses a run command + looks up. { missingArg } = a slotted recipe was run with no value, so the
  // handler asks for it instead of running a broken (empty-slot) task (product-loop).
  recipeResolve?: (chatId: number, text: string) => { name: string; task: string } | { name: string; missingArg: true } | { name: string; ambiguousArgs: true; slots: string[] } | null;
  // Run a chained recipe (task with ">>" steps) sequentially, returning the final output (recipe-chaining).
  // Optional; absent -> a chained task just runs as one agent task (the ">>" is inert).
  // A chained recipe returns the final output plus whether it stopped early (an if-gate failed or a
  // step degraded) so the handler can flag a partial answer instead of passing an intermediate output
  // off as the complete result (chain-progress-partial). A bare-string return is still accepted (legacy).
  runChainRecipe?: (chatId: number, task: string) => Promise<string | { final: string; stoppedEarly?: boolean; stepsDone?: number; stepsTotal?: number }>;
  recipeList?: (chatId: number) => Array<{ name: string; task: string; schedule?: string }>;
  // recipe-auto-recall (product-loop): a free-text message strongly matching a saved recipe -> the
  // matching recipe name (else null), so the handler offers "/run <name>" instead of a cold agent run.
  recipeMatch?: (chatId: number, text: string) => { name: string } | null;
  recipeForget?: (chatId: number, name: string) => boolean;
  // Schedule a saved recipe to run on a cadence (m7 recipe-3): "schedule <name> every morning".
  // Resolves the recipe's task + registers it with the scheduler. Optional.
  recipeSchedule?: (chatId: number, name: string, whenClause: string, now: number) =>
    { ok: true; kind: string } | { ok: false; reason: "unknown" | "unparsed" | "capped" | "needsarg" };
  // Digests (m9 digest-3): bundle recipes into one briefing. All optional.
  digestDefine?: (chatId: number, text: string) => { ok: true; name: string; members: number; saved?: boolean } | { ok: false; reason: "unparsed" | "capped" };
  digestList?: (chatId: number) => Array<{ name: string; members: string[]; schedule?: string }>;
  digestForget?: (chatId: number, name: string) => boolean;
  // Is <name> a digest for this chat? (so /run + schedule dispatch digest vs recipe).
  isDigest?: (chatId: number, name: string) => boolean;
  // Run a digest NOW -> the composed briefing text (sent by the handler). null if unknown.
  digestRun?: (chatId: number, name: string) => Promise<DigestOutcome>;
  digestSchedule?: (chatId: number, name: string, whenClause: string, now: number) =>
    { ok: true; kind: string } | { ok: false; reason: "unknown" | "unparsed" | "capped" };
  // Change-alerts (m10 alert-3): "watch <name>: <task>" defines + auto-schedules a check.
  // All optional. alertDefine parses + stores + schedules (default cadence); returns the cadence.
  alertDefine?: (chatId: number, text: string, now: number) => { ok: true; name: string; feed?: boolean; then?: string; members?: number; pageUrl?: string; weather?: string; saved?: boolean } | { ok: false; reason: "unparsed" | "capped" };
  // Follow-feed subscriptions (follow-feed-subscriptions): "follow r/x / a blog / HN topic / a YT
  // channel" -> a keyless feed watch that pings only on NEW items. null = not a follow command (falls
  // through); { reason: "unresolved" } = a follow we couldn't map to a keyless feed (suggest the agent
  // "watch ... for new items" form). Optional.
  followFeed?: (chatId: number, text: string, now: number) => { ok: true; name: string; label: string; saved?: boolean } | { ok: false; reason: "unresolved" | "capped" } | null;
  // Run one check immediately on define (product-loop): baseline + notify if the predicate already
  // holds, instead of ~24h of silence until the first scheduled cadence check. Returns the notify
  // message or null (silent). Optional; absent -> define just schedules as before.
  alertRunNow?: (chatId: number, name: string) => Promise<{ message: string | null; commit: () => void }>;
  // Conversationally retune an existing alert's trigger (product-loop): "change btc to below 45000".
  // Returns {ok:true,name,summary} on success, or a reason. Optional; absent -> edit falls through.
  alertEdit?: (chatId: number, text: string) =>
    { ok: true; name: string; summary: string; saved?: boolean } | { ok: false; reason: "unparsed" | "unknown" };
  alertList?: (chatId: number) => Array<{ name: string; task: string; lastValue?: string; threshold?: number; feed?: boolean; then?: string; members?: number }>;
  alertForget?: (chatId: number, name: string) => boolean;
  checkRateLimit: (chatId: number) => { allowed: boolean; retryAfterSec?: number };
  redactText: (text: string) => string;
  hasModelKey: () => boolean;
  recordTurn: (t: { steps: number; tools: string[]; elapsedMs: number; ok: boolean; degraded?: boolean }) => void;
  // Count a slash-command invocation (DEV-0108). Optional so existing callers/tests need not pass it;
  // commands still short-circuit before the agent — this only tallies which are used.
  recordCommand?: (name: string) => void;
  // Corrupt-store notice (corrupt-store-silent-wipe): a one-time heads-up naming any stores that failed
  // to load at startup, so a user isn't silently missing reminders/alerts. Null = nothing corrupted.
  // PEEK-only (does NOT drain): the notice is cleared via corruptNoticeAck AFTER a confirmed send, so a
  // failed delivery doesn't permanently swallow the only silent-wipe signal (corrupt-notice-lost-if-send-
  // fails). Sent once before the message is handled. Optional.
  corruptNotice?: () => string | null;
  // Clear the pending corrupt-store notice once it's actually been delivered. Called only after send
  // resolves truthy; a false/failed send leaves it pending so the next inbound re-surfaces it.
  corruptNoticeAck?: () => void;
  now: () => number;
  // Progress ping (product-loop): a multi-step browse can take 30-60s and the bot otherwise goes
  // silent after the one ~5s typing indicator, so a user assumes it hung. If the agent run exceeds
  // progressDelayMs, send ONE interim "still working" line. Optional — absent/0 disables it, so
  // existing wiring + tests are unaffected. setTimer/clearTimer are injectable for offline tests.
  progressDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  // Optional override so tests don't hit the real agent loop.
  runAgentFn?: (userText: string, deps: AgentDeps, history: LLMMessage[]) => Promise<{ reply: string; steps: number; tools: string[]; photo?: Uint8Array; doc?: Uint8Array; docName?: string; degraded?: boolean }>;
  // Background errands (async-background-errands): when true, a large "get back to me" task is ACKed
  // immediately and run DETACHED (off the per-chat chain) with a raised step budget, then delivered
  // unprompted — instead of blocking the reply and truncating at the normal step cap. Absent/false ->
  // every task runs synchronously as before.
  enableBackgroundErrands?: boolean;
  // Background-errand persistence (background-errand-persist): record a dispatched errand so a crash
  // mid-run doesn't silently drop the promise; clear it when the run settles. Both optional; absent ->
  // errands run detached but aren't crash-recoverable (previous behavior).
  bgErrandAdd?: (chatId: number, text: string) => string; // returns an id
  // Mark an errand's result delivered BEFORE the send (bg-errand-double-fire), so a crash in the
  // send→done gap doesn't make startup recovery re-run + re-deliver it. Optional; absent -> the record is
  // only cleared by bgErrandDone (a crash in the gap would double-fire — the previous behavior).
  bgErrandDelivered?: (id: string) => void;
  bgErrandDone?: (id: string) => void;
  log?: (line: string) => void;
}

/** Build the message handler. Returns an async (msg) => void. */
export interface RelayHandler {
  (msg: InboundMessage): Promise<void>;
  // Startup recovery hook (background-errand-persist): re-run an interrupted background errand under its
  // existing id (no new store record, no second ACK).
  resumeErrand: (chatId: number, text: string, errandId: string) => void;
}

export function createHandler(deps: HandlerDeps): RelayHandler {
  const runIt = deps.runAgentFn ?? runAgent;
  const log = deps.log ?? console.log;

  // Per-chat serialization (memory-clobber-lock): the turn does a read-modify-write of memory
  // (memoryGet -> runAgent -> memorySet). dispatchBatch runs up to 4 handlers concurrently, and a
  // single getUpdates batch can carry two messages from the SAME chat — both would read the same
  // base history and the later memorySet would drop the earlier turn. Chain same-chat handles so
  // they run strictly in order (other chats stay fully concurrent). The chain never rejects (each
  // link is caught) so one failure can't wedge the queue.
  const chainByChat = new Map<number, Promise<void>>();
  // Chats we've already shown the one-time "you can make this recurring" tip to (post-answer-recurring-
  // offer). Fires once, on a chat's FIRST clean answer, to teach the proactive loop a new user won't
  // discover otherwise (auto-suggest-save only nudges on a REPEAT). In-memory: at worst re-tips after a
  // restart, which is harmless.
  const tippedChats = new Set<number>();
  // Last recipe-recall message we offered per chat (normalized). Lets a re-send of the same phrase
  // fall through to a fresh answer instead of re-offering forever (recipe-auto-recall escape hatch).
  const recallOffered = new Map<number, string>();
  // First-run location capture (first-location-capture): when a chat's first location errand has no
  // saved city, we ask "which city?" and stash the ORIGINAL errand here; the next message is treated
  // as the city reply, saved, and the errand re-run. Cleared on capture / on a non-city reply (so the
  // user can bail out with any other message).
  const pendingLocation = new Map<number, string>();
  // A reminder the user asked for WITHOUT a time ("remind me to call mom") — we ask "when?" and stash the
  // bare to-do here so the reply ("at 3pm") re-runs it as a full schedule instead of losing the task
  // (reminder-no-time-ask). Keyed by chat; the stored string is the extracted task ("call mom").
  const pendingReminder = new Map<number, string>();
  // In-flight detached background errands per chat (async-background-errands). A detached run lives for
  // minutes off the rate-limited chain, so without a cap a user firing several "get back to me" tasks
  // (the ack invites it) spawns unbounded parallel agent runs that exhaust the browser pool + starve
  // other chats. Bounded per-chat; over the cap the task runs SYNCHRONOUSLY instead (still answered).
  const bgInFlight = new Map<number, number>();
  const MAX_BG_PER_CHAT = 2;
  // Last text answer per chat (full = untrimmed, sent = chars delivered) for "more"/"link" follow-ups
  // (last-result-drilldown). Uses the SHARED store when provided so a proactive digest/alert ping can
  // also be drilled into ("more"/"link" after an unprompted message); else a private in-memory map.
  const lastResult = deps.lastResultStore ?? new Map<number, { full: string; sent: number; ping?: { full: string; sent: number } }>();
  // Last pickable result list per chat (inline-result-picker): when a reply is a numbered/bulleted
  // list, we cache its items so a "pick N" button tap resends that one item (+ its link) without an
  // agent re-run. Uses the SHARED store when provided so a PROACTIVE list ping (a watchlist restock,
  // a feed of new listings) is pickable too — the schedule-runner writes its list items here and a tap
  // resolves against them; else a private in-memory map (inbound-only). Overwritten on the next list.
  const pickLists = deps.pickListStore ?? new Map<number, ResultItem[]>();
  // Chats already warned that a memory write failed (memory-write-silent-fail) — warn ONCE so a
  // persistently unwritable disk doesn't append the notice to every turn. In-memory; re-warns after a
  // restart, which is fine (a restart is exactly when the lost context would surface).
  const memWarnedChats = new Set<number>();
  // Last answer's TASK text per chat (tap-to-watch-on-answers), so a "🔁 Every morning" / "🔔 Watch this"
  // button tap can turn it into a schedule/alert without the user retyping. Overwritten each clean answer.
  const lastTask = new Map<number, string>();
  const handle = ((msg: InboundMessage): Promise<void> => {
    const prev = chainByChat.get(msg.chatId) ?? Promise.resolve();
    const next = prev.then(() => handleOne(msg)).catch((e) => { log(`[handler] uncaught: ${e instanceof Error ? e.message : String(e)}`); });
    // Store the tail; prune when this is the last link so the map doesn't grow unbounded per chat.
    chainByChat.set(msg.chatId, next);
    void next.then(() => { if (chainByChat.get(msg.chatId) === next) chainByChat.delete(msg.chatId); });
    return next;
  }) as RelayHandler;
  // Run a background errand DETACHED with a raised step budget, deliver the result unprompted, then
  // clear its persisted record. Shared by the inbound dispatch (after an ACK) AND startup recovery
  // (background-errand-persist) — recovery passes the EXISTING errandId so no new record is created and
  // no second ACK is sent. Never throws; a failure is reported to the user (no silent black hole).
  function dispatchBackground(chatId: number, originalText: string, errandId: string): void {
    const errand = stripDispatchPhrasing(originalText) || originalText;
    const bgHistory = deps.memoryGet(chatId);
    const startedAt = deps.now();
    bgInFlight.set(chatId, (bgInFlight.get(chatId) ?? 0) + 1);
    // Progress ping (background-errand-progress-ping): a detached errand ACKs "on it" then runs for
    // minutes with no signal — the LONGEST tasks were the only ones with zero mid-run reassurance, so a
    // first-timer assumes it hung. Arm the same one-shot timer the sync + chain paths use; fire once if
    // the errand outlasts progressDelayMs, cleared as soon as it settles. Disabled when the dep is absent.
    const bgSetTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const bgClearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    let bgProgress: unknown = null;
    if (deps.progressDelayMs && deps.progressDelayMs > 0) {
      bgProgress = bgSetTimer(() => {
        void deps.sendMessage(chatId, "Still on it — this one's taking a bit, I'll text you the moment it's done.").catch(() => {});
      }, deps.progressDelayMs);
    }
    const clearBgProgress = () => { if (bgProgress !== null) { bgClearTimer(bgProgress); bgProgress = null; } };
    void (async () => {
      try {
        const r = await runIt(errand, { llm: deps.llm, context: deps.profileContext?.(chatId) || undefined, nowMs: deps.now(), tzOffsetMin: deps.chatTzOffsetMin?.(chatId) ?? 0, weatherCoords: deps.weatherCoords?.(chatId), weatherUnits: deps.weatherUnits?.(chatId), ...(deps.recallAnswers ? { recall: (q: string) => deps.recallAnswers!(chatId, q) } : {}), ...(deps.resolveContact ? { resolveContact: (n: string) => deps.resolveContact!(chatId, n) } : {}), maxSteps: BACKGROUND_MAX_STEPS }, bgHistory);
        clearBgProgress();
        const parts = formatReplyParts(r.reply);
        const out = r.degraded ? `⚠️ Here's what I got (I couldn't fully finish):\n\n${parts.shown}` : `✅ Done with "${errand}":\n\n${parts.shown}`;
        // Deliver like a proactive ping: write the PING sub-slot (preserve any inbound answer's paging).
        const prevLast = lastResult.get(chatId);
        lastResult.set(chatId, { full: prevLast?.full ?? "", sent: prevLast?.sent ?? 0, ping: { full: parts.full, sent: deliveredLen(parts.full, parts.shown) } });
        if (!r.degraded) {
          deps.logAnswer?.(chatId, errand, parts.shown);
          // Append the errand turn to the CURRENT memory, not the dispatch-time snapshot
          // (background-errand-memory-clobber): the errand ran detached for minutes while the user kept
          // texting; those interim turns are already in memory. Re-reading here preserves them instead
          // of overwriting with the stale bgHistory (which would erase the whole interim conversation).
          const nowHistory = deps.memoryGet(chatId);
          deps.memorySet(chatId, [...nowHistory, { role: "user", content: originalText }, { role: "assistant", content: parts.shown }]);
        }
        // Mark delivered BEFORE the send (bg-errand-double-fire): if the process crashes in the tiny gap
        // between sending and bgErrandDone below, the persisted record now carries delivered:true, so
        // startup recovery drops it silently instead of re-running + texting a second answer. (Marking
        // before rather than after means at worst we skip re-delivering a send that failed — far better
        // than double-delivering; a failed send is the rare case, a duplicate ping is the annoying one.)
        deps.bgErrandDelivered?.(errandId);
        await deps.sendMessage(chatId, out);
        deps.recordTurn({ steps: r.steps, tools: r.tools, elapsedMs: deps.now() - startedAt, ok: !r.degraded, degraded: r.degraded });
      } catch (e) {
        clearBgProgress();
        const friendly = friendlyError(e instanceof Error ? e.message : String(e));
        deps.recordTurn({ steps: 0, tools: [], elapsedMs: deps.now() - startedAt, ok: false });
        await deps.sendMessage(chatId, `That background errand ("${errand}") failed: ${friendly}`).catch(() => {});
      } finally {
        bgInFlight.set(chatId, Math.max(0, (bgInFlight.get(chatId) ?? 1) - 1));
        deps.bgErrandDone?.(errandId); // settled (delivered or failed) -> stop tracking (crash before here -> replay)
      }
    })();
  }
  // Startup recovery (background-errand-persist): re-run an interrupted errand under its EXISTING id.
  handle.resumeErrand = (chatId: number, text: string, errandId: string): void => dispatchBackground(chatId, text, errandId);

  // Route an inline-button tap (inline-tap-buttons). Returns a short toast string to flash on the
  // button (or null for none). Decodes callback_data to an action, rate-limits, then does the bounded
  // work: alert Refresh (re-check now, send if it fired), Snooze (pause the watch 1 day), Stop (forget
  // the watch), digest/recipe Run again. A stale/unknown payload (old deploy) toasts a gentle note.
  async function handleCallback(chatId: number, data: string): Promise<string | null> {
    const action = decodeCallback(data);
    if (!action) { await deps.sendMessage(chatId, "That button's no longer valid — it may be from an older message.").catch(() => {}); return "Expired"; }
    const rl = deps.checkRateLimit(chatId);
    if (!rl.allowed) return `Slow down — ${rl.retryAfterSec}s`;
    try {
      if (action.kind === "act") {
        // Tap-to-watch (tap-to-watch-on-answers): turn the chat's last answer into an automation. The
        // task text was cached when the answer was sent; synthesize the command a user would have typed
        // and run it through the SAME handler flow (schedule / alert routing), so no new backend is
        // needed and every existing guard applies. A stale tap (task evicted) gets an honest note.
        const task = lastTask.get(chatId);
        if (!task) { await deps.sendMessage(chatId, "I can't set that up anymore — ask me the thing again and I'll offer the button fresh."); return "Expired"; }
        lastTask.delete(chatId); // one-shot: consume so a double-tap doesn't stack two automations
        const synthetic = action.mode === "daily"
          ? `every morning ${task}`
          : `watch ${watchSlug(task)}: ${task} when it changes`;
        await handleOne({ chatId, from: "tap", text: synthetic, messageId: 0 } as InboundMessage);
        return action.mode === "daily" ? "Every morning" : "Watching";
      }
      if (action.kind === "install") {
        // Tap-to-install a starter automation (starter-automation-gallery): resolve the template + save
        // it as a recipe via the same path /templates <id> uses. A slotted template ({item}) installs
        // fine but needs a value at run time — the confirmation tells them how.
        if (!deps.recipeSaveNamed) { await deps.sendMessage(chatId, "I can't install that right now."); return null; }
        const tpl = getTemplate(action.id);
        if (!tpl) { await deps.sendMessage(chatId, "That automation isn't available anymore."); return "Expired"; }
        const res = deps.recipeSaveNamed(chatId, tpl.recipeName, tpl.task);
        if (!res.ok) { await deps.sendMessage(chatId, "You've hit the recipe limit — /forget one first."); return null; }
        const slotHint = /\{[a-z0-9_]+\}/i.test(tpl.task) ? ` (fill the {value} — e.g. /run ${tpl.recipeName} <value>)` : "";
        await deps.sendMessage(chatId, `✅ Installed "${tpl.recipeName}". Run it with /run ${tpl.recipeName}${slotHint}, or "schedule ${tpl.recipeName} every morning" to get it daily.`);
        return "Installed";
      }
      if (action.kind === "try") {
        // Onboarding tap-to-try (onboarding-tap-to-try): run the canned example as if the user typed it,
        // so the first tap produces a real answer through the normal flow (command/agent routing).
        const ex = TRY_EXAMPLES[action.index];
        if (!ex) { await deps.sendMessage(chatId, "That example isn't available — just text me a task."); return null; }
        await handleOne({ chatId, from: "tap", text: ex.text, messageId: 0 } as InboundMessage);
        return ex.label.replace(/^\S+\s/, ""); // toast without the emoji
      }
      if (action.kind === "pick") {
        // Resend the picked list item (inline-result-picker). The list was cached when the reply was
        // sent; a tap on a stale/replaced list either hits the current list's item N or falls out of
        // range (honest note rather than a wrong item).
        const items = pickLists.get(chatId);
        const item = items?.[action.index];
        if (!item) { await deps.sendMessage(chatId, "That option isn't available anymore — send the request again for a fresh list."); return "Expired"; }
        const url = firstUrl(item.text);
        const body = url && !item.text.trim().endsWith(url) ? `${item.text}\n\n🔗 ${url}` : item.text;
        await deps.sendMessage(chatId, `${action.index + 1}. ${body}`);
        return `Picked ${action.index + 1}`;
      }
      if (action.kind === "alert") {
        if (action.action === "refresh") {
          if (!deps.alertRunNow) { await deps.sendMessage(chatId, `I can't refresh "${action.name}" right now.`); return null; }
          const r = await deps.alertRunNow(chatId, action.name);
          // Gate the baseline commit on delivery (immediate-alert-commit-not-send-gated): if the crossing
          // ping fails to send, DON'T advance the baseline — else the crossing is eaten + the watch looks
          // armed but won't re-fire until it crosses again. Mirrors the scheduler's send-gated commit.
          if (r.message) { const ok = await deps.sendMessage(chatId, r.message, buildAlertKeyboard(action.name)); if (ok !== false) r.commit(); return "Refreshed"; }
          r.commit();
          await deps.sendMessage(chatId, `🔄 "${action.name}": no change since last check.`, buildAlertKeyboard(action.name));
          return "No change";
        }
        if (action.action === "snooze") {
          if (!deps.scheduleSnooze) return null;
          const res = deps.scheduleSnooze(chatId, `snooze ${action.name} 1 day`, deps.now());
          if (res && res.count > 0) { await deps.sendMessage(chatId, `💤 Snoozed "${action.name}" for 1 day${res.untilText ? ` (until ${res.untilText})` : ""}. Say "resume ${action.name}" to turn it back on sooner.`); return "Snoozed 1d"; }
          await deps.sendMessage(chatId, `I couldn't snooze "${action.name}" — it may already be off.`);
          return null;
        }
        // stop
        if (!deps.alertForget) return null;
        const removed = deps.alertForget(chatId, action.name);
        await deps.sendMessage(chatId, removed ? `🔕 Stopped watching "${action.name}".` : `"${action.name}" wasn't an active watch.`);
        return removed ? "Stopped" : null;
      }
      if (action.kind === "digest") {
        if (!deps.digestRun) return null;
        await deps.sendTyping(chatId).catch(() => {});
        const text = digestDisplay(await deps.digestRun(chatId, action.name));
        await deps.sendMessage(chatId, text ?? `I couldn't run the "${action.name}" briefing — it may have been removed.`, text ? buildDigestKeyboard(action.name) : undefined);
        return text ? "Done" : null;
      }
      // recipe run
      if (!deps.recipeRunByName) return null;
      await deps.sendTyping(chatId).catch(() => {});
      const out = await deps.recipeRunByName(chatId, action.name);
      await deps.sendMessage(chatId, out ?? `I couldn't run "${action.name}" — it may have been removed or needs a value.`, out ? buildRecipeKeyboard(action.name) : undefined);
      return out ? "Done" : null;
    } catch (e) {
      await deps.sendMessage(chatId, friendlyError(e instanceof Error ? e.message : String(e))).catch(() => {});
      return null;
    }
  }
  return handle;

  async function handleOne(msg: InboundMessage): Promise<void> {
    // Inline-button tap (inline-tap-buttons): a callback carries an action encoded in callback_data,
    // not free text. Ack the tap (clears the client spinner) + route the action, then return — it
    // never falls through to command/agent handling. Handled FIRST so a tapped button on a proactive
    // ping acts immediately. Bounded work only (no agent run except recipe "Run again", which reuses
    // the same recipeRunByName the scheduler uses). Rate-limited like any turn so button-mashing can't spam.
    if (msg.callback) {
      log(`[in] ${msg.from}: [tap] ${msg.callback.data.slice(0, 40)}`);
      const ackToast = await handleCallback(msg.chatId, msg.callback.data);
      if (deps.answerCallback) await deps.answerCallback(msg.callback.callbackQueryId, ackToast ?? undefined).catch(() => {});
      return;
    }
    log(`[in] ${msg.from}: ${msg.photoFileId ? "[photo] " : ""}${msg.voiceFileId ? "[voice] " : ""}${msg.documentFileId ? "[doc] " : ""}${msg.location ? "[location] " : ""}${deps.redactText(msg.text).slice(0, 120)}`);

    // Corrupt-store notice (corrupt-store-silent-wipe): if any store failed to load at startup, tell the
    // user ONCE (the dep drains its list) before handling their message — so a wiped set of reminders/
    // alerts reads as an honest heads-up, not the bot silently forgetting. Fire-and-continue: the notice
    // precedes normal handling of this same message.
    if (deps.corruptNotice) {
      const notice = deps.corruptNotice(); // peek — does NOT drain
      if (notice) {
        // Gate the one-shot clear on ACTUAL delivery (corrupt-notice-lost-if-send-fails): only ack the
        // notice once the send resolves truthy, so a failed send re-surfaces it on the next inbound
        // instead of permanently losing the only signal that saved data was wiped. sendMessage returns
        // false on a failed chunk (it doesn't throw); a thrown/rejected send also leaves it pending.
        const delivered = await deps.sendMessage(msg.chatId, notice).catch(() => false);
        if (delivered !== false) deps.corruptNoticeAck?.();
      }
    }

    // Shared location pin (telegram-location-pin): a text-less pin used to be dropped silently. Save the
    // coords (so "near me"/directions resolve against them), then either run the caption as an errand
    // now that we have the location, or ack + prompt for what they want. Handled before the empty-text
    // guard so a captionless pin isn't rejected.
    if (msg.location) {
      deps.saveCoords?.(msg.chatId, msg.location.latitude, msg.location.longitude);
      if (msg.text) {
        // Caption present ("coffee near here") — run it as a normal task; the saved coords are now in
        // the agent's profile context.
        msg = { ...msg, location: undefined };
      } else {
        await deps.sendMessage(msg.chatId, "📍 Got your location — I'll use it for \"near me\", weather, and directions. What would you like?");
        return;
      }
    }

    // Inbound photo (product-loop): answer about the image (caption = question, or a default). This is
    // a vision call, not the browser agent — handled before the empty-text guard so a captionless
    // photo isn't rejected. Rate-limited like a normal turn.
    if (msg.photoFileId) {
      const rl = deps.checkRateLimit(msg.chatId);
      if (!rl.allowed) { await deps.sendMessage(msg.chatId, `You're sending a lot — give me ${rl.retryAfterSec}s to catch up.`); return; }
      if (!deps.describeImage) { await deps.sendMessage(msg.chatId, "I can't read images yet — send me a task in words for now."); return; }
      try {
        await deps.sendTyping(msg.chatId);
        const caption = msg.text?.trim() ?? "";
        // Read a QR/barcode from the photo (read-qr-from-photo): a "scan this QR" caption decodes the
        // payload with a keyless reader instead of the vision describe (which can't reliably read it).
        // Checked first — it's the most specific intent. Falls through to describe if there's no code.
        if (caption && photoIsQrScan(caption) && deps.readQr) {
          const payload = await deps.readQr(msg.photoFileId);
          if (payload) {
            const isUrl = /^https?:\/\//i.test(payload.trim());
            const out = isUrl ? `That QR code links to:\n${payload.trim()}` : `That QR code contains:\n${payload.trim()}`;
            // Gate the memory write on delivery (media-memory-not-send-gated): a failed send means the
            // user never saw the QR result, so don't record it as an answered turn (the next message
            // would read as a follow-up to something never delivered). Mirrors the text path.
            if (await deps.sendMessage(msg.chatId, out) !== false) deps.memorySet(msg.chatId, [...deps.memoryGet(msg.chatId), { role: "user", content: `[photo] ${caption}` }, { role: "assistant", content: out }]);
            return;
          }
          await deps.sendMessage(msg.chatId, "I couldn't find a QR code I could read in that image — try a clearer, closer photo of just the code.");
          return;
        }
        // Photo-to-action (photo-to-action): a caption that asks Relay to DO something with the image
        // ("split this receipt 3 ways +20% tip", "convert these prices to USD", "translate this menu")
        // must NOT be answered by the vision model's own guesswork — that's the silent-math error the
        // text path forbids. Instead EXTRACT the image's content with vision, then run the caption through
        // the AGENT so it chains into calculate/convert/translate/etc. A plain "what is this?" (or no
        // caption) still gets the one-shot describe.
        // Use runIt (= deps.runAgentFn ?? runAgent) NOT deps.runAgentFn: index.ts wires describeImage but
        // NOT runAgentFn (it's a test override), so gating on deps.runAgentFn made this branch DEAD in
        // production and every action-caption photo silently fell to the one-shot describe (photo-to-
        // action-dead-in-prod). runIt always resolves to the real agent.
        if (caption && photoNeedsAgent(caption)) {
          // Ask vision to transcribe what's in the image (text, prices, items) — not to solve anything.
          const extracted = (await deps.describeImage(msg.photoFileId,
            "Transcribe EVERYTHING readable in this image verbatim — all text, prices, numbers, item names, labels. List them plainly. Do NOT compute, summarize, or answer any question; just extract the content.")).trim();
          // Tell the agent to ECHO the figures it used (so a vision misread is visible to the user) + flag
          // that they came from a photo — calculate's exactness must not lend false authority to fallible OCR.
          const task = `The user sent a photo and asked: "${caption}".\n\nHere is the exact content extracted from the image:\n${extracted}\n\nAnswer the user's request using this content. Use your tools (calculate, convert_units, convert_currency, translate, etc.) for any math/conversion/translation — do NOT do arithmetic yourself. Briefly list the figures you read from the photo so the user can catch a misread, and note they came from the image.`;
          const res = await runIt(task, { llm: deps.llm, context: deps.profileContext?.(msg.chatId) || undefined, nowMs: deps.now(), tzOffsetMin: deps.chatTzOffsetMin?.(msg.chatId) ?? 0, weatherCoords: deps.weatherCoords?.(msg.chatId), weatherUnits: deps.weatherUnits?.(msg.chatId), ...(deps.recallAnswers ? { recall: (q: string) => deps.recallAnswers!(msg.chatId, q) } : {}), ...(deps.resolveContact ? { resolveContact: (n: string) => deps.resolveContact!(msg.chatId, n) } : {}) }, deps.memoryGet(msg.chatId));
          // Keep the untrimmed reply for "more" drilldown (media paths previously trimmed with no recovery).
          const parts = formatReplyParts(res.reply);
          const okSend = await deps.sendMessage(msg.chatId, parts.shown);
          if (parts.full.length > parts.shown.length) lastResult.set(msg.chatId, { full: parts.full, sent: deliveredLen(parts.full, parts.shown) });
          if (res.photo && deps.sendPhoto) await deps.sendPhoto(msg.chatId, res.photo);
          deps.recordTurn({ steps: res.steps, tools: res.tools, elapsedMs: 0, ok: !res.degraded, ...(res.degraded ? { degraded: true } : {}) });
          // Gate the memory write on delivery (media-memory-not-send-gated): don't record an undelivered answer.
          if (okSend !== false) deps.memorySet(msg.chatId, [...deps.memoryGet(msg.chatId), { role: "user", content: `[photo] ${caption}` }, { role: "assistant", content: parts.shown }]);
          return;
        }
        const answer = await deps.describeImage(msg.photoFileId, caption);
        // Keep the untrimmed describe for "more" too (photo/doc answers were trimmed with no recovery).
        const parts = formatReplyParts(answer);
        const out = parts.shown;
        const okSend = await deps.sendMessage(msg.chatId, out);
        if (parts.full.length > parts.shown.length) lastResult.set(msg.chatId, { full: parts.full, sent: deliveredLen(parts.full, parts.shown) });
        // Persist the turn so a follow-up ("what about the second item?", "is that safe to eat?") has
        // context — the text + error paths already do this; these media success paths silently didn't,
        // so the bot appeared to instantly forget the image it just described. Gated on delivery
        // (media-memory-not-send-gated): a failed send must not record an unseen answer.
        const q = caption ? caption : "[sent a photo]";
        if (okSend !== false) deps.memorySet(msg.chatId, [...deps.memoryGet(msg.chatId), { role: "user", content: `[photo] ${q}` }, { role: "assistant", content: out }]);
      } catch (e) {
        await deps.sendMessage(msg.chatId, friendlyError(e instanceof Error ? e.message : String(e)));
      }
      return;
    }

    // Inbound document/PDF (product-loop): answer about the forwarded file (caption = question). Same
    // shape as the photo branch — a vision call, before the empty-text guard, rate-limited.
    if (msg.documentFileId) {
      const rl = deps.checkRateLimit(msg.chatId);
      if (!rl.allowed) { await deps.sendMessage(msg.chatId, `You're sending a lot — give me ${rl.retryAfterSec}s to catch up.`); return; }
      if (!deps.describeDocument) { await deps.sendMessage(msg.chatId, "I can't read files yet — send me a task in words for now."); return; }
      try {
        await deps.sendTyping(msg.chatId);
        const answer = await deps.describeDocument(msg.documentFileId, msg.text, msg.documentName, msg.documentMime);
        // Keep the untrimmed answer for "more" (a long doc summary was trimmed with no tail recovery).
        const parts = formatReplyParts(answer);
        const out = parts.shown;
        const okSend = await deps.sendMessage(msg.chatId, out);
        if (parts.full.length > parts.shown.length) lastResult.set(msg.chatId, { full: parts.full, sent: deliveredLen(parts.full, parts.shown) });
        // Persist the turn so a follow-up about the document has context (see the photo branch). Gated on
        // delivery (media-memory-not-send-gated): don't record an answer the user never received.
        const q = msg.text?.trim() ? msg.text.trim() : "[sent a document]";
        if (okSend !== false) deps.memorySet(msg.chatId, [...deps.memoryGet(msg.chatId), { role: "user", content: `[document] ${q}` }, { role: "assistant", content: out }]);
      } catch (e) {
        await deps.sendMessage(msg.chatId, friendlyError(e instanceof Error ? e.message : String(e)));
      }
      return;
    }

    // Inbound voice note (product-loop): transcribe to text, then treat it exactly like a typed task
    // (falls through to command routing + the agent below). Before the empty-text guard since a voice
    // message has no text of its own.
    if (msg.voiceFileId) {
      if (!deps.transcribeVoice) { await deps.sendMessage(msg.chatId, "I can't do voice yet — text me the task for now."); return; }
      let transcript = "";
      try {
        await deps.sendTyping(msg.chatId);
        transcript = (await deps.transcribeVoice(msg.voiceFileId)).trim();
      } catch (e) {
        await deps.sendMessage(msg.chatId, friendlyError(e instanceof Error ? e.message : String(e)));
        return;
      }
      if (!transcript) { await deps.sendMessage(msg.chatId, "I couldn't make out that voice note — try again or text me."); return; }
      // Echo what we heard (so a mis-transcription is visible), then run it as a normal message.
      await deps.sendMessage(msg.chatId, `🎤 "${transcript}"`);
      msg = { ...msg, text: transcript };
    }

    // DEV-0124: a sticker / blank inbound arrives with empty text. It matches no command and would
    // otherwise burn an LLM call on an empty prompt (and reply confusingly). Nudge + return before
    // rate-limit/agent.
    if (!msg.text.trim()) {
      await deps.sendMessage(msg.chatId, "Send me a task in words — e.g. \"top HN story\" or \"weather in Paris\".");
      return;
    }

    // First-run location capture (first-location-capture): if we just asked this chat "which city?",
    // treat THIS message as the answer — save it and re-run the errand we stashed. A reply that isn't a
    // place (a slash command, a fresh task, "never mind") returns null from captureLocation: we drop the
    // pending state and let the message route normally, so the user is never trapped.
    // Reminder-with-no-time resume (reminder-no-time-ask): we asked "when?" for a timeless reminder and
    // stashed the task. THIS message is the time — combine "remind me to <task> <time>" and re-run it
    // through the normal schedule path. A reply that clearly isn't a time (a fresh command / task /
    // "never mind") drops the pending state and routes normally, so the user is never trapped.
    if (deps.scheduleAdd && pendingReminder.has(msg.chatId)) {
      const task = pendingReminder.get(msg.chatId)!;
      pendingReminder.delete(msg.chatId);
      const reply = msg.text.trim();
      // A time-ish reply: "at 3pm", "in 2 hours", "tomorrow at 9", "tonight", "3pm", a bare "9:30".
      const looksLikeTime = /\b(at\s+\d|in\s+\d|in\s+(an?|a\s+few|a\s+couple|half)|tomorrow|tonight|today|this\s+(morning|afternoon|evening)|every|\d{1,2}\s*(am|pm)|\d{1,2}:\d{2})\b/i.test(reply)
        || /^\s*\d{1,2}\s*(am|pm)?\s*$/i.test(reply);
      if (looksLikeTime) {
        const combined = `remind me to ${task} ${reply}`;
        const r = deps.scheduleAdd(msg.chatId, combined, deps.now());
        if (r.ok) {
          const when = r.whenText ? ` Next: ${r.whenText}.` : "";
          const tzWarn = r.noTz ? ` ⚠️ No timezone set, so this is UTC — set yours with "/setlocation <city> UTC-5".` : "";
          if (r.saved === false) { await deps.sendMessage(msg.chatId, `Set it up for now, but I couldn't save it to disk — it may be lost if I restart. Try again in a moment.`); return; }
          await deps.sendMessage(msg.chatId, `Got it — I'll remind you: "${r.task}".${when}${tzWarn}`);
          return;
        }
        // Still couldn't parse a time out of the reply — ask once more, re-stashing the task.
        pendingReminder.set(msg.chatId, task);
        await deps.sendMessage(msg.chatId, `I didn't catch a time in that. Try "at 3pm", "in 2 hours", or "tomorrow at 9am" (or say "never mind").`);
        return;
      }
      // Not a time — abandon the pending reminder and let this message route normally.
    }

    if (deps.captureLocation && pendingLocation.has(msg.chatId)) {
      const errand = pendingLocation.get(msg.chatId)!;
      const saved = deps.captureLocation(msg.chatId, msg.text);
      pendingLocation.delete(msg.chatId);
      if (saved) {
        // saved===false: the profile write failed — say so (still re-run the errand this session, but
        // don't imply it's persisted, since the tz/location reverts to UTC on restart).
        const note = saved.saved === false ? " (heads up: I couldn't save it to disk, so I may ask again after a restart)" : " (Change it anytime with /setlocation.)";
        await deps.sendMessage(msg.chatId, `Thanks — saved ${saved.location}.${note}`);
        // Re-run the original errand now that we have the location (in memory this session regardless).
        msg = { ...msg, text: errand };
      }
      // else: not a city — fall through and route THIS message normally (no re-run).
    }

    // /reset (alias /clear): wipe THIS chat's memory. Needs chatId, so it's handled here rather
    // than in the pure handleCommand. Short-circuits before rate-limit/agent, like other commands.
    let first = msg.text.trim().toLowerCase().split(/\s+/)[0]?.split("@")[0];
    // DEV-0108: tally slash-command usage (a separate metrics axis; commands still short-circuit
    // before the agent below). Any leading /token counts — /help, /start, /reset, /forget-digest, etc.
    if (first && first.startsWith("/")) deps.recordCommand?.(first);
    // Command-intent recovery: a "/"-prefixed message that ISN'T a known command would otherwise be
    // excluded by the schedule matcher's "/"-guard + fall to a cold agent run — so "/remind me at 7am"
    // silently never schedules. If it's a bare mistyped command (one /token, no args) suggest the
    // nearest real one; otherwise strip the stray slash so the rest routes normally ("/remind me ..."
    // -> "remind me ..." reaches the schedule matcher; "/weather Paris" -> the agent as plain text).
    const KNOWN_COMMANDS = new Set(["/start", "/help", "/menu", "/commands", "/reset", "/clear", "/status", "/sites", "/profile", "/setlocation", "/dashboard", "/dash", "/schedules", "/cancel", "/recipes", "/templates", "/run", "/forget", "/forget-recipe", "/forget-alert", "/digests", "/forget-digest", "/alerts", "/contacts"]);
    if (first && first.startsWith("/") && !KNOWN_COMMANDS.has(first)) {
      const afterCmd = msg.text.trim().slice(first.length).trim(); // args after the /token
      if (!afterCmd) {
        // Bare unknown command -> suggest the closest known one (prefix match), else point to /help.
        const bare = first.slice(1);
        const near = [...KNOWN_COMMANDS].find((c) => c.slice(1).startsWith(bare) || bare.startsWith(c.slice(1)));
        await deps.sendMessage(msg.chatId, near ? `Did you mean ${near}? Send /help for the full list.` : "Not a command — send /help for what I can do.");
        return;
      }
      // Has args -> drop just the leading "/" + re-route the whole message as normal text
      // ("/remind me to X" -> "remind me to X" reaches the schedule matcher).
      const stripped = msg.text.trim().replace(/^\//, "");
      msg = { ...msg, text: stripped };
      first = stripped.toLowerCase().split(/\s+/)[0]?.split("@")[0]; // recompute so downstream routing sees the stripped text
    }
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

    // /sites: which hosts the cookie jar authorizes the agent for (names only). No agent run.
    if (first === "/sites" && deps.sitesLine) {
      await deps.sendMessage(msg.chatId, deps.sitesLine());
      return;
    }

    // /profile: show or clear the stored location/units/tz so a wrong value is visible + fixable.
    //   "/profile"        -> echo what's stored (or a hint to set it)
    //   "/profile clear"  -> forget it
    if (first === "/profile" && (deps.profileView || deps.profileClear)) {
      const rest = msg.text.trim().split(/\s+/).slice(1).join(" ").toLowerCase();
      if (/^(clear|reset|forget)$/.test(rest) && deps.profileClear) {
        const { had, saved } = deps.profileClear(msg.chatId);
        // A failed persist means the location/tz comes back on restart (and keeps skewing weather/reminders)
        // — hedge so the user retries (delete-persist-hedge).
        const hedge = had && !saved ? ` ⚠️ But I couldn't save that to disk — it may come back if I restart; try again in a moment.` : "";
        await deps.sendMessage(msg.chatId, had ? `Cleared your saved location/units/timezone.${hedge}` : "Nothing saved to clear.");
        return;
      }
      const view = deps.profileView?.(msg.chatId) ?? null;
      await deps.sendMessage(msg.chatId, view
        ? `Your profile:\n${view}\n\nChange it with /setlocation, or "/profile clear" to forget it.`
        : `No profile saved yet. Set one with "/setlocation Austin, TX" (add "UTC-5" for reminder timing, "(metric)" for units).`);
      return;
    }

    // "set my location" / "/setlocation X" / "i'm in X" -> store home location (+ optional units) so
    // "weather" / "near me" resolve without asking. Detected before the agent so it isn't run as a task.
    if (deps.setLocation) {
      const set = deps.setLocation(msg.chatId, msg.text);
      if (set) {
        const u = set.units ? ` (${set.units})` : "";
        // Confirm the tz too when the user gave one, so they know daily reminders now fire in their zone.
        const tz = typeof set.tzOffsetMin === "number"
          ? ` I'll fire daily reminders at your local time (${formatUtcOffset(set.tzOffsetMin)}).`
          : "";
        // If existing recurring reminders were re-stamped to the new tz, say so — otherwise a user who
        // set their tz to FIX a wrong-hour daily wouldn't know it's now corrected (tz-restamp-on-setlocation).
        const fixed = set.restamped && set.restamped > 0
          ? ` Fixed the timing of ${set.restamped} existing recurring reminder${set.restamped === 1 ? "" : "s"}.`
          : "";
        // saved===false: the profile write failed — DON'T confirm it's stored, or every weather/near-me
        // + daily-reminder time silently reverts to UTC on restart (profile-save-silent-failure).
        if (set.saved === false) {
          await deps.sendMessage(msg.chatId, `I've got ${set.location} for now, but couldn't save it to disk — it may be lost if I restart. Please set it again in a moment.`);
          return;
        }
        await deps.sendMessage(msg.chatId, `Got it — I'll use ${set.location}${u} for "weather", "near me", and the like.${tz}${fixed}`);
        return;
      }
    }

    // First-run location capture (first-location-capture): a location-dependent errand ("weather",
    // "near me") with NO saved city — ask once for the city + stash this errand, instead of letting the
    // agent ask every time (and leaving tz unset, which mis-times reminders). Next message is the reply,
    // handled above. Only when the deps are wired + nothing else already owns this message shape.
    if (deps.hasLocation && deps.captureLocation && !deps.hasLocation(msg.chatId)
        && !pendingLocation.has(msg.chatId) && needsLocationContext(msg.text)) {
      pendingLocation.set(msg.chatId, msg.text);
      const ask = "What city are you in? Tap the button to share your location, or type a city (add \"UTC-5\" and I'll get your reminder times right too). I'll save it so I don't have to ask again.";
      if (deps.requestLocation) await deps.requestLocation(msg.chatId, ask); else await deps.sendMessage(msg.chatId, ask);
      return;
    }

    // Chart a watch (chart-it-tool): "chart btc" / "graph my btc watch" -> a PNG of the watch's series.
    // Before watchTrend since it requires an explicit chart/graph/plot word (a bare "btc trend" is still
    // the text trend). Null -> not a chart ask, fall through. Needs sendPhoto for the image; a text note
    // (not enough data / unknown watch) goes out either way.
    if (deps.chartWatch) {
      const r = await deps.chartWatch(msg.chatId, msg.text);
      if (r) {
        if ("png" in r && deps.sendPhoto) { await deps.sendPhoto(msg.chatId, r.png, r.caption); return; }
        if ("png" in r) { await deps.sendMessage(msg.chatId, `${r.caption ?? "Here's your chart"} — but I can't send images on this channel.`); return; }
        await deps.sendMessage(msg.chatId, r.text); return;
      }
    }

    // Watch time series (watch-time-series): "how has btc moved this week" / "btc trend" — answer from
    // the watch's recorded points, no agent run. Falls through when there's no such watch / not enough
    // data (watchTrend returns null) so a genuine fresh question still runs.
    if (deps.watchTrend) {
      const trend = deps.watchTrend(msg.chatId, msg.text);
      if (trend) { await deps.sendMessage(msg.chatId, trend); return; }
    }

    // Answer history (answer-history-recall): "what was that sushi place you found?" / "resend the
    // flights" — search PAST answers Relay gave (not facts the user stored) + reply from the log, no
    // agent re-run. Checked before the notes-recall (distinct: "you found" vs "know about me") and the
    // agent. Falls through when nothing matches so a genuine fresh task still runs.
    if (deps.recallAnswers && isAnswerRecall(msg.text)) {
      const hits = deps.recallAnswers(msg.chatId, msg.text);
      if (hits.length) {
        const nowMs = deps.now();
        const body = hits.map((h) => {
          // Show HOW OLD the answer is so the user knows a recalled price/story may be stale (a recall
          // replays a past answer verbatim — without an age it reads as current).
          const age = relativeAge(nowMs - h.at);
          return `• You asked "${h.task}"${age ? ` (${age})` : ""} — I said:\n${h.reply}`;
        }).join("\n\n");
        const stale = hits.some((h) => nowMs - h.at > 6 * 3_600_000); // >6h old: nudge a refresh
        await deps.sendMessage(msg.chatId, body + (stale ? "\n\n(That's from earlier — ask me to check again for the latest.)" : ""));
        return;
      }
      await deps.sendMessage(msg.chatId, "I don't have a past answer matching that. Ask me fresh and I'll look it up.");
      return;
    }

    // Read-it-later (read-it-later-capture). Recall FIRST ("what did I save about X" / "my reading list")
    // so it's served from the store with no agent run; then capture ("save this <link>") which scrapes +
    // summarizes the page. Both are whole-message shapes that would otherwise hit the agent. Recall before
    // capture so "what did I save" isn't mistaken for a save. Checked before the memory/scheduler/agent.
    if (deps.unreadNudgeToggle) {
      const out = deps.unreadNudgeToggle(msg.chatId, msg.text);
      if (out) { await deps.sendMessage(msg.chatId, out); return; }
    }
    if (deps.recallSaved) {
      const out = deps.recallSaved(msg.chatId, msg.text);
      if (out) { await deps.sendMessage(msg.chatId, out); return; }
    }
    if (deps.savePage) {
      const r = await deps.savePage(msg.chatId, msg.text);
      if (r) {
        if ("error" in r) { await deps.sendMessage(msg.chatId, r.error); return; }
        const hedge = r.saved === false ? "\n\n⚠️ But I couldn't save it to disk — it may not survive a restart; try again." : "";
        await deps.sendMessage(msg.chatId, `${r.dup ? "Updated" : "Saved"} "${r.title}" to your reading list. Ask "what did I save about …" or "my reading list" anytime.${hedge}`);
        return;
      }
    }

    // Long-term memory (remember-facts-store). "what do you know about me" -> recite the stored facts;
    // "forget that X" / "forget everything you know" -> delete; "remember X" -> store a durable fact.
    // All detected before the scheduler + agent so a fact isn't run as a web task. "remember TO X" and
    // a "remember X at 5pm" fall through (parseRemember returns null) to the reminder/scheduler path.
    // Saved named places (saved-named-places): "my work is <addr>" / "save gym: <addr>" / "forget my work
    // address" / "what places do you have". Detected BEFORE rememberFact (a "remember my office is ..."
    // would otherwise be stored as a raw fact) + before the scheduler/agent. Aliases resolve in later
    // location errands via the injected profileContext.
    if (deps.isListPlacesRequest && deps.placeList && deps.isListPlacesRequest(msg.text)) {
      const list = deps.placeList(msg.chatId);
      await deps.sendMessage(msg.chatId, list.length
        ? `Your saved places:\n${list.map((p) => `• ${p.name} — ${p.address}`).join("\n")}\n\nForget one with "forget my <name> place".`
        : "No saved places yet. Save one with \"my work is 500 5th Ave\" or \"save gym: Gold's on Main\", then ask \"weather at the gym\" / \"coffee near work\".");
      return;
    }
    if (deps.forgetPlace) {
      const r = deps.forgetPlace(msg.chatId, msg.text);
      if (r) {
        const hedge = r.saved === false ? `\n\n⚠️ But I couldn't save that change to disk — it may come back if I restart.` : "";
        await deps.sendMessage(msg.chatId, r.notFound
          ? `I don't have a place called "${r.name}" saved.`
          : `Forgot your "${r.name}" place.${hedge}`);
        return;
      }
    }
    if (deps.savePlace) {
      const r = deps.savePlace(msg.chatId, msg.text);
      if (r) {
        if (r.saved === false) {
          await deps.sendMessage(msg.chatId, `I've got "${r.name}" as ${r.address} for now, but couldn't save it to disk — it may be lost if I restart. Try again in a moment.`);
          return;
        }
        await deps.sendMessage(msg.chatId, `Saved — "${r.name}" is ${r.address}. Now you can say "weather at ${r.name}", "coffee near ${r.name}", or "directions to ${r.name}".`);
        return;
      }
    }
    if (deps.notesList && isRecallRequest(msg.text)) {
      const facts = deps.notesList(msg.chatId);
      await deps.sendMessage(msg.chatId, facts.length
        ? `Here's what I remember:\n${facts.map((f) => `• ${f}`).join("\n")}\n\nForget one with "forget that <fact>", or all with "forget everything you know".`
        : "I don't have anything saved about you yet. Tell me with \"remember ...\" (e.g. \"remember I'm vegetarian\").");
      return;
    }
    if (deps.forgetFact) {
      const r = deps.forgetFact(msg.chatId, msg.text);
      if (r) {
        // Name exactly what was deleted so a mismatched forget is visible + correctable (a whole-word
        // match can still catch more than intended — showing it beats silent collateral loss).
        const named = r.forgotten.length ? `:\n${r.forgotten.map((f) => `• ${f}`).join("\n")}` : ".";
        // A failed disk write on a forget means the fact comes back on restart — and a resurrected privacy
        // request keeps getting injected into answers. Hedge so the user knows to retry (delete-persist-hedge).
        const hedge = r.saved === false ? `\n\n⚠️ But I couldn't save that change to disk — it may come back if I restart. Please try again in a moment.` : "";
        await deps.sendMessage(msg.chatId, r.all
          ? (r.removed ? `Done — cleared all ${r.removed} thing${r.removed === 1 ? "" : "s"} I remembered about you.${hedge}` : "I didn't have anything saved to forget.")
          : (r.removed ? `Forgot ${r.removed} thing${r.removed === 1 ? "" : "s"}${named}${hedge}` : "I couldn't find anything matching that to forget — try \"what do you know about me\"."));
        return;
      }
    }
    if (deps.rememberFact) {
      const r = deps.rememberFact(msg.chatId, msg.text);
      if (r) {
        // Warn when the memory was full and the oldest fact aged out, naming it — a silent drop of the
        // earliest thing they told me reads as "you forgot" (notes-cap-silent-evict).
        const dropped = r.evicted.length
          ? ` (I was at my memory limit, so I let go of: ${r.evicted.map((e) => `"${e}"`).join(", ")} — tell me again if that still matters.)`
          : "";
        // saved===false: the disk write failed — don't claim it's remembered when it isn't
        // (lists-remove-atomic-write-failure). Held in memory this session, gone on restart.
        if (r.saved === false) {
          await deps.sendMessage(msg.chatId, `I've got "${r.fact}" for now, but I couldn't save it to disk — it may be lost if I restart. Please tell me again in a bit.`);
          return;
        }
        await deps.sendMessage(msg.chatId, `Got it — I'll remember that ${r.fact}.${dropped}`);
        return;
      }
    }

    // Named lists (personal-notes-lists-store). "add eggs to my grocery list" / "what's on my list" /
    // "remove milk from my list" / "clear my list" — a durable collection the user manages. Detected
    // before the scheduler + agent so a list op isn't run as a web task. Returns null (falls through)
    // when the message isn't a list command, so "add a comment to the PR" still reaches the agent.
    // Export a list as a keepable CSV (csv-export-tabular): "export/download my grocery list as csv".
    // Before listCommand so "export my list" isn't read as a show. Sends a .csv document (falls back to
    // text if the channel has no sendDocument); an unknown/empty list gets an honest note.
    if (deps.listExport) {
      const ex = deps.listExport(msg.chatId, msg.text);
      if (ex) {
        if (!ex.items.length) { await deps.sendMessage(msg.chatId, `Your ${ex.name} list is empty (or I don't have one by that name) — nothing to export.`); return; }
        const csv = rowsToCsv(ex.items.map((item) => ({ item })));
        if (csv && deps.sendDocument) {
          await deps.sendDocument(msg.chatId, new TextEncoder().encode(csv), `${ex.name.replace(/[^\w-]+/g, "_")}.csv`, `Your ${ex.name} list (${ex.items.length} item${ex.items.length === 1 ? "" : "s"})`);
        } else {
          // No document channel (console) — fall back to the readable list text.
          await deps.sendMessage(msg.chatId, `Your ${ex.name} list:\n${ex.items.map((i) => `• ${i}`).join("\n")}`);
        }
        return;
      }
    }
    if (deps.listCommand) {
      const r = deps.listCommand(msg.chatId, msg.text);
      if (r) { await deps.sendMessage(msg.chatId, r); return; }
    }

    // Contacts book (contacts-book-compose). "/contacts" lists them; "forget mom's contact" deletes;
    // "save mom's number is 555-1234" / "boss's email is b@co.com" stores a name->handle so a later
    // "text mom ..." drafts to the saved recipient. Detected before the scheduler + agent. Save is
    // checked LAST (its cue is broad) and only fires when parseSaveContact finds a real phone/email.
    if (first === "/contacts" && deps.contactList) {
      const list = deps.contactList(msg.chatId);
      if (!list.length) { await deps.sendMessage(msg.chatId, "No saved contacts. Save one: \"save mom's number is 555-123-4567\" or \"my boss's email is boss@co.com\", then \"text mom ...\"."); return; }
      const lines = list.map((c) => `• ${c.name}${c.email ? ` — ${c.email}` : ""}${c.phone ? ` — ${c.phone}` : ""}`);
      await deps.sendMessage(msg.chatId, `Your contacts:\n${lines.join("\n")}\n\nForget one with "forget <name>'s contact".`);
      return;
    }
    if (deps.forgetContact) {
      const r = deps.forgetContact(msg.chatId, msg.text);
      if (r) {
        const hedge = r.saved === false ? ` ⚠️ But I couldn't save that to disk — it may come back if I restart; try again in a moment.` : "";
        await deps.sendMessage(msg.chatId, `Forgot ${r.name}'s contact.${hedge}`); return;
      }
    }
    if (deps.saveContact) {
      const r = deps.saveContact(msg.chatId, msg.text);
      if (r) {
        const handle = [r.email, r.phone].filter(Boolean).join(", ");
        if (r.saved === false) { await deps.sendMessage(msg.chatId, `I've got ${r.name} (${handle}) for now, but couldn't save it to disk — it may be lost if I restart. Try again shortly.`); return; }
        await deps.sendMessage(msg.chatId, `Saved ${r.name} (${handle}). Now you can say "text ${r.name} ..." or "email ${r.name} ..." and I'll draft it to them.`);
        return;
      }
    }

    // /dashboard: one rollup of every automation (schedules/alerts/digests/recipes). Pure read, no agent.
    if ((first === "/dashboard" || first === "/dash") && deps.dashboardView) {
      await deps.sendMessage(msg.chatId, deps.dashboardView(msg.chatId));
      return;
    }

    // /schedules: list this chat's pending scheduled tasks. No agent run.
    if (first === "/schedules" && deps.scheduleList) {
      const list = deps.scheduleList(msg.chatId);
      if (!list.length) { await deps.sendMessage(msg.chatId, "No scheduled tasks. Try: \"remind me to stretch in 20 min\"."); return; }
      const lines = list.map((s, i) => `${i + 1}. [${s.id}] ${s.kind} — ${s.task}`);
      await deps.sendMessage(msg.chatId, `Your scheduled tasks:\n${lines.join("\n")}\n\nCancel one with /cancel <id> (or /cancel all).`);
      return;
    }

    // /cancel <id|all>: remove scheduled task(s). No agent run.
    if (first === "/cancel" && deps.scheduleCancel) {
      const which = msg.text.trim().split(/\s+/).slice(1).join(" ").trim() || "all";
      const { removed, saved } = deps.scheduleCancel(msg.chatId, which);
      // A failed persist means the cancelled reminder re-fires after a restart — hedge (delete-persist-hedge).
      const hedge = removed > 0 && saved === false ? ` ⚠️ But I couldn't save that to disk — it may re-fire if I restart; try again in a moment.` : "";
      await deps.sendMessage(msg.chatId, removed > 0 ? `Cancelled ${removed} task${removed === 1 ? "" : "s"}.${hedge}` : "Nothing matched — check /schedules for the id.");
      return;
    }

    // Natural scheduling: "remind me to X in 10m", "every morning tell me Y". Detected before
    // the agent so a schedule request is stored, not executed now. Falls through if unparsed.
    // GUARD (DEV-0175): do NOT let this NL matcher intercept an EXPLICIT command that owns a later
    // branch — a slash-command, or a `run`/`schedule` verb — whose recipe/digest NAME merely contains
    // a schedule word (e.g. `/run daily-report`, `run morning-brief`). Those must reach their own
    // dispatch; only genuine free-text like "remind me ... every day" should schedule here.
    // Also exclude the DEFINE/EDIT verbs whose own branches run LATER (watch/alert/save/define
    // digest/change...): "watch daily: btc" or "save every-morning: X" contains a cadence word, so
    // this NL matcher would hijack it and the alert/recipe/digest would never be created (DEV: an
    // audit found this deterministic break). Those command-shaped messages must reach their branch.
    // Match the actual command SHAPES the later branches own — a define ("watch/alert me/save/
    // [define] digest <name>: <task>", note the colon) or an alert edit ("change/set/make <name>
    // <below|above|in stock|by ...>"). Matching the shape (not just the leading verb) means a plain
    // reminder like "set a reminder every day" is NOT excluded, but "watch daily: btc" is.
    const t0 = msg.text.trim();
    const isDefineShape = /^\s*(?:watch|alert(?:\s+me)?|save(?:\s+recipe)?|(?:define\s+)?digest)\s+[^:]+:\s*\S/i.test(t0);
    // Require a NUMBER after the operator (matching parseAlertEdit's real grammar) or "in stock" — else
    // a plain reminder like "set a reminder to hand over the keys tomorrow at 9am" tripped on the bare
    // word "over"/"by" and got excluded from the scheduler + silently ran once (audit 19 B#1).
    const isAlertEditShape = /^\s*(?:change|update|edit|set|make)\s+.+\s(?:(?:below|under|above|over|hits?|reaches?|by)\s+\$?\d|in\s+stock\b)/i.test(t0);
    // "save that/this/it/the last one as <name>" owns a later branch too; its <name> can be a cadence
    // word ("save that as daily") which the NL matcher would otherwise turn into a junk daily schedule
    // running the literal "save that as" every morning + never create the recipe (audit-found).
    const isSaveThatShape = parseSaveThatAs(t0) !== null;
    // Also exclude the by-reference forms ("watch/schedule/do/send that ...") — their branch runs
    // LATER, and "do/send that every morning" contains a cadence word the NL scheduler would grab,
    // scheduling the literal "do that" every day (audit 20 B#1).
    const isByRefShape = parseWatchThat(t0) !== null || parseScheduleThat(t0) !== null;
    const isExplicitCommand = first?.startsWith("/") || /^(?:run|schedule)\b/i.test(t0) || isDefineShape || isAlertEditShape || isSaveThatShape || isByRefShape;
    // Cue set MUST cover every shape parseSchedule accepts, or a valid schedule never reaches it and
    // silently runs once. Includes weekly/interval (every <weekday>, every N min/hours, weekday/weekend)
    // added with recurring-schedules — omitting them made that whole feature unreachable from chat.
    // Also cover the absolute clock-time shapes parseSchedule's at/at24 branches accept — a bare
    // "at 6pm" / "at 14:30" / any "tomorrow ..." — else "text me the headlines at 6pm" / "tomorrow at
    // 9am send X" never reach the parser and silently run once (same invariant break as the recurring
    // gate). A bare "at 5" (no am/pm, no colon) is still NOT cued — parseSchedule rejects it too.
    // Snooze / resume (snooze-automations): "pause btc for 2 days" / "snooze morning digest" / "resume
    // btc" quiets a standing automation through travel or noise instead of destroying it with /cancel or
    // /forget. Runs BEFORE the schedule cue so "pause"/"snooze"/"resume" aren't misread as a new reminder.
    // Sticky ack (sticky-acknowledged-reminders): a bare "done"/"stop" reply stops a re-pinging sticky
    // reminder. Runs FIRST + only fires when the chat actually has a sticky reminder (stickyAck returns
    // [] otherwise), so a normal "done"/"ok" reply isn't swallowed when nothing is nagging.
    if (!isExplicitCommand && deps.stickyAck) {
      const acked = deps.stickyAck(msg.chatId, msg.text);
      if (acked && acked.length) {
        const what = acked.length === 1 ? `"${acked[0]}"` : `${acked.length} reminders`;
        await deps.sendMessage(msg.chatId, `Nice — stopped reminding you about ${what}. 👍`);
        return;
      }
    }

    if (!isExplicitCommand && deps.scheduleSnooze) {
      const s = deps.scheduleSnooze(msg.chatId, msg.text, deps.now());
      if (s) {
        if (s.count === 0) {
          await deps.sendMessage(msg.chatId, `I couldn't find "${s.which}" to ${s.action}. See /schedules and /alerts for the names.`);
        } else if (s.action === "pause") {
          const scope = s.which === "all" ? "all your automations" : `"${s.which}"`;
          const until = s.untilText ? ` until ${s.untilText}` : " until you resume it";
          await deps.sendMessage(msg.chatId, `Paused ${scope}${until}. Nothing fires meanwhile — say "resume ${s.which}" to turn it back on.`);
        } else {
          const scope = s.which === "all" ? "all your automations" : `"${s.which}"`;
          await deps.sendMessage(msg.chatId, `Resumed ${scope} — back on its normal schedule.`);
        }
        return;
      }
    }

    // Contact follow-up nudge (contact-followup-nudge): "follow up with Sarah in 3 days" / "remind me to
    // reply to my landlord tomorrow" -> a person-anchored reminder that fires with the contact's handle +
    // a draft link. Gated on the follow-up/get-back-to/reply-to verb so a plain reminder isn't captured;
    // checked before the generic schedule cue. null -> not a follow-up, fall through.
    if (!isExplicitCommand && deps.followUpAdd
        && /\b(follow\s+up\s+with|check\s+in\s+with|circle\s+back|get\s+back\s+to|reply\s+to)\b/i.test(msg.text)) {
      const r = deps.followUpAdd(msg.chatId, msg.text, deps.now());
      if (r) {
        if (!r.ok) {
          // Couldn't parse a time — fall through to the normal scheduler/agent rather than dead-ending.
          if (r.reason !== "unparsed") { await deps.sendMessage(msg.chatId, `You've got a lot scheduled — I hit my reminder limit. Cancel one with /cancel first.`); return; }
        } else {
          const who = r.hasContact ? `${r.name} (I'll include their contact + a draft link)` : `${r.name}`;
          const when = r.whenText ? ` ${r.whenText}` : "";
          const warn = r.saved === false ? ` (⚠️ couldn't save to disk — may be lost on restart)` : "";
          await deps.sendMessage(msg.chatId, `👋 Got it — I'll nudge you to follow up with ${who}${when}.${warn}`);
          return;
        }
      }
    }

    // Quick-log tracker (quick-log-tracker): "log weight 182" / "spent $14 on lunch" appends a tagged
    // point; "show my weight this month" / "how much did I spend on food" answers with a summary (+ a
    // chart for a trend). Log-ADD is checked before the scheduler ("log X" isn't a reminder); the QUERY
    // is gated on a show/how-much cue. Both null-fall-through when the message isn't a log command.
    if (!isExplicitCommand && deps.logAdd) {
      const r = deps.logAdd(msg.chatId, msg.text, deps.now());
      if (r) {
        if (!r.ok) { await deps.sendMessage(msg.chatId, `You're tracking a lot of things already — I've hit my per-chat log limit. Pick one to stop first.`); return; }
        const val = r.unit === "$" ? `$${r.value}` : `${r.value}${r.unit ? ` ${r.unit}` : ""}`;
        const warn = r.saved === false ? ` (⚠️ couldn't save to disk — may be lost on restart)` : "";
        await deps.sendMessage(msg.chatId, `📝 Logged ${r.tag}: ${val}. ${r.count} entr${r.count === 1 ? "y" : "ies"} so far — ask "show my ${r.tag}" anytime.${warn}`);
        return;
      }
    }
    if (!isExplicitCommand && deps.logQuery && /\b(how much (?:did|have|do)|show\s+(?:me\s+)?(?:my|the)|my\s+\w+\s+(?:trend|history|log)|\btrend\b|\bhistory\b)\b/i.test(msg.text)) {
      const r = await deps.logQuery(msg.chatId, msg.text, deps.now());
      if (r) {
        if (r.png && deps.sendPhoto) { await deps.sendPhoto(msg.chatId, r.png, r.text); return; }
        await deps.sendMessage(msg.chatId, r.text);
        return;
      }
    }

    // Countdown (countdown-tracker): "countdown to my flight Dec 20" / "start a countdown to vacation
    // on 2026-07-01" -> persist milestone pings + confirm the day count. Gated on the explicit "countdown"
    // word ONLY: a bare "how many days until Christmas" is a one-shot QUESTION (date_math answers it via
    // the agent), not a standing countdown — capturing that here would wrongly schedule pings for it.
    // Checked before the schedule cue so "countdown ... on <date>" isn't read as a one-shot reminder.
    if (!isExplicitCommand && deps.countdownAdd && /\bcountdown\b/i.test(msg.text)) {
      const r = deps.countdownAdd(msg.chatId, msg.text, deps.now());
      if (r) {
        if (!r.ok) { await deps.sendMessage(msg.chatId, r.message); return; }
        const warn = r.saved === false ? `\n\n⚠️ Couldn't save it to disk — the pings may be lost if I restart.` : "";
        await deps.sendMessage(msg.chatId, `${r.message}${warn}`);
        return;
      }
    }

    const scheduleCue = /\b(remind me|keep reminding|nag me|every day|every morning|every evening|every night|daily|weekdays?|weekends?|tomorrow|monthly|yearly|annually)\b|\bevery\s+(month|year)\b|\bevery\s+(mon|tue|wed|thu|fri|sat|sun)|\bevery\s+(\d+|other)\s*(min|hour|hr|day|week|wk)|\bin \d+\s*(min|hour|day|week|wk)|\bin\s+(an?|half\s+an?|a\s+couple|a\s+few|several|one|two|three)\s+(min|hour|hr|day|week|wk)|\b(set\s+(?:an?\s+)?alarm|wake\s+me)\b|\btimer\b|\bnext\s+(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b|\b(?:on\s+)?(january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\.|\b)\s+\d{1,2}\b|\bon\s+may\s+\d{1,2}\b|\bon\s+the\s+\d{1,2}(st|nd|rd|th)\b|\bat\s+\d{1,2}\s*(am|pm)\b|\bat\s+([01]?\d|2[0-3]):[0-5]\d\b/i;
    if (!isExplicitCommand && deps.scheduleAdd && scheduleCue.test(msg.text)) {
      // First-reminder tz (first-reminder-tz-ask): a clock-time schedule with no saved tz would fire
      // against UTC (a new user's "remind me at 7am" lands at 3am). Ask the city ONCE first (city→tz
      // infer) + stash this message; the reply saves the tz and re-runs it, scheduled at the right hour.
      // Falls through if capture isn't wired or a city is already known.
      if (deps.scheduleNeedsTz && deps.captureLocation && !pendingLocation.has(msg.chatId)
          && deps.scheduleNeedsTz(msg.chatId, msg.text, deps.now())) {
        pendingLocation.set(msg.chatId, msg.text);
        await deps.sendMessage(msg.chatId, "Before I set that — what city are you in? I'll fire it at your local time (I only need this once).");
        return;
      }
      const r = deps.scheduleAdd(msg.chatId, msg.text, deps.now());
      if (r.ok) {
        const verb = r.sticky ? "keep reminding you (until you reply \"done\")" : r.kind === "once" ? "remind you" : r.kind === "daily" ? "do this daily" : r.kind === "weekly" ? "do this on the days you said" : r.kind === "monthly" ? "do this every month" : r.kind === "yearly" ? "do this every year" : "do this on that schedule";
        // Echo the resolved next-fire time so a wrong/absent timezone is caught before it fires late.
        const when = r.whenText ? ` Next: ${r.whenText}.` : "";
        // No timezone set + a clock-time schedule -> it fires against UTC (likely the user's night).
        // Flag it so they can fix it now instead of finding out when the first one lands at 3am.
        const tzWarn = r.noTz ? ` ⚠️ No timezone set, so this is UTC — set yours with "/setlocation <city> UTC-5" so it fires at your local time.` : "";
        // saved===false: the write to disk failed — don't claim the reminder is set when it won't
        // survive a restart (persist-bool-all-stores). Reminders are the highest-trust feature.
        if (r.saved === false) {
          await deps.sendMessage(msg.chatId, `I've set that up for now, but I couldn't save it to disk — it may be lost if I restart. Please set it again in a moment.`);
          return;
        }
        await deps.sendMessage(msg.chatId, `Got it — I'll ${verb}: "${r.task}".${when}${tzWarn} Manage with /schedules.`);
        return;
      }
      if (r.reason === "capped") { await deps.sendMessage(msg.chatId, "You've hit the limit of scheduled tasks — cancel one with /schedules first."); return; }
      // reason === "unparsed" AND the user clearly meant to SET a reminder ("remind me to call mom at
      // 3" with no am/pm, "remind me tonight") -> DON'T run it as an immediate agent task (there's no
      // reminder tool, so the reminder would silently never be set). Ask for the missing time instead.
      // Exclude question forms ("remind me WHY the sky is blue", "remind me what X is") — those are
      // "tell me" asks, not reminders, and should reach the agent. A time-ish word present but
      // unparsed (tonight/later/this evening/at <n>) is a strong signal it really was a reminder.
      const isReminderToDo = /\bremind\s+me\s+(to|about|that)\b/i.test(msg.text)
        && !/\bremind\s+me\s+(why|what|who|when|where|how|whether|if)\b/i.test(msg.text);
      const hasVagueTime = /\b(tonight|later|this (morning|afternoon|evening)|soon|in a (min|minute|bit|sec|second|hour)|at \d)/i.test(msg.text);
      if (isReminderToDo || (/\bremind\b/i.test(msg.text) && hasVagueTime)) {
        // Stash the bare to-do so the user's time reply re-runs it as a full reminder instead of losing
        // the task (reminder-no-time-ask). Strip the "remind me to/about/that" lead + any dangling vague
        // time word so "call mom" is stored clean.
        const task = msg.text.trim()
          .replace(/^\s*(?:please\s+)?remind\s+me\s+(?:to|about|that)\s+/i, "")
          .replace(/\b(tonight|later|soon|this (?:morning|afternoon|evening))\s*$/i, "")
          .replace(/\s+/g, " ").replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, "").trim();
        if (task) pendingReminder.set(msg.chatId, task);
        await deps.sendMessage(msg.chatId, "When should I remind you? Give me a time like \"at 3pm\", \"in 2 hours\", or \"tomorrow at 9am\".");
        return;
      }
      // otherwise fall through to the agent (it wasn't really a schedule request).
    }

    // /templates: browse + install a ready-made recipe (starter-template-library). "/templates" lists
    // the catalog; "/templates <id>" installs it under its recipe name via recipeSaveNamed so a cold
    // user gets a working automation in one tap without learning the "save X:" syntax. No agent run.
    if (first === "/templates" && deps.recipeSaveNamed) {
      const arg = msg.text.trim().split(/\s+/).slice(1).join(" ").trim();
      // Tap-to-install gallery (starter-automation-gallery): show the catalog WITH one-tap install
      // buttons (channels without inline buttons just see the text list + can /templates <id>).
      if (!arg) { await deps.sendMessage(msg.chatId, templateCatalog(), deps.answerCallback ? installButtons(templateButtons()) : undefined); return; }
      const tpl = getTemplate(arg);
      if (!tpl) { await deps.sendMessage(msg.chatId, `No template "${arg}". Send /templates for the list.`); return; }
      const r = deps.recipeSaveNamed(msg.chatId, tpl.recipeName, tpl.task);
      if (!r.ok) { await deps.sendMessage(msg.chatId, "You've hit the recipe limit — /forget one first."); return; }
      const slotHint = /\{[a-z0-9_]+\}/i.test(tpl.task) ? ` (fill the {value} — e.g. /run ${tpl.recipeName} <value>)` : "";
      await deps.sendMessage(msg.chatId, `Installed "${tpl.recipeName}". Run it with /run ${tpl.recipeName}${slotHint}.`);
      return;
    }

    // /recipes: list saved recipes. No agent run.
    if (first === "/recipes" && deps.recipeList) {
      const list = deps.recipeList(msg.chatId);
      if (!list.length) { await deps.sendMessage(msg.chatId, "No saved recipes. Save one: \"save btc: check the price of bitcoin\", then /run btc."); return; }
      const lines = list.map((r) => `• ${r.name}${r.schedule ? ` (${r.schedule})` : ""} — ${r.task}`);
      await deps.sendMessage(msg.chatId, `Your recipes:\n${lines.join("\n")}\n\nRun with /run <name>, remove with /forget <name>.`);
      return;
    }

    // /forget <name>: remove a saved recipe. No agent run.
    if (first === "/forget" && deps.recipeForget) {
      const name = msg.text.trim().split(/\s+/).slice(1).join(" ").trim();
      if (!name) { await deps.sendMessage(msg.chatId, "Usage: /forget <name> — see /recipes for the names."); return; }
      const removed = deps.recipeForget(msg.chatId, name);
      await deps.sendMessage(msg.chatId, removed ? `Forgot "${name}".` : "No recipe by that name — see /recipes.");
      return;
    }

    // /alerts: list watch-and-notify alerts. No agent run.
    if (first === "/alerts" && deps.alertList) {
      const list = deps.alertList(msg.chatId);
      if (!list.length) { await deps.sendMessage(msg.chatId, "No alerts. Set one: \"watch btc: price of bitcoin when it changes by 1000\" — I'll only ping you when it moves."); return; }
      const lines = list.map((a) => `• ${a.name}${a.members ? ` (watchlist, ${a.members} items)` : a.feed ? " (new items)" : a.threshold ? ` (±${a.threshold})` : ""} — ${a.task}${a.then ? ` → then run ${a.then}` : ""}${a.lastValue ? ` [last: ${a.lastValue.slice(0, 40)}]` : ""}`);
      await deps.sendMessage(msg.chatId, `Your alerts:\n${lines.join("\n")}\n\nRemove with /forget-alert <name>.`);
      return;
    }

    // /forget-alert <name>: remove an alert. No agent run.
    if (first === "/forget-alert" && deps.alertForget) {
      const name = msg.text.trim().split(/\s+/).slice(1).join(" ").trim();
      if (!name) { await deps.sendMessage(msg.chatId, "Usage: /forget-alert <name> — see /alerts for the names."); return; }
      const removed = deps.alertForget(msg.chatId, name);
      await deps.sendMessage(msg.chatId, removed ? `Stopped watching "${name}".` : "No alert by that name — see /alerts.");
      return;
    }

    // "change <name> to below 45000" / "make <name> fire under 200" -> retune an existing alert's
    // trigger in place (conversational edit), before define so an edit isn't mistaken for a new watch.
    // Only fires when a trigger clause is present, so "change my flight" still goes to the agent.
    if (deps.alertEdit && /^\s*(?:change|update|edit|set|make)\s+.+\s(?:below|under|above|over|hits?|reaches?|in\s+stock|by)\b/i.test(msg.text)) {
      const r = deps.alertEdit(msg.chatId, msg.text);
      if (r.ok) {
        // A failed persist silently reverts the trigger to the old threshold on restart — hedge like every
        // other write path (alert-edit-persist-hedge) so the user knows to retry.
        const hedge = r.saved === false ? ` ⚠️ But I couldn't save that to disk — it may revert if I restart; try again in a moment.` : "";
        await deps.sendMessage(msg.chatId, `Updated "${r.name}" — ${r.summary}.${hedge}`);
        // Run one check now, like the define path: editing into an already-true predicate ("change
        // btc to below 55000" when it's already below) produces no future edge, so without this the
        // user would hear nothing until it crosses again — maybe never. alertRunNow re-baselines +
        // notifies if it already holds. Guarded so a flaky check can't break the confirmation.
        // Rate-gate the immediate check: it's a full LLM+anvil run, so skip it when the chat is over
        // its limit (the scheduled cadence still covers it) rather than letting spam open sessions.
        if (deps.alertRunNow && deps.checkRateLimit(msg.chatId).allowed) {
          // Commit only on a delivered ping (immediate-alert-commit-not-send-gated): a failed send must
          // leave the baseline so the crossing re-fires next check, not be silently eaten.
          try { const c = await deps.alertRunNow(msg.chatId, r.name); if (c.message) { if (await deps.sendMessage(msg.chatId, c.message) !== false) c.commit(); } else c.commit(); }
          catch { /* a flaky post-edit check must not break the update confirmation */ }
        }
        return;
      }
      if (r.reason === "unknown") { await deps.sendMessage(msg.chatId, "I don't have an alert by that name — see /alerts."); return; }
      // unparsed: fall through to define / agent
    }

    // "follow <target>" -> a keyless feed subscription (follow-feed-subscriptions): pings only on NEW
    // items from an RSS/Reddit/HN/YouTube source, fetched directly. Before the agent + schedule matcher.
    if (deps.followFeed && /^\s*(?:follow|subscribe\s+to)\s+\S/i.test(msg.text)) {
      const r = deps.followFeed(msg.chatId, msg.text, deps.now());
      if (r && r.ok) {
        if (r.saved === false) { await deps.sendMessage(msg.chatId, `I've set up following ${r.label} for now, but I couldn't save it to disk — it may be lost if I restart. Try again shortly.`); return; }
        await deps.sendMessage(msg.chatId, `Following ${r.label} — I'll ping you only when a NEW item shows up. See /alerts; stop with "/forget-alert ${r.name}".`);
        return;
      }
      if (r && !r.ok && r.reason === "capped") { await deps.sendMessage(msg.chatId, "You've hit the watch limit — /alerts then /forget-alert one first."); return; }
      if (r && !r.ok && r.reason === "unresolved") {
        await deps.sendMessage(msg.chatId, "I can follow a blog/site feed, a subreddit (r/name), a Hacker News topic (\"HN rust\"), or a YouTube channel link. For anything else, try \"watch <name>: <task> for new items\".");
        return;
      }
      // null: not actually a follow command — fall through.
    }

    // "watch <name>: <task>" / "alert me <name>: <task>" -> define + auto-schedule a change-alert.
    if (deps.alertDefine && /^\s*(?:alert(?:\s+me)?|watch)\s+[^:]+:\s*\S/i.test(msg.text)) {
      const r = deps.alertDefine(msg.chatId, msg.text, deps.now());
      if (r.ok) {
        // Write to disk failed -> the watch won't survive a restart (persist-bool-all-stores). Don't
        // confirm it as active, and skip the run-now check (it'd imply a live watch that isn't saved).
        if (r.saved === false) {
          await deps.sendMessage(msg.chatId, `I've set up "${r.name}" for now, but I couldn't save it to disk — it may be lost if I restart. Please set it again in a moment.`);
          return;
        }
        const thenNote = r.then ? ` Then I'll run your "${r.then}" recipe and include its result.` : "";
        await deps.sendMessage(msg.chatId, (r.members
          ? `Watching "${r.name}" — ${r.members} items in one list; I'll send a single update with only the ones that change.`
          : r.weather
          ? `Watching the forecast for "${r.name}" — I'll message you if there's ${r.weather}.`
          : r.pageUrl
          ? `Watching that page for "${r.name}" — I'll message you with what changed when its content updates.`
          : r.feed
          ? `Watching "${r.name}" for new items — I'll message you only when a NEW one shows up.`
          : `Watching "${r.name}" — I'll only message you when it changes.`) + thenNote + " See /alerts.");
        // Run one check now so the user isn't silent until the first scheduled cadence (~24h). If the
        // predicate already holds (e.g. "below 50000" and it's already there), tell them right away.
        // Rate-gate this full LLM+anvil check so spamming define can't open unbounded sessions.
        if (deps.alertRunNow && deps.checkRateLimit(msg.chatId).allowed) {
          try {
            const c = await deps.alertRunNow(msg.chatId, r.name);
            // Commit only on a delivered ping (immediate-alert-commit-not-send-gated).
            if (c.message) { if (await deps.sendMessage(msg.chatId, c.message) !== false) c.commit(); } else c.commit();
          } catch { /* a flaky first check must not break the define confirmation */ }
        }
        return;
      }
      if (r.reason === "capped") { await deps.sendMessage(msg.chatId, "You've hit the alert limit — /forget-alert one first."); return; }
      // unparsed: fall through
    }

    // /digests: list saved digests. No agent run.
    if (first === "/digests" && deps.digestList) {
      const list = deps.digestList(msg.chatId);
      if (!list.length) { await deps.sendMessage(msg.chatId, "No digests. Define one: \"define digest morning: weather, hn, btc\" (from saved recipes), then /run morning."); return; }
      const lines = list.map((d) => `• ${d.name}${d.schedule ? ` (${d.schedule})` : ""} — ${d.members.join(", ")}`);
      await deps.sendMessage(msg.chatId, `Your digests:\n${lines.join("\n")}\n\nRun with /run <name>, remove with /forget-digest <name>.`);
      return;
    }

    // /forget-digest <name>: remove a digest. No agent run.
    if (first === "/forget-digest" && deps.digestForget) {
      const name = msg.text.trim().split(/\s+/).slice(1).join(" ").trim();
      if (!name) { await deps.sendMessage(msg.chatId, "Usage: /forget-digest <name> — see /digests for the names."); return; }
      const removed = deps.digestForget(msg.chatId, name);
      await deps.sendMessage(msg.chatId, removed ? `Forgot digest "${name}".` : "No digest by that name — see /digests.");
      return;
    }

    // "define digest <name>: a, b, c" -> store a digest. No agent run.
    if (deps.digestDefine && /^\s*(?:define\s+)?digest\s+[^:]+:\s*\S/i.test(msg.text)) {
      const r = deps.digestDefine(msg.chatId, msg.text);
      if (r.ok) {
        if (r.saved === false) { await deps.sendMessage(msg.chatId, `I've got digest "${r.name}" for now, but I couldn't save it to disk — it may be lost if I restart. Try again shortly.`); return; }
        await deps.sendMessage(msg.chatId, `Saved digest "${r.name}" (${r.members} recipe${r.members === 1 ? "" : "s"}). Run it with /run ${r.name}.`); return;
      }
      if (r.reason === "capped") { await deps.sendMessage(msg.chatId, "You've hit the digest limit — /forget-digest one first."); return; }
      // unparsed: fall through
    }

    // "schedule <name> <when>" -> run a saved digest OR recipe on a cadence (digest first). No agent run.
    // Skip "schedule that/this/it ..." — that's the by-reference form handled below (watch-schedule-that).
    if ((deps.recipeSchedule || deps.digestSchedule) && /^\s*schedule\s+\S+/i.test(msg.text) && !/^\s*schedule\s+(?:that|this|it)\b/i.test(msg.text)) {
      // Split name<->time via the pure helper: it keeps the LONGEST name that still leaves a
      // clean time clause, so a name whose interior has a time word ("check in") isn't truncated
      // (DEV-0129). Falls back to null when no split yields a parseable clause.
      const split = splitScheduleCommand(msg.text, deps.now());
      if (split) {
        const name = split.name;
        // "schedule recipe <name> ..." forces the recipe over a same-named digest (DEV-0131,
        // twin of DEV-0130's /run keyword); bare "schedule <name> ..." stays digest-first.
        const isDig = !split.explicitRecipe && deps.isDigest?.(msg.chatId, name) && deps.digestSchedule;
        const r = isDig ? deps.digestSchedule!(msg.chatId, name, split.clause, deps.now())
                        : deps.recipeSchedule?.(msg.chatId, name, split.clause, deps.now());
        if (r?.ok) { await deps.sendMessage(msg.chatId, `Scheduled "${name}" (${r.kind}). Manage with /schedules.`); return; }
        const why = r?.reason === "unknown" ? "No recipe or digest by that name." : r?.reason === "capped" ? "You've hit the scheduled-task limit — /cancel one first." : r?.reason === "needsarg" ? `"${name}" has a fill-in value ({...}), so it can't run on a schedule with a fixed value. Save a version without the {slot} to schedule it.` : "I couldn't parse that time. Try \"schedule <name> every morning\".";
        await deps.sendMessage(msg.chatId, why); return;
      }
    }

    // "save that as <name>" -> capture the task the user JUST ran as a recipe, without retyping it
    // after a colon (product-loop). Resolve the most recent real USER task from memory (skip command-
    // shaped / media-placeholder turns); if there's nothing to save, say so instead of saving junk.
    if (deps.recipeSaveNamed) {
      const staName = parseSaveThatAs(msg.text);
      if (staName) {
        const hist = deps.memoryGet(msg.chatId);
        const prior = [...hist].reverse().find((m) => m.role === "user" && typeof m.content === "string"
          && !/^\s*(save|\/|run\b|watch\b|alert\b|change\b|remind|every\b|schedule\b|digest\b)/i.test(m.content as string)
          && !/^\[(photo|document)\]/.test(m.content as string));
        if (!prior) { await deps.sendMessage(msg.chatId, "Nothing recent to save — run a task first, then \"save that as <name>\"."); return; }
        const r = deps.recipeSaveNamed(msg.chatId, staName, (prior.content as string).trim());
        if (r.ok) {
          if (r.saved === false) { await deps.sendMessage(msg.chatId, `I've got "${r.name}" for now, but I couldn't save it to disk — it may be lost if I restart. Try again shortly.`); return; }
          await deps.sendMessage(msg.chatId, `Saved recipe "${r.name}" from your last task. Run it anytime with /run ${r.name}.`); return;
        }
        await deps.sendMessage(msg.chatId, "You've hit the recipe limit — /forget one first.");
        return;
      }
    }

    // "watch that [below N]" / "schedule that every morning" -> turn the task the user JUST ran into a
    // standing alert/schedule with zero retype (watch-schedule-that-by-ref), extending "save that as".
    {
      const watchThat = parseWatchThat(msg.text);
      const scheduleThat = parseScheduleThat(msg.text);
      if (watchThat || scheduleThat) {
        const hist = deps.memoryGet(msg.chatId);
        const prior = [...hist].reverse().find((m) => m.role === "user" && typeof m.content === "string"
          && !/^\s*(save|\/|run\b|watch\b|alert\b|change\b|remind|every\b|schedule\b|digest\b|do that\b|more\b|link)/i.test(m.content as string)
          && !/^\[(photo|document)\]/.test(m.content as string));
        if (!prior) { await deps.sendMessage(msg.chatId, `Nothing recent to ${watchThat ? "watch" : "schedule"} — run a task first, then say "${watchThat ? "watch that" : "schedule that every morning"}".`); return; }
        const task = (prior.content as string).trim();
        if (watchThat && deps.alertDefine) {
          // Derive a short name from the SALIENT task words (drop filler like what's/the/price/of) so
          // "what's the price of bitcoin" -> "bitcoin", not "whats-the" (which collided across tasks +
          // silently overwrote a prior alert by name — audit 20 B#2). Fall back to "watch" if empty.
          const STOP = new Set(["whats", "what", "the", "a", "an", "of", "is", "to", "in", "on", "me", "my", "price", "cost", "check", "how", "much", "get", "for", "s", "it", "that", "this"]);
          const salient = task.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w && !STOP.has(w));
          const name = (salient.length ? salient : task.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean)).slice(0, 2).join("-") || "watch";
          const r = deps.alertDefine(msg.chatId, `watch ${name}: ${task}${watchThat.clause ? " " + watchThat.clause : ""}`, deps.now());
          if (r.ok) {
            await deps.sendMessage(msg.chatId, `Watching "${r.name}" — I'll message you when it changes. See /alerts.`);
            if (deps.alertRunNow && deps.checkRateLimit(msg.chatId).allowed) { try { const c = await deps.alertRunNow(msg.chatId, r.name); if (c.message) { if (await deps.sendMessage(msg.chatId, c.message) !== false) c.commit(); } else c.commit(); } catch { /* flaky first check */ } }
            return;
          }
          await deps.sendMessage(msg.chatId, r.reason === "capped" ? "You've hit the alert limit — /forget-alert one first." : "I couldn't set that watch — try \"watch <name>: <task>\".");
          return;
        }
        if (scheduleThat && deps.scheduleAdd) {
          const r = deps.scheduleAdd(msg.chatId, `${task} ${scheduleThat.clause}`, deps.now());
          if (r.ok) {
            const when = r.whenText ? ` Next: ${r.whenText}.` : "";
            // Same no-timezone warning the primary schedule path shows, so a by-ref schedule with no tz
            // doesn't silently fire at UTC (audit 20 B#5).
            const tzWarn = r.noTz ? ` ⚠️ No timezone set, so this is UTC — set yours with "/setlocation <city> UTC-5".` : "";
            await deps.sendMessage(msg.chatId, `Got it — I'll do that on that schedule: "${r.task}".${when}${tzWarn} Manage with /schedules.`); return;
          }
          await deps.sendMessage(msg.chatId, r.reason === "capped" ? "You've hit the schedule limit — /cancel one first." : "I couldn't read that timing — try \"schedule that every morning\" or \"...at 9am\".");
          return;
        }
      }
    }

    // "save <name>: <task>" -> store a recipe. No agent run.
    if (deps.recipeSave && /^\s*save(\s+recipe)?\s+[^:]+:\s*\S/i.test(msg.text)) {
      const r = deps.recipeSave(msg.chatId, msg.text);
      if (r.ok) {
        if (r.saved === false) { await deps.sendMessage(msg.chatId, `I've got "${r.name}" for now, but I couldn't save it to disk — it may be lost if I restart. Try again shortly.`); return; }
        await deps.sendMessage(msg.chatId, `Saved recipe "${r.name}". Run it anytime with /run ${r.name}.`); return;
      }
      if (r.reason === "capped") { await deps.sendMessage(msg.chatId, "You've hit the recipe limit — /forget one first."); return; }
      // unparsed: fall through
    }

    // "/run <name>" / "run <name>" -> DIGEST (compose+send now) or RECIPE (rewrite to its task,
    // fall through to the agent). Digest checked first so a bare name resolves a digest — UNLESS the
    // user typed the explicit "recipe" keyword ("/run recipe <name>" / "run recipe <name>"), which
    // signals recipe intent and must NOT be shadowed by a same-named digest (DEV-0130).
    if ((deps.recipeResolve || deps.digestRun) && /^(\/run\b|run\s+)/i.test(msg.text)) {
      const explicitRecipe = /^(?:\/run|run)\s+recipe\s+\S/i.test(msg.text.trim());
      const nameOnly = msg.text.trim().replace(/^\/run\b\s*/i, "").replace(/^run\s+/i, "").replace(/^recipe\s+/i, "").trim();
      if (!explicitRecipe && nameOnly && deps.isDigest?.(msg.chatId, nameOnly) && deps.digestRun) {
        // A digest runs ONE agent per member (many anvil sessions) — the most expensive inline op, so
        // rate-gate it like the agent path (spamming "/run <digest>" otherwise exhausts the browser
        // pool + starves other chats). A recipe /run falls through to the rate-checked agent path below.
        const rl = deps.checkRateLimit(msg.chatId);
        if (!rl.allowed) { await deps.sendMessage(msg.chatId, `You're sending a lot — give me ${rl.retryAfterSec}s to catch up.`); return; }
        const composed = digestDisplay(await deps.digestRun(msg.chatId, nameOnly));
        await deps.sendMessage(msg.chatId, composed ?? "That digest is empty or gone — see /digests.");
        return;
      }
      const hit = deps.recipeResolve?.(msg.chatId, msg.text);
      if (hit && "missingArg" in hit) { await deps.sendMessage(msg.chatId, `"${hit.name}" needs a value — try "/run ${hit.name} <value>".`); return; }
      // A multi-slot recipe with an ambiguous positional fill (multi-word value, no commas/pairs): ask for
      // a form that maps cleanly rather than silently running against a mis-split value.
      if (hit && "ambiguousArgs" in hit) {
        const ex = hit.slots.map((s) => `${s}=…`).join(" ");
        await deps.sendMessage(msg.chatId, `"${hit.name}" has ${hit.slots.length} fill-ins (${hit.slots.join(", ")}). To avoid mixing up multi-word values, give them as "${ex}" or comma-separated in order.`);
        return;
      }
      // A chained recipe (task has ">>") runs its steps sequentially via runChainRecipe rather than as
      // one agent task (recipe-chaining). Rate-limited like an agent turn; result cached for drilldown.
      if (hit && "task" in hit && deps.runChainRecipe && isChain(hit.task)) {
        const rl = deps.checkRateLimit(msg.chatId);
        if (!rl.allowed) { await deps.sendMessage(msg.chatId, `You're sending a lot — give me ${rl.retryAfterSec}s to catch up.`); return; }
        await deps.sendTyping(msg.chatId);
        const startedAt = deps.now();
        // A chain holds the per-chat lock across several sequential agent runs, so a long one reads as
        // a hang; arm the same one-shot "still working" ping the agent path uses (chain-progress-partial).
        const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
        let chainProgress: unknown = null;
        if (deps.progressDelayMs && deps.progressDelayMs > 0) {
          chainProgress = setTimer(() => {
            void deps.sendMessage(msg.chatId, "Still working on it — running your steps, hang tight…").catch(() => {});
          }, deps.progressDelayMs);
        }
        try {
          const res = await deps.runChainRecipe(msg.chatId, hit.task);
          // Accept a structured result (final + stoppedEarly) or a legacy bare string. When the chain
          // stopped early, the "final" is only an INTERMEDIATE step's output — say so instead of passing
          // it off as the complete answer (chain-progress-partial).
          const out = typeof res === "string" ? res : res.final;
          const stoppedEarly = typeof res === "string" ? false : !!res.stoppedEarly;
          const stepsNote = (typeof res === "object" && res.stepsDone && res.stepsTotal)
            ? ` (${res.stepsDone} of ${res.stepsTotal} steps)` : "";
          const body = stoppedEarly
            ? `⚠️ Couldn't finish all the steps${stepsNote} — here's how far it got:\n\n${out}`
            : out;
          const parts = formatReplyParts(body);
          lastResult.set(msg.chatId, { full: parts.full, sent: deliveredLen(parts.full, parts.shown) });
          if (chainProgress !== null) { clearTimer(chainProgress); chainProgress = null; }
          await deps.sendMessage(msg.chatId, parts.shown);
          deps.recordTurn({ steps: 0, tools: [], elapsedMs: deps.now() - startedAt, ok: !stoppedEarly });
        } catch (e) {
          if (chainProgress !== null) { clearTimer(chainProgress); chainProgress = null; }
          deps.recordTurn({ steps: 0, tools: [], elapsedMs: deps.now() - startedAt, ok: false });
          await deps.sendMessage(msg.chatId, friendlyError(e instanceof Error ? e.message : String(e)));
        }
        return;
      }
      if (hit) { msg = { ...msg, text: hit.task }; } // run the saved task via the agent path below
      else if (/^\/run\b/i.test(msg.text)) { await deps.sendMessage(msg.chatId, "No recipe or digest by that name — see /recipes or /digests."); return; }
      // natural "run ..." with no match: fall through to the agent as a normal message.
    }

    // Slash commands reply instantly — no rate-limit/agent.
    const cmd = deps.handleCommand(msg.text);
    if (cmd) {
      // Onboarding tap-to-try (onboarding-tap-to-try): the START/greeting reply (opens with 👋) gets a
      // row of one-tap example buttons so a brand-new user gets an instant first success instead of
      // reading the wall + hand-typing. Only on START (not /help/status), only on a channel with buttons
      // + on the FIRST contact (empty history) so we don't re-badge a returning user's /start.
      const isStart = cmd.startsWith("👋");
      const kb = isStart && deps.answerCallback && deps.memoryGet(msg.chatId).length === 0 ? buildTryButtons() : undefined;
      await deps.sendMessage(msg.chatId, cmd, kb);
      return;
    }

    // Follow-up on the last answer (last-result-drilldown): "more"/"full" pages out the tail a
    // phone-size trim dropped; "send the link" returns the source URLs — both from cache, no agent
    // re-run. Only when the WHOLE message is that ask, so a real task isn't intercepted.
    {
      const cached = lastResult.get(msg.chatId);
      if (isMoreRequest(msg.text)) {
        // Page the pageable answer first; if it's exhausted (or was never set), fall back to the last
        // proactive ping — so a scheduled digest firing mid-conversation no longer eats the answer tail.
        const answerChunk = cached ? chunkFrom(cached.full, cached.sent) : null;
        if (answerChunk) { lastResult.set(msg.chatId, { ...cached!, full: cached!.full, sent: answerChunk.nextOffset }); await deps.sendMessage(msg.chatId, answerChunk.text); return; }
        const pingChunk = cached?.ping ? chunkFrom(cached.ping.full, cached.ping.sent) : null;
        if (pingChunk) { lastResult.set(msg.chatId, { ...cached!, ping: { full: cached!.ping!.full, sent: pingChunk.nextOffset } }); await deps.sendMessage(msg.chatId, pingChunk.text); return; }
        if (cached) { await deps.sendMessage(msg.chatId, "That's the whole answer — nothing more to show."); return; }
        // no cached answer -> fall through (treat as a normal task)
      }
      if (isLinkRequest(msg.text)) {
        // Prefer links from the most recent thing the user saw: a proactive ping if one arrived after
        // the last answer, else the answer itself.
        const linkSource = cached?.ping?.full ?? cached?.full;
        const links = linkSource ? extractLinks(linkSource) : [];
        if (links.length) { await deps.sendMessage(msg.chatId, links.join("\n")); return; }
        if (cached) { await deps.sendMessage(msg.chatId, "No links in that last answer."); return; }
      }
    }

    // Recipe auto-recall (product-loop): a saved recipe is otherwise write-only — /run needs the exact
    // name a phone user never remembers. If this free-text message strongly matches a saved recipe,
    // offer to run it by name (don't auto-run — a surprise re-run would be worse than a fresh answer).
    // Only when the message ISN'T already a command shape (recipeMatch returns null for those).
    if (deps.recipeMatch) {
      const m = deps.recipeMatch(msg.chatId, msg.text);
      // Offer ONCE per phrase: if we just offered this exact message and the user sent it again (they
      // ignored the /run suggestion), fall through to a FRESH agent answer — so "ignore this and I'll
      // do it fresh" is true, not an inescapable loop for any phrasing that matches a saved recipe.
      const norm = msg.text.trim().toLowerCase();
      if (m && recallOffered.get(msg.chatId) !== norm) {
        recallOffered.set(msg.chatId, norm);
        await deps.sendMessage(msg.chatId, `That looks like your saved "${m.name}" — run it with /run ${m.name}, or send it again and I'll do it fresh.`);
        return;
      }
      recallOffered.delete(msg.chatId); // this message wasn't a fresh recall; clear so a later match re-offers
    }

    const rl = deps.checkRateLimit(msg.chatId);
    if (!rl.allowed) {
      await deps.sendMessage(msg.chatId, `You're sending a lot — give me ${rl.retryAfterSec}s to catch up.`);
      return;
    }

    if (!deps.hasModelKey()) {
      await deps.sendMessage(msg.chatId, "I'm not fully configured yet (missing model key). Try again soon.");
      return;
    }

    // Background errand (async-background-errands): a large "get back to me" task — ACK now and run it
    // DETACHED with a raised step budget, delivering the result unprompted. This returns immediately so
    // the per-chat chain isn't blocked for minutes (the user can keep texting). Guarded by the dep flag.
    if (deps.enableBackgroundErrands && isBackgroundErrand(msg.text)
        && (bgInFlight.get(msg.chatId) ?? 0) < MAX_BG_PER_CHAT) {
      await deps.sendMessage(msg.chatId, "On it — this one's bigger, so I'll work on it and text you when it's done. Keep texting me anything else meanwhile.");
      // Persist the pending errand (background-errand-persist) so a crash mid-run can replay it, then
      // run it detached with its stable id (the SAME dispatcher startup-recovery uses, so a replay
      // doesn't re-ACK or lose the record).
      const errandId = deps.bgErrandAdd?.(msg.chatId, msg.text) ?? `bg-${msg.chatId}-${deps.now()}`;
      dispatchBackground(msg.chatId, msg.text, errandId);
      return;
    }

    const history = deps.memoryGet(msg.chatId);
    const startedAt = deps.now();
    // Progress ping: arm a one-shot timer; if the agent run outlasts progressDelayMs, tell the user
    // we're still working (once) so a long browse doesn't read as a hang. Cleared as soon as the run
    // settles (success or error). Disabled when progressDelayMs is absent/0.
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    let progressHandle: unknown = null;
    if (deps.progressDelayMs && deps.progressDelayMs > 0) {
      progressHandle = setTimer(() => {
        void deps.sendMessage(msg.chatId, "Still working on it — reading the web, hang tight…").catch(() => {});
      }, deps.progressDelayMs);
    }
    const clearProgress = () => { if (progressHandle !== null) { clearTimer(progressHandle); progressHandle = null; } };
    try {
      await deps.sendTyping(msg.chatId);
      const profileCtx = deps.profileContext?.(msg.chatId) || "";
      // Proactive-ping follow-up (proactive-followup-context): if the last message this chat got was an
      // unprompted digest/alert ping (cached, proactive flag) and this reply is a short follow-up
      // ("why?", "what about ETH?"), give the agent that ping as context so it resolves against it
      // instead of cold-starting. Bounded so it's only a genuine follow-up, not a fresh full task.
      const cachedPing = lastResult.get(msg.chatId)?.ping;
      const pingCtx = (cachedPing && msg.text.trim().split(/\s+/).length <= 8)
        ? `The user is replying to this message I just sent them: "${cachedPing.full.slice(0, 600)}". Answer their follow-up in that context.`
        : "";
      const context = [profileCtx, pingCtx].filter(Boolean).join(" ") || undefined;
      const { reply, steps, tools, photo, doc, docName, degraded } = await runIt(msg.text, { llm: deps.llm, context, nowMs: deps.now(), tzOffsetMin: deps.chatTzOffsetMin?.(msg.chatId) ?? 0, weatherCoords: deps.weatherCoords?.(msg.chatId), weatherUnits: deps.weatherUnits?.(msg.chatId), ...(deps.recallAnswers ? { recall: (q: string) => deps.recallAnswers!(msg.chatId, q) } : {}), ...(deps.resolveContact ? { resolveContact: (n: string) => deps.resolveContact!(msg.chatId, n) } : {}) }, history);
      clearProgress();
      // A degraded reply is a soft-failure fallback (agent ran out of steps / produced no answer,
      // DEV-0176), not a real answer. Prepend a one-line hint so a live-bot user knows the result is
      // partial, and count the turn as NOT-ok so the success metric isn't inflated by soft failures
      // (DEV-0178 — handler is the 3rd consumer of the degraded flag, after alert-runner + digest-runner).
      const parts = formatReplyParts(reply);
      const body = parts.shown;
      let out = degraded ? `⚠️ Partial answer — I ran low on steps. Try narrowing the request.\n\n${body}` : body;
      // Cache the full (untrimmed) reply + what we showed, so a follow-up "more"/"link" serves the
      // dropped tail / source URLs without re-running the agent (last-result-drilldown). Text replies
      // only (a photo/doc has no pageable text).
      if (!photo && !doc) lastResult.set(msg.chatId, { full: parts.full, sent: deliveredLen(parts.full, body) });
      // Retention nudge (product-loop): if this task repeats one the user already asked, offer to save
      // it as a recipe. Only on a clean text reply (not degraded / not a binary), so it never clutters
      // a partial answer or a screenshot/PDF caption. Appended AFTER the body so the answer leads.
      if (deps.suggestSaves && !degraded && !photo && !doc) {
        const nudge = repeatedTaskNudge(msg.text, history);
        if (nudge) out += nudge;
        // First clean answer for this chat (empty prior history) + no repeat-nudge already shown ->
        // teach the proactive loop once: this reply can become recurring. Gated so it fires a single
        // time per chat and never stacks with the save-nudge.
        else if (history.length === 0 && !tippedChats.has(msg.chatId)) {
          tippedChats.add(msg.chatId);
          // Answer-specific tip (content-aware-cta): a price answer offers a watch, a fetched page a
          // digest, else the plain daily — a relevant CTA converts better than a templated one.
          out += recurringCta(msg.text, reply, tools);
        }
      }
      // If the agent produced a binary (screenshot image or PDF), send it first with the reply as
      // caption, then the text if the caption overflowed. Falls back to text-only when nothing was
      // produced or the sender isn't wired.
      // One-tap result picker (inline-result-picker): if a CLEAN text reply is a numbered/bulleted list
      // of options, cache the items + attach a "1 2 3…" pick-button row so a tap resends that one option
      // (with its link) instead of a retype. Text replies only (a photo/doc caption isn't a pickable
      // list) + not degraded (a partial answer's list is unreliable). Buttons cap at pickButtons' max.
      let replyKeyboard: InlineKeyboard | undefined;
      if (!photo && !doc && !degraded) {
        const items = parseResultList(body);
        if (items.length >= 2) { pickLists.set(msg.chatId, items); replyKeyboard = pickButtons(items.length); }
        // Tap-to-watch (tap-to-watch-on-answers): on a clean answer that isn't a pick-list, offer one-tap
        // "🔁 Every morning" (+ "🔔 Watch this" for a price/number answer) so the user turns it into an
        // automation without retyping — the retention flywheel the text save-nudge only describes. Gated
        // to when schedule wiring exists + this task isn't already a command-shaped/automation message.
        else if (deps.answerCallback && deps.scheduleAdd && canOfferAutomation(msg.text)) {
          lastTask.set(msg.chatId, msg.text.trim());
          replyKeyboard = actButtons(answerIsWatchable(msg.text, reply));
        }
      }
      // Track whether the reply actually reached the user (inbound-send-fail-swallowed): sendMessage
      // returns false when a chunk failed to send (it's best-effort, doesn't throw). The proactive runner
      // already gates on this; the inbound path ignored it, so a 429/network/blocked send left the user
      // with nothing AND still wrote the assistant turn to memory as delivered — the NEXT turn's context
      // then claimed an answer the user never saw. Gate the memory write on delivery. `=== false` only:
      // a channel returning void/undefined (console) counts as delivered, so older wiring is unaffected.
      let delivered = true;
      if (photo && deps.sendPhoto) {
        await deps.sendPhoto(msg.chatId, photo, out.slice(0, 1024));
        if (out.length > 1024) await deps.sendMessage(msg.chatId, out);
      } else if (doc && deps.sendDocument) {
        await deps.sendDocument(msg.chatId, doc, docName ?? "page.pdf", out.slice(0, 1024));
        if (out.length > 1024) await deps.sendMessage(msg.chatId, out);
      } else {
        delivered = (await deps.sendMessage(msg.chatId, out, replyKeyboard)) !== false;
      }

      // Append this turn to the CURRENT memory, not the pre-run `history` snapshot taken minutes ago
      // (sync-turn-clobbers-errand-memory). A detached background errand runs off the per-chat chain and
      // can write its result to memory WHILE this agent run is in flight (the ack invites "keep texting
      // meanwhile"); writing [...history, ...] here would erase that errand turn. Re-reading is race-free
      // (no await between get + set), mirroring the errand-completion path's own re-read fix.
      // Skip the write on a FAILED send (inbound-send-fail-swallowed): if the user never saw the answer,
      // don't poison the next turn's context with an assistant reply that was never delivered — leave the
      // user turn out too so a re-ask starts clean. Log the miss so a dropped reply is visible to the op.
      if (!delivered) {
        log(formatTurnLog({ chatId: msg.chatId, steps, tools, elapsedMs: deps.now() - startedAt, replyChars: 0, ok: false, error: "send_failed_not_delivered" }));
        deps.recordTurn({ steps, tools, elapsedMs: deps.now() - startedAt, ok: false });
        return;
      }
      const cur = deps.memoryGet(msg.chatId);
      const next: LLMMessage[] = [...cur, { role: "user", content: msg.text }, { role: "assistant", content: out }];
      deps.memorySet(msg.chatId, next);
      // Memory-write hedge (memory-write-silent-fail): if the persist didn't reach disk, tell the user
      // ONCE — otherwise a full/unwritable disk silently forgets this conversation on the next restart
      // with no warning (every other store already hedges its writes). Best-effort + after the answer.
      if (deps.memorySaveOk && !deps.memorySaveOk() && !memWarnedChats.has(msg.chatId)) {
        memWarnedChats.add(msg.chatId);
        await deps.sendMessage(msg.chatId, "⚠️ Heads up — I couldn't save our conversation to disk just now, so I may forget the recent context if I restart. Your reminders/watches are stored separately and unaffected.").catch(() => {});
      }
      // Log a CLEAN answer to the searchable history (answer-history-recall) so "what was that X you
      // found" works later. Skip degraded (partial) replies + binaries (no text answer to recall).
      if (!degraded && !photo && !doc) deps.logAnswer?.(msg.chatId, msg.text, body);
      const elapsedMs = deps.now() - startedAt;
      log(formatTurnLog({ chatId: msg.chatId, steps, tools, elapsedMs, replyChars: out.length, ok: !degraded }));
      deps.recordTurn({ steps, tools, elapsedMs, ok: !degraded, degraded });
    } catch (e) {
      clearProgress();
      const emsg = e instanceof Error ? e.message : String(e);
      console.error("agent error:", emsg);
      const elapsedMs = deps.now() - startedAt;
      log(formatTurnLog({ chatId: msg.chatId, steps: 0, tools: [], elapsedMs, replyChars: 0, ok: false, error: emsg }));
      deps.recordTurn({ steps: 0, tools: [], elapsedMs, ok: false });
      // Never leak the raw error to the user (it can carry hostnames/status/stack text). The raw
      // message is already logged above via formatTurnLog; the user gets a friendly, category-
      // specific line (browser down / model busy / blocked link / generic). m14 degrade-1.
      const friendly = friendlyError(emsg);
      await deps.sendMessage(msg.chatId, friendly);
      // Persist the user turn + the failure note to memory (product-loop): the success path records
      // every turn but the error path did not, so a follow-up ("why did that fail? try again") ran
      // with zero context and the agent re-asked what the user meant. Store the FRIENDLY text (never
      // the raw error — memory feeds back into the prompt) so the next turn is coherent.
      const failNote = `(That attempt failed: ${friendly})`;
      // Append to CURRENT memory, not the pre-run `history` snapshot — a background errand (or interim
      // turn) that wrote to memory while this run was in flight would otherwise be erased by this failure
      // write (sync-turn-clobbers-errand-memory, same race the success path at ~1253 already re-reads for).
      const cur = deps.memoryGet(msg.chatId);
      deps.memorySet(msg.chatId, [...cur, { role: "user", content: msg.text }, { role: "assistant", content: failNote }]);
    }
  }
}
