// Scheduled-task runner (m4 sched-2): the proactive half of Relay. Polls the
// ScheduleStore for due schedules, runs the agent on each stored task, and texts the
// result to the chat UNPROMPTED — then drops a once / reschedules a daily. This is the
// reactive->autonomous jump. Injectable (store/runAgent/send/format/now + a
// setInterval pair) so it's unit-tested with a mock clock + agent, no live bot.

import type { LLMClient, LLMMessage } from "./llm.js";
import type { Schedule, ScheduleStore } from "./lib/schedule.js";
import { hasSlots } from "./lib/recipes.js";

export interface ScheduleRunnerDeps {
  store: ScheduleStore;
  llm: LLMClient;
  runAgent: (userText: string, deps: { llm: LLMClient; context?: string }, history: LLMMessage[]) => Promise<{ reply: string; steps?: number; tools?: string[]; degraded?: boolean }>;
  // Per-user profile context for proactive runs (product-loop): a scheduled "weather" must use the
  // user's saved location just like the inbound path does. Optional; absent = no context.
  contextFor?: (chatId: number) => string;
  send: (chatId: number, text: string) => Promise<unknown>;
  formatReply: (text: string) => string;
  now: () => number;
  periodMs: number;                                       // 0 (or <=0) disables the interval
  setInterval?: (fn: () => void, ms: number) => unknown;  // injectable for tests
  clearInterval?: (h: unknown) => void;
  log?: (msg: string) => void;
  onError?: (e: unknown) => void;
  // Observability (m8): record each proactive fire into the same Metrics as inbound turns,
  // so /status + [metrics] count them. Optional (older wiring stays valid).
  recordTurn?: (t: { steps: number; tools: string[]; elapsedMs: number; ok: boolean; degraded?: boolean }) => void;
  // Anti-spam (m8 pobs-2): max proactive sends per chat per rolling hour. A misfiring daily
  // (or many due at once) must not flood a user. 0/absent = unlimited. Default set by index.
  maxPerChatPerHour?: number;
  // Digests (m9 digest-3): a scheduled digest stores the task "digest:<name>"; when it fires,
  // run the digest to a composed message instead of the agent. Optional.
  digestRun?: (chatId: number, name: string) => Promise<string | null>;
  // Alerts (m10 alert-3): a scheduled alert stores "alert:<name>"; on fire, check it and get back
  // the notify message ONLY if it changed (null = silent) + a commit() to advance the baseline, which
  // MUST be called only AFTER a successful send so a failed send re-fires next check. Optional.
  alertCheck?: (chatId: number, name: string) => Promise<{ message: string | null; commit: () => void }>;
  // Recipes: a scheduled recipe stores "recipe:<name>"; on fire, resolve the recipe's CURRENT task by
  // name (null if it was deleted) and run it as the agent task — so editing the recipe changes what
  // fires + forgetting it stops it (a stable marker, unlike storing the raw task). Optional.
  recipeResolveTask?: (chatId: number, name: string) => string | null;
  // Record a proactive send into the shared last-result cache so a user can reply "more"/"send the
  // link" to a digest/alert ping (proactive-ping-drilldown-cache). Optional.
  recordSend?: (chatId: number, text: string) => void;
  // Quiet hours (quiet-hours): given a chat + now, return the epoch-ms to defer a proactive send to
  // (the end of the quiet window) if now is inside it, else 0/undefined = send now. A mis-timed
  // schedule/alert then lands at the window's end instead of waking the user at 3am. Optional.
  quietUntil?: (chatId: number, now: number) => number;
  // Push a schedule's next fire to a specific instant (quiet-hours defer) without advancing its
  // recurrence. Optional; when absent the runner just sends (no defer).
  deferTo?: (id: string, whenMs: number) => void;
  // m14 degrade-4: what to tell the user when a scheduled fire FAILS. Default (absent) is silent
  // (the historical contract — a failed run is a logged miss, not a message, so a misfiring daily
  // can't storm). When provided, the runner sends its return value on failure; return null to stay
  // silent for that case. index wires this to notify ONLY on a "once" task (an explicit "remind me
  // to X" going dark is a black hole) with a friendlyError line, and stay silent on "daily".
  failureNotice?: (s: Schedule, rawError: string) => string | null;
}

export interface ScheduleRunner {
  tick(): Promise<number>;   // fire all currently-due schedules; returns how many fired
  start(): void;
  stop(): void;
}

