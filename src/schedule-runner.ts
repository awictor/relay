// Scheduled-task runner (m4 sched-2): the proactive half of Relay. Polls the
// ScheduleStore for due schedules, runs the agent on each stored task, and texts the
// result to the chat UNPROMPTED — then drops a once / reschedules a daily. This is the
// reactive->autonomous jump. Injectable (store/runAgent/send/format/now + a
// setInterval pair) so it's unit-tested with a mock clock + agent, no live bot.

import type { LLMClient, LLMMessage } from "./llm.js";
import type { Schedule, ScheduleStore } from "./lib/schedule.js";

export interface ScheduleRunnerDeps {
  store: ScheduleStore;
  llm: LLMClient;
  runAgent: (userText: string, deps: { llm: LLMClient }, history: LLMMessage[]) => Promise<{ reply: string; steps?: number; tools?: string[] }>;
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
  recordTurn?: (t: { steps: number; tools: string[]; elapsedMs: number; ok: boolean }) => void;
  // Anti-spam (m8 pobs-2): max proactive sends per chat per rolling hour. A misfiring daily
  // (or many due at once) must not flood a user. 0/absent = unlimited. Default set by index.
  maxPerChatPerHour?: number;
  // Digests (m9 digest-3): a scheduled digest stores the task "digest:<name>"; when it fires,
  // run the digest to a composed message instead of the agent. Optional.
  digestRun?: (chatId: number, name: string) => Promise<string | null>;
  // Alerts (m10 alert-3): a scheduled alert stores "alert:<name>"; on fire, check it and get
  // back the notify message ONLY if it changed (null = silent, don't send). Optional.
  alertCheck?: (chatId: number, name: string) => Promise<string | null>;
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
    let res: { reply: string; steps?: number; tools?: string[] };
    let sendText: string | null;
    if (alertMatch && deps.alertCheck) {
      // Alert: only sends when the watched value changed (null = silent). Always completes
      // (a daily alert reschedules) so it keeps watching.
      sendText = await deps.alertCheck(s.chatId, alertMatch[1]!.trim());
      res = { reply: sendText ?? "" };
      if (sendText === null) {
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
      res = await deps.runAgent(s.task, { llm: deps.llm }, []);
      const body = deps.formatReply(res.reply);
      const label = s.kind === "daily" ? "⏰ Daily" : "⏰ Reminder";
      sendText = `${label}: ${s.task}\n\n${body}`;
    }
    await deps.send(s.chatId, sendText!); // non-null here (alert-silent path returned early)
    noteSend(s.chatId, deps.now());
    deps.store.complete(s.id, deps.now());
    // Observability (m8): structured proactive-run line + Metrics record (same as inbound).
    const elapsedMs = deps.now() - startedAt;
    const steps = res.steps ?? 0;
    const tools = res.tools ?? [];
    log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, taskLen: s.task.length, steps, ms: Math.max(0, elapsedMs), ok: true })}`);
    deps.recordTurn?.({ steps, tools, elapsedMs, ok: true });
  }

  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    let fired = 0;
    try {
      const due = deps.store.dueNow(deps.now());
      for (const s of due) {
        // Anti-spam: if this chat is over its hourly cap, skip the send + complete the schedule
        // (drop once / advance daily) so it doesn't storm — log the skip instead of firing.
        if (overCap(s.chatId, deps.now())) {
          log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, skipped: "rate_cap" })}`);
          deps.store.complete(s.id, deps.now());
          continue;
        }
        try { await fireOne(s); fired++; }
        catch (e) {
          deps.onError?.(e);
          log(`[proactive] ${JSON.stringify({ id: s.id, kind: s.kind, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) })}`);
          deps.recordTurn?.({ steps: 0, tools: [], elapsedMs: 0, ok: false });
          // Don't leave a failed once-task to retry forever every tick — complete it so it
          // drops (daily still advances). A failed run is reported by the miss, not a storm.
          deps.store.complete(s.id, deps.now());
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
