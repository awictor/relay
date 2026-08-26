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
    deps.exit(0);
  };
}

/** Register the handler on the usual termination signals. */
export function installSignalHandlers(handler: (signal: string) => void): void {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => handler(sig));
  }
}
