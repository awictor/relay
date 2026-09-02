// Alert runner (m10 alert-2): run a watched task, compare the result to the stored
// lastValue, and NOTIFY only when it changed (watch-and-notify). First run (no lastValue)
// notifies + seeds. Always updates lastValue. Reused by /run <alert> + the scheduler (a
// scheduled alert fires this). Injectable (runAgent/store fns) for offline unit tests.

import type { LLMClient, LLMMessage } from "./llm.js";
import type { Alert } from "./lib/alerts.js";
import { changed, conditionHolds } from "./lib/alerts.js";

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
    const prevHolds = firstRun || alert.lastValue === undefined ? null : conditionHolds(alert.condition, alert.lastValue);
    deps.setLast(alert.chatId, alert.name, value);
    if (nowHolds === true && prevHolds !== true) {
      return { notify: true, message: `🔔 ${alert.name}:\n${value}`, value };
    }
    return { notify: false, message: null, value };
  }

  const didChange = firstRun ? true : changed(alert.lastValue!, value, alert.threshold);
  deps.setLast(alert.chatId, alert.name, value);

  if (!didChange) return { notify: false, message: null, value };
  const header = firstRun ? `🔔 ${alert.name} (watching)` : `🔔 ${alert.name} changed`;
  return { notify: true, message: `${header}:\n${value}`, value };
}
