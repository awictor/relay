// DEV-0024: /status health line. Pure formatter so it's unit-testable without a live bot.
// A user texts /status and gets one plain line confirming the bot is alive + connected.

export interface StatusInfo {
  uptimeMs: number;      // ms since process start
  turns: number;         // total turns handled (from Metrics)
  anvilOk: boolean;      // last-known anvil reachability
  topCommand?: { name: string; count: number }; // DEV-0109: busiest slash command, omitted if none
  fail?: number;         // DEV-0180: hard-failure turns (agent threw), omitted/0 → no clause
  degraded?: number;     // DEV-0180: degraded turns (partial answers), omitted/0 → no clause
}

// DEV-0025: /status reachability was boot-seeded only, so it went stale when the browser dropped
// after start. This keeps a cached flag fresh by re-probing on an interval. Pure/injectable: the
// caller passes the probe (anvilLive) + a setInterval/clearInterval pair, so it's testable without
// real timers or a live anvil. current() reads the cached flag; tick() runs one probe + updates it.
export interface AnvilPinger {
  current(): boolean;                 // cached last-known reachability
  tick(): Promise<void>;              // one probe, updates the cache (used by tests + the interval)
  start(): void;                      // begin the interval (no-op if periodMs <= 0)
  stop(): void;                       // clear the interval (safe to call when not started)
}

export interface AnvilPingerDeps {
  probe: () => Promise<boolean>;                              // e.g. anvilLive
  periodMs: number;                                           // 0 (or <=0) disables the interval
  initial?: boolean;                                          // seed value (default false)
  setInterval?: (fn: () => void, ms: number) => unknown;      // injectable for tests
  clearInterval?: (h: unknown) => void;
  onError?: (e: unknown) => void;                             // a failed probe shouldn't throw
}

export function makeAnvilPinger(deps: AnvilPingerDeps): AnvilPinger {
  let ok = deps.initial ?? false;
  let handle: unknown = null;
  const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  async function tick(): Promise<void> {
    try { ok = await deps.probe(); }
    catch (e) { deps.onError?.(e); } // keep the last-known value on a probe failure
  }

  return {
    current: () => ok,
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

/** Human uptime: "3d 4h", "4h 12m", "12m", "45s". Always the two largest non-zero units. */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** One-line status reply for /status. Plain text (phone-friendly), no markdown.
 * Prefix reflects health: ✅ when the browser is connected, ⚠️ when it's down (the
 * process is up but degraded — browsing tools will fail), so the emoji never contradicts
 * the body. */
export function formatStatus(info: StatusInfo): string {
  const browser = info.anvilOk ? "browser connected" : "browser DOWN";
  const turns = info.turns === 1 ? "1 task" : `${info.turns} tasks`;
  const prefix = info.anvilOk ? "✅" : "⚠️";
  // DEV-0109: surface the busiest slash command when one has been used (omitted otherwise).
  const topCmd = info.topCommand ? ` · top cmd ${info.topCommand.name} x${info.topCommand.count}` : "";
  // DEV-0180: surface the health breakdown (hard failures + partial/degraded answers) ONLY when
  // there's something to report, so a healthy bot's line stays clean. fail and degraded are distinct
  // classes (DEV-0179) — a crash vs an answered-but-partial turn — so name them separately.
  const parts: string[] = [];
  if (info.fail && info.fail > 0) parts.push(`${info.fail} failed`);
  if (info.degraded && info.degraded > 0) parts.push(`${info.degraded} partial`);
  const health = parts.length ? ` · ${parts.join(", ")}` : "";
  return `${prefix} Relay up ${formatUptime(info.uptimeMs)} · ${turns} handled${health} · ${browser}${topCmd}.`;
}
