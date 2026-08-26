// DEV-0111: the per-turn metrics flush (index.ts, every METRICS_EVERY turns) never fires during a
// period of only slash-commands / zero agent turns, so command usage over time is invisible in logs.
// This is a wall-clock heartbeat: on an interval it calls emit() (log the [metrics] line) + snapshot()
// (persist for offline `relay status`). Pure/injectable — the caller passes emit/snapshot + a
// setInterval/clearInterval pair, so it's unit-tested with a mock clock, no real timers. Mirrors
// makeAnvilPinger (src/lib/status.ts).

export interface MetricsHeartbeat {
  tick(): void;   // one emit+snapshot (used by tests + the interval)
  start(): void;  // begin the interval (no-op if periodMs <= 0 or already started)
  stop(): void;   // clear the interval
}

export interface MetricsHeartbeatDeps {
  emit: () => void;                                           // e.g. () => console.log(metrics.format())
  snapshot?: () => void;                                      // e.g. persist metrics.summary()
  periodMs: number;                                           // 0 (or <=0) disables the interval
  setInterval?: (fn: () => void, ms: number) => unknown;      // injectable for tests
  clearInterval?: (h: unknown) => void;
  onError?: (e: unknown) => void;                             // a throwing emit must not kill the timer
}

export function makeMetricsHeartbeat(deps: MetricsHeartbeatDeps): MetricsHeartbeat {
  let handle: unknown = null;
  const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  function tick(): void {
    // emit + snapshot are observability — a failure must never crash the worker or stop the beat.
    try { deps.emit(); } catch (e) { deps.onError?.(e); }
    try { deps.snapshot?.(); } catch (e) { deps.onError?.(e); }
  }

  return {
    tick,
    start() {
      if (deps.periodMs <= 0 || handle !== null) return;
      handle = setI(() => { tick(); }, deps.periodMs);
    },
    stop() {
      if (handle !== null) { clearI(handle); handle = null; }
    },
  };
}
