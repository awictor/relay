// The per-message handler wiring, factored out of index.ts so it's unit-testable with
// injected deps (no live Telegram/LLM/anvil). index.ts builds the real deps; tests pass
// fakes. Flow: slash-command short-circuit -> rate limit -> config check -> agent ->
// SMS-format reply -> persist memory -> per-turn [out]/[metrics] logging.

import type { InboundMessage } from "./telegram.js";
import type { LLMMessage, LLMClient } from "./llm.js";
import { runAgent, type AgentDeps } from "./agent.js";
import { formatReply } from "./lib/format-reply.js";
import { formatTurnLog } from "./lib/turn-log.js";
import { friendlyError } from "./lib/failure.js";

export interface HandlerDeps {
  llm: LLMClient;
  memoryGet: (chatId: number) => LLMMessage[];
  memorySet: (chatId: number, history: LLMMessage[]) => void;
  sendMessage: (chatId: number, text: string) => Promise<unknown>;
  // Send an image (screenshot tool, DEV-0027). Optional: when absent, a photo result is dropped
  // and only the text reply goes out (older wiring stays valid).
  sendPhoto?: (chatId: number, bytes: Uint8Array, caption?: string) => Promise<unknown>;
  // Send a document (pdf tool, DEV-0032). Optional: absent -> a doc result falls back to text.
  sendDocument?: (chatId: number, bytes: Uint8Array, filename?: string, caption?: string) => Promise<unknown>;
  sendTyping: (chatId: number) => Promise<unknown>;
  handleCommand: (text: string) => string | null;
  // Clear this chat's stored history (/reset). Returns true if there was anything to clear.
  memoryClear: (chatId: number) => boolean;
  // One-line health reply for /status (uptime + turns + browser reachability). Optional:
  // when absent, /status falls through to the agent (older wiring stays valid).
  statusLine?: () => string;
  // /sites reply (m30): the hosts the cookie jar authorizes the agent for — NAMES only, never
  // values. Optional; absent -> /sites falls through to the agent.
  sitesLine?: () => string;
  // Scheduled/proactive tasks (m4 sched-3). All optional so older wiring stays valid; when
  // absent, a "remind me" message just falls through to the normal agent.
  scheduleAdd?: (chatId: number, text: string, now: number) => { ok: true; kind: string; task: string; whenMs: number } | { ok: false; reason: "unparsed" | "capped" };
  scheduleList?: (chatId: number) => Array<{ id: string; kind: string; task: string; dueMs: number }>;
  scheduleCancel?: (chatId: number, which: string) => { removed: number };
  // Saved recipes (m7 recipe-2). All optional so older wiring stays valid. recipeSave parses a
  // "save <name>: <task>" message (null if it isn't one); recipeResolve returns a saved task by
  // name (null if unknown); recipeList/recipeForget manage them.
  recipeSave?: (chatId: number, text: string) => { ok: true; name: string } | { ok: false; reason: "unparsed" | "capped" };
  recipeResolve?: (chatId: number, text: string) => { name: string; task: string } | null; // parses a run command + looks up
  recipeList?: (chatId: number) => Array<{ name: string; task: string; schedule?: string }>;
  recipeForget?: (chatId: number, name: string) => boolean;
  // Schedule a saved recipe to run on a cadence (m7 recipe-3): "schedule <name> every morning".
  // Resolves the recipe's task + registers it with the scheduler. Optional.
  recipeSchedule?: (chatId: number, name: string, whenClause: string, now: number) =>
    { ok: true; kind: string } | { ok: false; reason: "unknown" | "unparsed" | "capped" };
  // Digests (m9 digest-3): bundle recipes into one briefing. All optional.
  digestDefine?: (chatId: number, text: string) => { ok: true; name: string; members: number } | { ok: false; reason: "unparsed" | "capped" };
  digestList?: (chatId: number) => Array<{ name: string; members: string[]; schedule?: string }>;
  digestForget?: (chatId: number, name: string) => boolean;
  // Is <name> a digest for this chat? (so /run + schedule dispatch digest vs recipe).
  isDigest?: (chatId: number, name: string) => boolean;
  // Run a digest NOW -> the composed briefing text (sent by the handler). null if unknown.
  digestRun?: (chatId: number, name: string) => Promise<string | null>;
  digestSchedule?: (chatId: number, name: string, whenClause: string, now: number) =>
    { ok: true; kind: string } | { ok: false; reason: "unknown" | "unparsed" | "capped" };
  // Change-alerts (m10 alert-3): "watch <name>: <task>" defines + auto-schedules a check.
  // All optional. alertDefine parses + stores + schedules (default cadence); returns the cadence.
  alertDefine?: (chatId: number, text: string, now: number) => { ok: true; name: string } | { ok: false; reason: "unparsed" | "capped" };
  alertList?: (chatId: number) => Array<{ name: string; task: string; lastValue?: string; threshold?: number }>;
  alertForget?: (chatId: number, name: string) => boolean;
  checkRateLimit: (chatId: number) => { allowed: boolean; retryAfterSec?: number };
  redactText: (text: string) => string;
  hasModelKey: () => boolean;
  recordTurn: (t: { steps: number; tools: string[]; elapsedMs: number; ok: boolean }) => void;
  // Count a slash-command invocation (DEV-0108). Optional so existing callers/tests need not pass it;
  // commands still short-circuit before the agent — this only tallies which are used.
  recordCommand?: (name: string) => void;
  now: () => number;
  // Optional override so tests don't hit the real agent loop.
  runAgentFn?: (userText: string, deps: AgentDeps, history: LLMMessage[]) => Promise<{ reply: string; steps: number; tools: string[]; photo?: Uint8Array; doc?: Uint8Array }>;
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
    // DEV-0108: tally slash-command usage (a separate metrics axis; commands still short-circuit
    // before the agent below). Any leading /token counts — /help, /start, /reset, /forget-digest, etc.
    if (first && first.startsWith("/")) deps.recordCommand?.(first);
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