export function makeScheduleRunner(deps: ScheduleRunnerDeps): ScheduleRunner {
  let handle: unknown = null;
  let running = false; // guard against overlapping ticks (a slow agent must not double-fire)
  const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const log = deps.log ?? (() => {});
  const HOUR = 3_600_000;
  // A "once" reminder that keeps failing at fire time is retried on later ticks up to this many total
  // attempts, then given up (notify + drop) so a permanently-broken task can't loop forever.
  const MAX_FIRE_ATTEMPTS = Math.max(1, Number(process.env.RELAY_ONCE_MAX_ATTEMPTS) || 5);
  const cap = deps.maxPerChatPerHour ?? 0;
  const sendTimes = new Map<number, number[]>(); // chatId -> recent send epochs (rolling hour)

  // True if this chat is at/over the hourly proactive-send cap (prunes old timestamps).
  function overCap(chatId: number, now: number): boolean {
    if (cap <= 0) return false;
    const times = (sendTimes.get(chatId) ?? []).filter((t) => now - t < HOUR);
    sendTimes.set(chatId, times);
    return times.length >= cap;
  }
  function noteSend(chatId: number, now: number): void {
    if (cap <= 0) return;
    const times = sendTimes.get(chatId) ?? [];
    times.push(now);
    sendTimes.set(chatId, times);
  }

  async function fireOne(s: Schedule): Promise<void> {
    // A scheduled task is a fresh, contextless agent run (no chat history) whose reply is
    // pushed to the user. Prefix so an unprompted message is understood as a reminder.
    const startedAt = deps.now();
    // A scheduled digest carries "digest:<name>" — run the digest to a composed briefing
    // instead of the agent. Otherwise a normal scheduled/recipe agent run.
    const digestMatch = s.task.match(/^digest:(.+)$/);
    const alertMatch = s.task.match(/^alert:(.+)$/);
    const recipeMatch = s.task.match(/^recipe:(.+)$/);
    let res: { reply: string; steps?: number; tools?: string[]; degraded?: boolean };
    let sendText: string | null;
    // For an alert: advance the baseline ONLY after the send below succeeds (a failed send would
    // otherwise eat the crossing forever). Held here, called right after deps.send.
    let alertCommit: (() => void) | null = null;
    if (alertMatch && deps.alertCheck) {
      // Alert: only sends when the watched value changed (null = silent). Always completes
      // (a daily alert reschedules) so it keeps watching.
      const checked = await deps.alertCheck(s.chatId, alertMatch[1]!.trim());
      sendText = checked.message;
      alertCommit = checked.commit;
      res = { reply: sendText ?? "" };
      if (sendText === null) {
        checked.commit(); // silent path: baseline already advanced inside checkAlert; noop here
        deps.store.complete(s.id, deps.now());
        log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, alert: alertMatch[1], ok: true, sent: false })}`);
        deps.recordTurn?.({ steps: 0, tools: [], elapsedMs: deps.now() - startedAt, ok: true });
        return;
      }
    } else if (digestMatch && deps.digestRun) {
      const composed = await deps.digestRun(s.chatId, digestMatch[1]!.trim());
      res = { reply: composed ?? "(digest is empty or was removed)" };
      sendText = deps.formatReply(res.reply); // digest text already labeled; no reminder prefix
    } else {
      // A scheduled recipe carries "recipe:<name>" — resolve its CURRENT task by name at fire time
      // (so editing the recipe changes what fires, and a deleted recipe stops firing). A plain task
      // (legacy schedules / reminders) runs as-is.
      let taskToRun = s.task;
      let label = s.kind === "once" ? "⏰ Reminder" : "⏰ Recurring";
      if (recipeMatch && deps.recipeResolveTask) {
        const resolved = deps.recipeResolveTask(s.chatId, recipeMatch[1]!.trim());
        if (resolved === null) {
          // Recipe was deleted after scheduling — stop firing (drop once / advance daily), no send.
          deps.store.complete(s.id, deps.now());
          log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, recipe: recipeMatch[1], ok: true, sent: false, gone: true })}`);
          deps.recordTurn?.({ steps: 0, tools: [], elapsedMs: deps.now() - startedAt, ok: true });
          return;
        }
        // A recipe EDITED to add a {slot} after it was scheduled would fire the literal "{slot}" (the
        // schedule-time hasSlots guard can't catch a later edit). Skip firing rather than push garbage
        // unprompted; the recurring schedule stays so it self-heals if the slot is removed later.
        if (hasSlots(resolved)) {
          deps.store.complete(s.id, deps.now());
          log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, recipe: recipeMatch[1], ok: true, sent: false, slotted: true })}`);
          deps.recordTurn?.({ steps: 0, tools: [], elapsedMs: deps.now() - startedAt, ok: true });
          return;
        }
        taskToRun = resolved;
        label = `${label} (${recipeMatch[1]!.trim()})`;
      }
      res = await deps.runAgent(taskToRun, { llm: deps.llm, context: deps.contextFor?.(s.chatId) || undefined }, []);
      const body = deps.formatReply(res.reply);
      // A degraded reply (agent ran out of steps / no answer, DEV-0176) is a soft failure, not a real
      // proactive result. Marking the unprompted message as partial keeps a flaky daily from pushing a
      // failure string as if it were the briefing, and the ok:!degraded below keeps it out of the
      // success metric (DEV-0187 — schedule-runner is the 4th runAgent consumer of the degraded flag).
      const prefix = res.degraded ? "⚠️ Partial — I ran low on steps.\n\n" : "";
      // Show the human task, not the "recipe:<name>" marker, in the reminder header.
      const shown = recipeMatch ? taskToRun : s.task;
      sendText = `${label}: ${shown}\n\n${prefix}${body}`;
    }
    await deps.send(s.chatId, sendText!); // non-null here (alert-silent path returned early)
    alertCommit?.(); // send succeeded -> NOW advance the alert baseline (a throw above skips this)
    deps.recordSend?.(s.chatId, sendText!); // cache for a "more"/"send the link" reply to this ping
    noteSend(s.chatId, deps.now());
    deps.store.complete(s.id, deps.now());
    // Observability (m8): structured proactive-run line + Metrics record (same as inbound).
    const elapsedMs = deps.now() - startedAt;
    const steps = res.steps ?? 0;
    const tools = res.tools ?? [];
    // A degraded agent reply is not a success (DEV-0187). alert/digest paths leave res.degraded
    // undefined → ok:true, unchanged; only the plain agent branch can set it.
    const ok = !res.degraded;
    log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, taskLen: s.task.length, steps, ms: Math.max(0, elapsedMs), ok })}`);
    deps.recordTurn?.({ steps, tools, elapsedMs, ok, ...(res.degraded ? { degraded: true } : {}) });
  }

  // m14 degrade-2: completing a schedule persists to disk; if that throws (unwritable store),
  // it must NOT escape the per-schedule handling and abort the rest of the due batch. Swallow +
  // log so one bad write can't lose every other due task this tick.
  function safeComplete(s: Schedule): void {
    try { deps.store.complete(s.id, deps.now()); }
    catch (e) {
      deps.onError?.(e);
      log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, error: "complete_failed:" + (e instanceof Error ? e.message : String(e)).slice(0, 80) })}`);
    }
  }

  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    let fired = 0;
    try {
      const due = deps.store.dueNow(deps.now());
      for (const s of due) {
        // Anti-spam: if this chat is over its hourly cap, don't send now. A DAILY occurrence is
        // dropped (advance to tomorrow) — it re-fires on its own and must not storm. But a "once"
        // reminder is an explicit, single promise ("remind me to take my meds at 3pm"); completing
        // it here deleted it forever with only a log line — a black hole. Instead DEFER it: leave it
        // due (don't complete) so a later tick, once the rolling-hour cap frees a slot, delivers it.
        if (overCap(s.chatId, deps.now())) {
          if (s.kind === "once") {
            log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, deferred: "rate_cap" })}`);
            continue; // keep it in the store; retried next tick
          }
          log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, skipped: "rate_cap" })}`);
          safeComplete(s); // daily: drop this occurrence, it advances to the next
          continue;
        }
        // Quiet hours: a proactive send landing in the chat's quiet window is deferred to the window's
        // end (bump this schedule's dueMs there) rather than waking the user. Skips the deferral for a
        // schedule that's ALREADY due at/after the quiet-end (avoids a defer loop). Needs both deps.
        if (deps.quietUntil && deps.deferTo) {
          const until = deps.quietUntil(s.chatId, deps.now());
          if (until > deps.now() && s.dueMs < until) {
            deps.deferTo(s.id, until);
            log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: true, deferred: "quiet_hours", until })}`);
            continue;
          }
        }
        try { await fireOne(s); fired++; }
        catch (e) {
          deps.onError?.(e);
          const raw = e instanceof Error ? e.message : String(e);
          deps.recordTurn?.({ steps: 0, tools: [], elapsedMs: 0, ok: false });
          // A "once" reminder that fails on a TRANSIENT hiccup (anvil/LLM down for a tick) must not
          // be deleted forever — it's an explicit single promise. Retry it on later ticks up to a
          // cap; only give up (notify + drop) after MAX_FIRE_ATTEMPTS so a permanently-broken task
          // can't loop forever. A daily just advances (its next occurrence retries tomorrow).
          if (s.kind === "once") {
            const attempts = deps.store.recordFailure(s.id);
            if (attempts < MAX_FIRE_ATTEMPTS) {
              log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, deferred_retry: attempts, error: raw.slice(0, 120) })}`);
              continue; // leave it due; a later tick retries
            }
            log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, gave_up_after: attempts, error: raw.slice(0, 120) })}`);
          } else {
            log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, error: raw.slice(0, 120) })}`);
          }
          // m14 degrade-4: tell the user the run failed (default silent). For a "once" this fires only
          // after the retries are exhausted (above). Best-effort + subject to the anti-spam cap; a send
          // failure here must not stop us completing the schedule below.
          if (deps.failureNotice && !overCap(s.chatId, deps.now())) {
            const notice = deps.failureNotice(s, raw);
            if (notice) {
              try { await deps.send(s.chatId, notice); noteSend(s.chatId, deps.now()); }
              catch (sendErr) { deps.onError?.(sendErr); }
            }
          }
          // Drop the once (retries exhausted) / advance the daily.
          safeComplete(s);
        }
      }
      if (fired) log(`[schedule] fired ${fired} due task(s)`);
    } finally {
      running = false;
    }
    return fired;
  }

  return {
    tick,
    start() {
      if (deps.periodMs <= 0 || handle !== null) return;
      handle = setI(() => { void tick(); }, deps.periodMs);
    },
    stop() {
      if (handle !== null) { clearI(handle); handle = null; }
    },
  };
}
