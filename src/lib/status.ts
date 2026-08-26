// DEV-0024: /status health line. Pure formatter so it's unit-testable without a live bot.
// A user texts /status and gets one plain line confirming the bot is alive + connected.

export interface StatusInfo {
  uptimeMs: number;      // ms since process start
  turns: number;         // total turns handled (from Metrics)
  anvilOk: boolean;      // last-known anvil reachability
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
  return `${prefix} Relay up ${formatUptime(info.uptimeMs)} · ${turns} handled · ${browser}.`;
}