    // /schedules: list this chat's pending scheduled tasks. No agent run.
    if (first === "/schedules" && deps.scheduleList) {
      const list = deps.scheduleList(msg.chatId);
      if (!list.length) { await deps.sendMessage(msg.chatId, "No scheduled tasks. Try: \"remind me to stretch in 20 min\"."); return; }
      const lines = list.map((s, i) => `${i + 1}. [${s.id}] ${s.kind === "daily" ? "daily" : "once"} — ${s.task}`);
      await deps.sendMessage(msg.chatId, `Your scheduled tasks:\n${lines.join("\n")}\n\nCancel one with /cancel <id> (or /cancel all).`);
      return;
    }

    // /cancel <id|all>: remove scheduled task(s). No agent run.
    if (first === "/cancel" && deps.scheduleCancel) {
      const which = msg.text.trim().split(/\s+/).slice(1).join(" ").trim() || "all";
      const { removed } = deps.scheduleCancel(msg.chatId, which);
      await deps.sendMessage(msg.chatId, removed > 0 ? `Cancelled ${removed} task${removed === 1 ? "" : "s"}.` : "Nothing matched — check /schedules for the id.");
      return;
    }

    // Natural scheduling: "remind me to X in 10m", "every morning tell me Y". Detected before
    // the agent so a schedule request is stored, not executed now. Falls through if unparsed.
    if (deps.scheduleAdd && /\b(remind me|every day|every morning|every evening|every night|daily)\b|\bin \d+\s*(min|hour|day)/i.test(msg.text)) {
      const r = deps.scheduleAdd(msg.chatId, msg.text, deps.now());
      if (r.ok) {
        await deps.sendMessage(msg.chatId, `Got it — I'll ${r.kind === "daily" ? "do this daily" : "remind you"}: "${r.task}". Manage with /schedules.`);
        return;
      }
      if (r.reason === "capped") { await deps.sendMessage(msg.chatId, "You've hit the limit of scheduled tasks — cancel one with /schedules first."); return; }
      // reason === "unparsed": fall through to the agent (it wasn't really a schedule request).
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
      const removed = name ? deps.recipeForget(msg.chatId, name) : false;
      await deps.sendMessage(msg.chatId, removed ? `Forgot "${name}".` : "No recipe by that name — see /recipes.");
      return;
    }

    // /alerts: list watch-and-notify alerts. No agent run.
    if (first === "/alerts" && deps.alertList) {
      const list = deps.alertList(msg.chatId);
      if (!list.length) { await deps.sendMessage(msg.chatId, "No alerts. Set one: \"watch btc: price of bitcoin when it changes by 1000\" — I'll only ping you when it moves."); return; }
      const lines = list.map((a) => `• ${a.name}${a.threshold ? ` (±${a.threshold})` : ""} — ${a.task}${a.lastValue ? ` [last: ${a.lastValue.slice(0, 40)}]` : ""}`);
      await deps.sendMessage(msg.chatId, `Your alerts:\n${lines.join("\n")}\n\nRemove with /forget-alert <name>.`);
      return;
    }

    // /forget-alert <name>: remove an alert. No agent run.
    if (first === "/forget-alert" && deps.alertForget) {
      const name = msg.text.trim().split(/\s+/).slice(1).join(" ").trim();
      const removed = name ? deps.alertForget(msg.chatId, name) : false;
      await deps.sendMessage(msg.chatId, removed ? `Stopped watching "${name}".` : "No alert by that name — see /alerts.");
      return;
    }

    // "watch <name>: <task>" / "alert me <name>: <task>" -> define + auto-schedule a change-alert.
    if (deps.alertDefine && /^\s*(?:alert(?:\s+me)?|watch)\s+[^:]+:\s*\S/i.test(msg.text)) {
      const r = deps.alertDefine(msg.chatId, msg.text, deps.now());
      if (r.ok) { await deps.sendMessage(msg.chatId, `Watching "${r.name}" — I'll only message you when it changes. See /alerts.`); return; }
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
      const removed = name ? deps.digestForget(msg.chatId, name) : false;
      await deps.sendMessage(msg.chatId, removed ? `Forgot digest "${name}".` : "No digest by that name — see /digests.");
      return;
    }

