// Scheduled-task runner (m4 sched-2): the proactive half of Relay. Polls the
// ScheduleStore for due schedules, runs the agent on each stored task, and texts the
// result to the chat UNPROMPTED — then drops a once / reschedules a daily. This is the
// reactive->autonomous jump. Injectable (store/runAgent/send/format/now + a
// setInterval pair) so it's unit-tested with a mock clock + agent, no live bot.

import type { LLMClient, LLMMessage } from "./llm.js";
import type { Schedule, ScheduleStore } from "./lib/schedule.js";
import { hasSlots, isChain } from "./lib/recipes.js";
import type { AgentEnv } from "./chain-runner.js";

export interface ScheduleRunnerDeps {
  store: ScheduleStore;
  llm: LLMClient;
  runAgent: (userText: string, deps: { llm: LLMClient; context?: string } & AgentEnv, history: LLMMessage[]) => Promise<{ reply: string; steps?: number; tools?: string[]; degraded?: boolean }>;
  // Per-user profile context for proactive runs (product-loop): a scheduled "weather" must use the
  // user's saved location just like the inbound path does. Optional; absent = no context.
  contextFor?: (chatId: number) => string;
  // Clock + units for the proactive run (proactive-runs-datetime-units-blind): so a scheduled "top news
  // today"/daily weather reasons from the real date + the user's units, not the model's training date /
  // a hardcoded °F. Optional; absent = the inbound-parity fields are simply omitted.
  agentEnv?: (chatId: number) => AgentEnv;
  send: (chatId: number, text: string) => Promise<unknown>;
  formatReply: (text: string) => string;
  // The untrimmed + phone-sized views of a reply (sched-reminder-tail-trim). The plain scheduled/recipe
  // agent path used only formatReply (trimmed to 1200), passing the trimmed text as BOTH sent and full to
  // recordSend — so a long scheduled/recipe answer arrived cut off and "more" said "that's the whole
  // answer" (the tail was gone). The digest path was already fixed via fullText; this gives the agent path
  // the same untrimmed source so "more" can page the dropped tail. Optional; absent = trimmed-only (old
  // behavior — no tail recovery for these fires).
  formatReplyParts?: (text: string) => { shown: string; full: string };
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
  // Recipe chaining (recipe-chaining): run a ">>"-chained recipe task as a sequential workflow, same as
  // the inbound /run path — so a SCHEDULED chained recipe doesn't fire the literal "step1 >> step2" as
  // one confused agent task. Returns the final output. Optional; absent -> a chain runs as one task.
  runChain?: (chatId: number, task: string) => Promise<string>;
  // Record a proactive send into the shared last-result cache so a user can reply "more"/"send the
  // link" to a digest/alert ping (proactive-ping-drilldown-cache). Optional.
  // Cache a proactive send for a "more"/"send the link" follow-up. `full` is the UNTRIMMED text; `sentLen`
  // is how many chars actually went out (so "more" can page the dropped tail). Omit sentLen when the whole
  // thing was sent. Passing the trimmed text as `full` broke drilldown on long digests (digest-drilldown-trims-tail).
  recordSend?: (chatId: number, full: string, sentLen?: number) => void;
  // Quiet hours (quiet-hours): given a chat + now, return the epoch-ms to defer a proactive send to
  // (the end of the quiet window) if now is inside it, else 0/undefined = send now. A mis-timed
  // schedule/alert then lands at the window's end instead of waking the user at 3am. Optional.
  quietUntil?: (chatId: number, now: number) => number;
  // Push a schedule's next fire to a specific instant (quiet-hours defer) without advancing its
  // recurrence. Optional; when absent the runner just sends (no defer).
  deferTo?: (id: string, whenMs: number) => void;
  // Failed-watch receipt (failed-watch-receipts): what to tell the user when a RECURRING schedule has
  // failed to fire this many consecutive times (a dead watch otherwise reads as 'no news'). Return the
  // message, or null to stay silent. index wires it for daily/weekly/interval. Optional.
  failStreakNotice?: (s: Schedule, streak: number) => string | null;
  // m14 degrade-4: what to tell the user when a scheduled fire FAILS. Default (absent) is silent
  // (the historical contract — a failed run is a logged miss, not a message, so a misfiring daily
  // can't storm). When provided, the runner sends its return value on failure; return null to stay
  // silent for that case. index wires this to notify ONLY on a "once" task (an explicit "remind me
  // to X" going dark is a black hole) with a friendlyError line, and stay silent on "daily".
  failureNotice?: (s: Schedule, rawError: string) => string | null;
  // Per-task fire timeout (slow-task-starves-due-reminders): injectable timers so a test can drive the
  // timeout deterministically. Absent -> real setTimeout/clearTimeout (unref'd). setTimer returns an
  // opaque handle passed back to clearTimer.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
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
  // A recurring schedule that fails to fire this many consecutive times gets ONE failed-watch receipt
  // (then the streak resets, so it re-notifies only after another N failures — no spam).
  const FAIL_STREAK_NOTIFY = Math.max(2, Number(process.env.RELAY_FAIL_STREAK_NOTIFY) || 3);
  // How long a "once" reminder held back by the hourly cap will keep deferring for a free slot before
  // it's delivered ANYWAY (once-reminder-cap-starvation). An explicit promise slipping this far past
  // its time is worse than one extra send over the anti-spam cap. Default 15 min.
  const ONCE_CAP_GRACE_MS = Math.max(0, Number(process.env.RELAY_ONCE_CAP_GRACE_MS) || 15 * 60_000);
  // Per-task wall-clock ceiling for one fireOne (slow-task-starves-due-reminders). tick() runs due tasks
  // SEQUENTIALLY, so a single hung anvil/LLM run (the agent has step caps + per-fetch timeouts but no
  // overall bound) would block every OTHER chat's due reminder behind it. Race each fireOne against this
  // timeout: a timeout throws into the existing per-task catch (a once retries next tick, a recurring
  // advances), so one stuck task can't starve the batch. 0 disables. Default 90s (a long errand + margin).
  const FIRE_TIMEOUT_MS = (() => {
    const raw = process.env.RELAY_FIRE_TIMEOUT_MS;
    if (raw === undefined || raw === "") return 90_000;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 90_000; // an explicit 0 disables the timeout
  })();
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

