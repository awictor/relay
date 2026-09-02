// Alert runner (m10 alert-2): run a watched task, compare the result to the stored
// lastValue, and NOTIFY only when it changed (watch-and-notify). First run (no lastValue)
// notifies + seeds. Always updates lastValue. Reused by /run <alert> + the scheduler (a
// scheduled alert fires this). Injectable (runAgent/store fns) for offline unit tests.

import type { LLMClient, LLMMessage } from "./llm.js";
import type { Alert } from "./lib/alerts.js";
import { changed, conditionHolds, extractValue } from "./lib/alerts.js";

export interface AlertRunResult {
  notify: boolean;   // did the value change (or first run)?
  message: string | null; // the text to send when notify (null when unchanged)
  value: string;     // the new observed value (always recorded)
}

export interface AlertRunnerDeps {
  llm: LLMClient;
  runAgent: (userText: string, deps: { llm: LLMClient; context?: string }, history: LLMMessage[]) => Promise<{ reply: string; degraded?: boolean }>;
  formatReply: (text: string) => string;
  setLast: (chatId: number, name: string, value: string) => void;
  // Per-user profile context (product-loop) so a watched "weather near me" uses the saved location.
  contextFor?: (chatId: number) => string;
}

/**
 * Check an alert once. Runs its task, compares to alert.lastValue via changed(threshold):
 *   - first run (no lastValue): notify (baseline), seed lastValue.
 *   - changed: notify with a "🔔 <name> changed" message.
 *   - unchanged: no notify (silent) — but lastValue is still refreshed.
 * Always calls setLast. Never throws — an agent failure returns notify:false so a flaky
 * check doesn't spam; the value is left as-is.
 */
export async function checkAlert(alert: Alert, deps: AlertRunnerDeps): Promise<AlertRunResult> {
  let value: string;
  try {
    const res = await deps.runAgent(alert.task, { llm: deps.llm, context: deps.contextFor?.(alert.chatId) || undefined }, []);
    // A degraded (soft-failure) reply is NOT a real value — comparing it to lastValue would read as a
    // change and spam the user with the failure text. Skip notify, keep lastValue (DEV-0176).
    if (res.degraded) return { notify: false, message: null, value: alert.lastValue ?? "" };
    value = deps.formatReply(res.reply).trim();
  } catch {
    return { notify: false, message: null, value: alert.lastValue ?? "" };
  }

  const firstRun = alert.lastValue === undefined;

  // Predicate alert (below/above/in_stock): edge-triggered — notify when the condition FIRST becomes
  // true (was false/unknown last time), so "below 50k" pings once on the drop, not every check while
  // it stays below. On first run we seed silently unless it's already true.
  if (alert.condition) {
    const nowHolds = conditionHolds(alert.condition, value);
    // Indeterminate reply ("price unavailable right now" — real, not degraded, but no comparable
    // value): DON'T store it as lastValue. Storing it made the next real check see prevHolds=null
    // and re-fire the edge ("🔔 below 50k") even though the value never left the below state. Keep
    // the last GOOD value as the baseline and stay silent this tick (mirrors the degraded guard).
    if (nowHolds === null) return { notify: false, message: null, value: alert.lastValue ?? value };
    const prevHolds = firstRun || alert.lastValue === undefined ? null : conditionHolds(alert.condition, alert.lastValue);
    deps.setLast(alert.chatId, alert.name, value);
    if (nowHolds === true && prevHolds !== true) {
      return { notify: true, message: `🔔 ${alert.name}:\n${value}`, value };
    }
    return { notify: false, message: null, value };
  }

  // Numeric-threshold watch ("... by 1000") + a transient reply with NO comparable number ("price
  // unavailable right now"): don't fire + don't poison the baseline. changed() would fall back to
  // text-diff (numeric-vs-non-numeric = "changed"), spuriously ping, and store the numberless string
  // as lastValue — silently bypassing the threshold across the gap. Keep the last GOOD value + stay
  // silent this tick (mirrors the predicate-refire guard above + the degraded guard). First run with
  // no number still seeds (nothing to protect yet).
  if (!firstRun && alert.threshold !== undefined && extractValue(value) === null) {
    return { notify: false, message: null, value: alert.lastValue ?? value };
  }

  const didChange = firstRun ? true : changed(alert.lastValue!, value, alert.threshold);

  // Advance the stored baseline ONLY when we notify (or on first run). Refreshing lastValue on every
  // check ratcheted the baseline to the newest value, so a "by 1000" watch never saw a cumulative
  // move made in sub-threshold steps (65000 -> 66200 via three <1000 checks fired nothing). Keeping
  // the last-NOTIFIED value as the baseline measures drift against the last value the user saw.
  if (firstRun || didChange) deps.setLast(alert.chatId, alert.name, value);

  if (!didChange) return { notify: false, message: null, value };
  const header = firstRun ? `🔔 ${alert.name} (watching)` : `🔔 ${alert.name} changed`;
  // Show the move, not just the new value: on a real change where BOTH the prior baseline and the new
  // value are numeric, append "was <prev> → now <new> (±<delta>, up/down)" so the ping is a
  // self-contained answer the user doesn't have to go check. Non-numeric (or first-run) stays plain.
  let delta = "";
  if (!firstRun) {
    const pv = extractValue(alert.lastValue!), nv = extractValue(value);
    if (pv !== null && nv !== null && nv !== pv) {
      const d = nv - pv;
      const arrow = d > 0 ? "↑" : "↓";
      const mag = Math.abs(d);
      const num = Number.isInteger(pv) && Number.isInteger(nv) ? String(mag) : mag.toFixed(2);
      delta = `\n(was ${alert.lastValue!.trim()} → now ${value.trim()}; ${arrow}${num})`;
    }
  }
  return { notify: true, message: `${header}:\n${value}${delta}`, value };
}