    // "define digest <name>: a, b, c" -> store a digest. No agent run.
    if (deps.digestDefine && /^\s*(?:define\s+)?digest\s+[^:]+:\s*\S/i.test(msg.text)) {
      const r = deps.digestDefine(msg.chatId, msg.text);
      if (r.ok) { await deps.sendMessage(msg.chatId, `Saved digest "${r.name}" (${r.members} recipe${r.members === 1 ? "" : "s"}). Run it with /run ${r.name}.`); return; }
      if (r.reason === "capped") { await deps.sendMessage(msg.chatId, "You've hit the digest limit — /forget-digest one first."); return; }
      // unparsed: fall through
    }

    // "schedule <name> <when>" -> run a saved digest OR recipe on a cadence (digest first). No agent run.
    if ((deps.recipeSchedule || deps.digestSchedule) && /^\s*schedule\s+\S+/i.test(msg.text)) {
      const m = msg.text.trim().match(/^schedule\s+(.+?)\s+((?:every|daily|in|tomorrow|at)\b.*)$/i);
      if (m) {
        const name = m[1]!.trim();
        const isDig = deps.isDigest?.(msg.chatId, name) && deps.digestSchedule;
        const r = isDig ? deps.digestSchedule!(msg.chatId, name, m[2]!, deps.now())
                        : deps.recipeSchedule?.(msg.chatId, name, m[2]!, deps.now());
        if (r?.ok) { await deps.sendMessage(msg.chatId, `Scheduled "${name}" to run ${r.kind === "daily" ? "daily" : "once"}. Manage with /schedules.`); return; }
        const why = r?.reason === "unknown" ? "No recipe or digest by that name." : r?.reason === "capped" ? "You've hit the scheduled-task limit — /cancel one first." : "I couldn't parse that time. Try \"schedule <name> every morning\".";
        await deps.sendMessage(msg.chatId, why); return;
      }
    }

    // "save <name>: <task>" -> store a recipe. No agent run.
    if (deps.recipeSave && /^\s*save(\s+recipe)?\s+[^:]+:\s*\S/i.test(msg.text)) {
      const r = deps.recipeSave(msg.chatId, msg.text);
      if (r.ok) { await deps.sendMessage(msg.chatId, `Saved recipe "${r.name}". Run it anytime with /run ${r.name}.`); return; }
      if (r.reason === "capped") { await deps.sendMessage(msg.chatId, "You've hit the recipe limit — /forget one first."); return; }
      // unparsed: fall through
    }

    // "/run <name>" / "run <name>" -> DIGEST (compose+send now) or RECIPE (rewrite to its task,
    // fall through to the agent). Digest checked first so a digest name wins.
    if ((deps.recipeResolve || deps.digestRun) && /^(\/run\b|run\s+)/i.test(msg.text)) {
      const nameOnly = msg.text.trim().replace(/^\/run\b\s*/i, "").replace(/^run\s+(recipe\s+)?/i, "").trim();
      if (nameOnly && deps.isDigest?.(msg.chatId, nameOnly) && deps.digestRun) {
        const composed = await deps.digestRun(msg.chatId, nameOnly);
        await deps.sendMessage(msg.chatId, composed ?? "That digest is empty or gone — see /digests.");
        return;
      }
      const hit = deps.recipeResolve?.(msg.chatId, msg.text);
      if (hit) { msg = { ...msg, text: hit.task }; } // run the saved task via the agent path below
      else if (/^\/run\b/i.test(msg.text)) { await deps.sendMessage(msg.chatId, "No recipe or digest by that name — see /recipes or /digests."); return; }
      // natural "run ..." with no match: fall through to the agent as a normal message.
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
      const { reply, steps, tools, photo, doc } = await runIt(msg.text, { llm: deps.llm }, history);
      const out = formatReply(reply);
      // If the agent produced a binary (screenshot image or PDF), send it first with the reply as
      // caption, then the text if the caption overflowed. Falls back to text-only when nothing was
      // produced or the sender isn't wired.
      if (photo && deps.sendPhoto) {
        await deps.sendPhoto(msg.chatId, photo, out.slice(0, 1024));
        if (out.length > 1024) await deps.sendMessage(msg.chatId, out);
      } else if (doc && deps.sendDocument) {
        await deps.sendDocument(msg.chatId, doc, "page.pdf", out.slice(0, 1024));
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
      // Never leak the raw error to the user (it can carry hostnames/status/stack text). The raw
      // message is already logged above via formatTurnLog; the user gets a friendly, category-
      // specific line (browser down / model busy / blocked link / generic). m14 degrade-1.
      await deps.sendMessage(msg.chatId, friendlyError(emsg));
    }
  };
}