  // isCancelled: set true by withFireTimeout when this fire exceeded its wall-clock ceiling. The agent
  // run isn't actually abortable, so it may still resolve LATE — but by then the timeout's catch has
  // already advanced/failed the schedule, so a late finish must NOT also send + complete (that was the
  // duplicate-ping + false-fail-receipt bug). We check it right before every user-visible side effect.
  async function fireOne(s: Schedule, isCancelled: () => boolean = () => false): Promise<void> {
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
    // The UNTRIMMED text behind sendText, cached for a "more"/"link" follow-up so a long digest's dropped
    // tail is recoverable (digest-drilldown-trims-tail). Set where a send might be trimmed; else the send
    // is short and recordSend uses sendText as-is.
    let fullText: string | undefined;
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
        if (isCancelled()) return; // timed out late: the tick's catch already handled this schedule
        checked.commit(); // silent path: baseline already advanced inside checkAlert; noop here
        deps.store.complete(s.id, deps.now());
        log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, alert: alertMatch[1], ok: true, sent: false })}`);
        deps.recordTurn?.({ steps: 0, tools: [], elapsedMs: deps.now() - startedAt, ok: true });
        return;
      }
    } else if (digestMatch && deps.digestRun) {
      const composed = await deps.digestRun(s.chatId, digestMatch[1]!.trim());
      // null = the digest is gone or every member recipe was deleted (empty-digest-fires-noise). Stay
      // silent + advance/drop the schedule rather than pinging a contentless "(empty or was removed)"
      // briefing on cadence — mirrors the deleted-recipe path above.
      if (composed === null) {
        if (isCancelled()) return; // timed out late: the tick's catch already handled this schedule
        deps.store.complete(s.id, deps.now());
        log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, digest: digestMatch[1], ok: true, sent: false, empty: true })}`);
        deps.recordTurn?.({ steps: 0, tools: [], elapsedMs: deps.now() - startedAt, ok: true });
        return;
      }
      res = { reply: composed };
      sendText = deps.formatReply(res.reply); // digest text already labeled; no reminder prefix
      fullText = composed; // untrimmed source, so "more"/"link" can page the tail formatReply dropped
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
      // Reminder-only (reminder-only-no-agent): a pure personal to-do ("take my meds") just re-sends
      // the note — running the browser agent on it appended a confused 20-40s browse/refusal. Echo and
      // return. Recipes never set reminderOnly, so this only hits plain "remind me to X" schedules.
      if (s.reminderOnly && !recipeMatch) {
        // If this fire already timed out (a stalled deps.send past the 90s ceiling), the tick's catch has
        // advanced/failed the schedule — a late finish must NOT also send + complete, or the highest-trust
        // reminder ("take my meds") double-pings (mirrors the guard on the main/alert/digest paths).
        if (isCancelled()) { log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, dropped: "timed_out_late_finish" })}`); return; }
        const echo = `⏰ Reminder: ${taskToRun}`;
        await deps.send(s.chatId, echo);
        deps.recordSend?.(s.chatId, echo);
        noteSend(s.chatId, deps.now());
        deps.store.complete(s.id, deps.now());
        log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, reminderOnly: true, ok: true })}`);
        deps.recordTurn?.({ steps: 0, tools: [], elapsedMs: deps.now() - startedAt, ok: true });
        return;
      }
      // A chained recipe task ("step >> step") runs as a sequential workflow, matching the inbound /run
      // path (recipe-chaining) — not the literal string as one agent task. runChain already formats.
      if (recipeMatch && deps.runChain && isChain(taskToRun)) {
        const chained = await deps.runChain(s.chatId, taskToRun);
        res = { reply: chained };
      } else {
        res = await deps.runAgent(taskToRun, { llm: deps.llm, context: deps.contextFor?.(s.chatId) || undefined, ...deps.agentEnv?.(s.chatId) }, []);
      }
      // Trimmed body for the phone-sized send + the UNTRIMMED body so "more" can page the tail
      // (sched-reminder-tail-trim). Without formatReplyParts, fall back to trimmed-only (old behavior).
      const parts = deps.formatReplyParts?.(res.reply);
      const body = parts?.shown ?? deps.formatReply(res.reply);
      const fullBody = parts?.full ?? body;
      // A degraded reply (agent ran out of steps / no answer, DEV-0176) is a soft failure, not a real
      // proactive result. Marking the unprompted message as partial keeps a flaky daily from pushing a
      // failure string as if it were the briefing, and the ok:!degraded below keeps it out of the
      // success metric (DEV-0187 — schedule-runner is the 4th runAgent consumer of the degraded flag).
      const prefix = res.degraded ? "⚠️ Partial — I ran low on steps.\n\n" : "";
      // Show the human task, not the "recipe:<name>" marker, in the reminder header.
      const shown = recipeMatch ? taskToRun : s.task;
      sendText = `${label}: ${shown}\n\n${prefix}${body}`;
      // Only cache an untrimmed full when it actually differs from what we send (a long answer was
      // trimmed) — else fullText stays undefined and recordSend uses sendText as-is (short answer).
      if (fullBody !== body) fullText = `${label}: ${shown}\n\n${prefix}${fullBody}`;
    }
    // If this fire already timed out, the tick's catch has advanced/failed the schedule — a late finish
    // must NOT also send + complete (duplicate ping + double-advance). Drop the result silently.
    if (isCancelled()) { log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, dropped: "timed_out_late_finish" })}`); return; }
    await deps.send(s.chatId, sendText!); // non-null here (alert-silent path returned early)
    alertCommit?.(); // send succeeded -> NOW advance the alert baseline (a throw above skips this)
    // Cache the UNTRIMMED text + how much was actually sent, so "more"/"send the link" can page a long
    // digest's dropped tail (digest-drilldown-trims-tail). fullText is set where a send may be trimmed.
    deps.recordSend?.(s.chatId, fullText ?? sendText!, sendText!.length);
    noteSend(s.chatId, deps.now());
    // complete() returns whether the state reached disk. A false for a "once" means its delivered-mark
    // may not have persisted, so it could be re-read after a restart (once-complete-ignores-persist) —
    // it's guarded against re-firing THIS session by the in-memory delivered flag, but log so a bad disk
    // is visible to an operator rather than silently risking a duplicate ping.
    const completed = deps.store.complete(s.id, deps.now());
    if (!completed) log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: true, warn: "complete_persist_failed" })}`);
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

  // Race a fire against the per-task wall-clock ceiling. On timeout, reject so the caller's catch runs
  // (once retries / recurring advances) instead of blocking the whole tick on a stuck run. The underlying
  // fireOne isn't cancelled (it'll settle + be ignored), but the batch moves on. No-op when disabled.
  // A test/host may inject setTimer/clearTimer; otherwise real timers, unref'd so a pending one can't
  // keep the process alive.
  // Runs `make(isCancelled)` (the fire) with a wall-clock ceiling. On timeout: flip the cancel flag
  // (so the still-running fire's later side-effects are dropped, not duplicated) and reject so the
  // tick's catch advances/fails the schedule. No-op when disabled.
  function withFireTimeout(make: (isCancelled: () => boolean) => Promise<void>): Promise<void> {
    let cancelled = false;
    const p = make(() => cancelled);
    if (!FIRE_TIMEOUT_MS) return p;
    const set = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clr = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    return new Promise<void>((resolve, reject) => {
      const h = set(() => { cancelled = true; reject(new Error(`fire timed out after ${FIRE_TIMEOUT_MS}ms`)); }, FIRE_TIMEOUT_MS);
      if (typeof (h as { unref?: () => void })?.unref === "function") (h as { unref: () => void }).unref();
      p.then(
        (v) => { clr(h); resolve(v); },
        (e) => { clr(h); reject(e); },
      );
    });
  }

  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    let fired = 0;
    try {
      const due = deps.store.dueNow(deps.now());
      for (const s of due) {
        // Snooze (snooze-automations): a paused schedule is skipped WITHOUT firing or completing while
        // now < pausedUntil, so the setup survives travel/noise intact. Once the pause passes, the store
        // clears it lazily on the next resume; here we just skip. A recurring schedule that stayed due
        // through its pause fires on the next tick after resume (resume() pulls a stale dueMs to now).
        if (s.pausedUntil !== undefined) {
          if (deps.now() < s.pausedUntil) {
            log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, skipped: "paused" })}`);
            continue;
          }
          deps.store.clearExpiredPause?.(s.id, deps.now()); // timed snooze elapsed -> auto-resume + tidy flag
        }
        // Anti-spam: if this chat is over its hourly cap, don't send now. A DAILY occurrence is
        // dropped (advance to tomorrow) — it re-fires on its own and must not storm. But a "once"
        // reminder is an explicit, single promise ("remind me to take my meds at 3pm"); completing
        // it here deleted it forever with only a log line — a black hole. Instead DEFER it: leave it
        // due (don't complete) so a later tick, once the rolling-hour cap frees a slot, delivers it.
        // An alert: check is edge-triggered — it only SENDS on a real change, so it self-throttles and
        // must NOT be dropped by the send-cap. Dropping the CHECK (not just a send) meant a "below 50k"
        // crossing during a capped hour was never evaluated and never re-fired (sendcap-drops-alert-
        // checks). Let it fall through to fireOne; alertCheck stays silent unless the value changed, and
        // the caller's post-send commit still gates the baseline advance. A genuine burst of alert
        // notifications is rare (each needs a distinct change) so this can't storm like a misfiring daily.
        const isAlertCheck = /^alert:/.test(s.task);
        // A digest is user-requested CONTENT ("my morning briefing"), not spammy repetition — dropping
        // its occurrence when the hour is capped makes the relied-upon briefing silently no-show for the
        // day (digest-dropped-over-cap). So a digest gets the same defer-then-force grace as a once
        // (leave it due, retry when a slot frees; force it past the grace window rather than lose it),
        // not the plain-daily drop. A plain daily/weather still drops its occurrence (it re-fires on its
        // own cadence + isn't a bundle the user explicitly assembled).
        const isDigest = /^digest:/.test(s.task);
        const graceEligible = s.kind === "once" || isDigest;
        if (overCap(s.chatId, deps.now()) && !isAlertCheck) {
          if (graceEligible) {
            // Defer past the cap rather than drop it. BUT a chat with many recurring watches can stay
            // over-cap indefinitely, starving it past its time forever (once-reminder-cap-starvation):
            // once overdue beyond the grace window, deliver it ANYWAY — the promise/briefing outweighs
            // anti-spam. Under the grace window, keep deferring for a free slot.
            if (deps.now() - s.dueMs <= ONCE_CAP_GRACE_MS) {
              log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, deferred: "rate_cap" })}`);
              continue; // keep it due in the store; retried next tick
            }
            log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: true, over_cap_forced: Math.round((deps.now() - s.dueMs) / 60000) })}`);
            // fall through to fire it despite the cap
          } else {
            log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, skipped: "rate_cap" })}`);
            safeComplete(s); // plain daily: drop this occurrence, it advances to the next
            continue;
          }
        }
        // Quiet hours: a proactive send landing in the chat's quiet window is deferred to the window's
        // end (bump this schedule's dueMs there) rather than waking the user. Skips the deferral for a
        // schedule that's ALREADY due at/after the quiet-end (avoids a defer loop). Needs both deps.
        // An alert: check is EXEMPT (quiet-hours-defers-alert-check) — deferring the CHECK, not just the
        // send, meant an edge-triggered watch ("below 50k") that crossed at 2am and reverted by the 8am
        // quiet-end was evaluated only at 8am (reverted -> crossing lost forever). Mirrors the send-cap
        // exemption above: run the check on cadence so the crossing is seen. An alert only SENDS on a real
        // change (rare, and a user-requested event, not recurring noise), so letting it through can't
        // storm the quiet window the way a daily/digest would; missing the crossing is the worse failure.
        // An explicit wall-clock "once" ("wake me at 6am", "remind me tomorrow 7:00") is EXEMPT from the
        // quiet-hours defer (quiet-hours-once-alarm): the user named that exact instant on purpose, so
        // pushing it to the window's end defeats an alarm / delays a time-critical reminder. Quiet hours
        // exist to silence RECURRING noise (dailies/digests) + relative onces, not a promise pinned to a
        // clock time. clockTime marks the wall-clock onces; a relative "in 20 min" once has no such flag
        // and still defers (its instant is incidental, not chosen).
        const isClockOnce = s.kind === "once" && s.clockTime === true;
        if (deps.quietUntil && deps.deferTo && !isAlertCheck && !isClockOnce) {
          const until = deps.quietUntil(s.chatId, deps.now());
          if (until > deps.now() && s.dueMs < until) {
            deps.deferTo(s.id, until);
            log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: true, deferred: "quiet_hours", until })}`);
            continue;
          }
        }
        // Bound each fire so one hung task can't starve the rest of the due batch (slow-task-starves-
        // due-reminders). A timeout rejects into the catch below — a once retries, a recurring advances.
        try { await withFireTimeout((isCancelled) => fireOne(s, isCancelled)); fired++; deps.store.resetFailures(s.id); } // success clears any failure streak
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
            // Recurring (daily/weekly/interval): count consecutive failures; after FAIL_STREAK_NOTIFY
            // send ONE failed-watch receipt (a dead watch otherwise reads as 'no news') + reset the
            // streak so it re-notifies only after another N failures. Subject to the anti-spam cap.
            const streak = deps.store.recordFailure(s.id);
            log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, fail_streak: streak, error: raw.slice(0, 120) })}`);
            if (streak >= FAIL_STREAK_NOTIFY && deps.failStreakNotice && !overCap(s.chatId, deps.now())) {
              const notice = deps.failStreakNotice(s, streak);
              if (notice) {
                try { await deps.send(s.chatId, notice); noteSend(s.chatId, deps.now()); } catch (sendErr) { deps.onError?.(sendErr); }
              }
              deps.store.resetFailures(s.id); // re-notify only after another N failures
            }
            safeComplete(s); // advance the recurring schedule to its next occurrence
            continue;        // handled here; skip the shared failureNotice/safeComplete below
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
