// Graceful shutdown for the long-poll worker. On SIGTERM/SIGINT (docker stop, pm2
// restart, Ctrl-C) we stop polling for new updates and exit cleanly, so a redeploy
// doesn't kill the process mid-fetch. Memory is already durable — MemoryStore persists
// synchronously on every turn (writeFileSync) — so there's no in-flight buffer to flush;
// the job here is to stop accepting work and end the process 0. Idempotent (a second
// signal during shutdown is ignored). Pure wiring so it's unit-testable.

export interface ShutdownDeps {
  stopPolling: () => void;
  log: (msg: string) => void;
  exit: (code: number) => void;
  // Optional final flush (DEV-0041): e.g. emit the last metrics window before exit. Periodic-only
  // logging otherwise loses the partial window on redeploy. Best-effort — a throw must not block exit.
  onShutdown?: () => void;
}

/** Returns a handler that runs the shutdown sequence at most once. */
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  let shuttingDown = false;
  return function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log(`[shutdown] ${signal} received — stopping poller, exiting cleanly`);
    try {
      deps.stopPolling();
    } catch (e) {
      deps.log(`[shutdown] stopPolling error (ignored): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (deps.onShutdown) {
      try {
        deps.onShutdown();
      } catch (e) {
        deps.log(`[shutdown] onShutdown error (ignored): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    deps.exit(0);
  };
}

/** Register the handler on the usual termination signals. */
export function installSignalHandlers(handler: (signal: string) => void): void {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => handler(sig));
  }
}

export interface CrashDeps {
  log: (msg: string) => void;
  // Best-effort final flush before dying (same intent as ShutdownDeps.onShutdown). A throw here
  // must not prevent the exit.
  onFatal?: () => void;
  // Injectable for tests; defaults to process.exit. A fatal error exits NON-ZERO (1) so a supervisor
  // (pm2/docker/systemd) sees the crash and restarts, unlike the clean 0 of a signal shutdown.
  exit?: (code: number) => void;
}

/**
 * Last-breath handlers for the 24/7 worker. Without these, a stray throw or a rejected promise in a
 * non-awaited path kills the process with NO log line — the deploy just goes dark, undiagnosable.
 * Logs the error (name + message + truncated stack), runs the best-effort flush, then exits 1.
 * Registered on BOTH `uncaughtException` and `unhandledRejection`.
 */
export function installCrashHandlers(deps: CrashDeps): void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let dying = false;
  const onFatal = (kind: string, err: unknown): void => {
    if (dying) return; // a rejection during the exception handler must not re-enter
    dying = true;
    const e = err instanceof Error ? err : new Error(String(err));
    const stack = (e.stack ?? `${e.name}: ${e.message}`).slice(0, 1000);
    deps.log(`[fatal] ${kind}: ${stack}`);
    if (deps.onFatal) {
      try {
        deps.onFatal();
      } catch (flushErr) {
        deps.log(`[fatal] onFatal error (ignored): ${flushErr instanceof Error ? flushErr.message : String(flushErr)}`);
      }
    }
    exit(1);
  };
  process.on("uncaughtException", (err) => onFatal("uncaughtException", err));
  process.on("unhandledRejection", (reason) => onFatal("unhandledRejection", reason));
}
