// Alert runner (m10 alert-2): run a watched task, compare the result to the stored
// lastValue, and NOTIFY only when it changed (watch-and-notify). First run (no lastValue)
// notifies + seeds. Always updates lastValue. Reused by /run <alert> + the scheduler (a
// scheduled alert fires this). Injectable (runAgent/store fns) for offline unit tests.

import type { LLMClient, LLMMessage } from "./llm.js";
import type { Alert } from "./lib/alerts.js";
import { changed, conditionHolds, extractValue, extractListItems, feedItemKey } from "./lib/alerts.js";
import { mapPool } from "./lib/pool.js";
import type { AgentEnv } from "./chain-runner.js";

// Cap concurrent watchlist member checks so a multi-member watchlist can't stampede the shared anvil
// browser pool (each member is a full agent run + browser session) — the same bound the digest runner
// + inbound dispatch use. Env-tunable; default 3.
const WATCHLIST_CONCURRENCY = Math.max(1, Number(process.env.RELAY_WATCHLIST_CONCURRENCY) || 3);

export interface AlertRunResult {
  notify: boolean;   // did the value change (or first run)?
  message: string | null; // the text to send when notify (null when unchanged)
  value: string;     // the new observed value (always recorded)
  // Persist the baseline advance THIS check decided on. The caller MUST call it — but only AFTER a
  // successful send when notify is true (call it immediately on the silent path). Deferring the
  // commit past the send means a transient send failure leaves the baseline un-advanced, so the
  // crossing re-fires next check instead of being silently eaten (alert-notify-send-fail). A no-op
  // when this check shouldn't advance the baseline (indeterminate reply / unchanged threshold).
  commit: () => void;
}

export interface AlertRunnerDeps {
  llm: LLMClient;
  runAgent: (userText: string, deps: { llm: LLMClient; context?: string } & AgentEnv, history: LLMMessage[]) => Promise<{ reply: string; degraded?: boolean }>;
  formatReply: (text: string) => string;
  setLast: (chatId: number, name: string, value: string) => void;
  // Clock + units for the proactive check (proactive-runs-datetime-units-blind): a watched "weather"/
  // "today's top story" reasons from the real date + the user's units. Optional.
  agentEnv?: (chatId: number) => AgentEnv;
  // Feed-watch (new-item-feed-watch): merge newly-reported item keys into the alert's seen-set. Called
  // by the caller's commit() only after a successful send (so a failed send re-reports next check).
  recordSeen?: (chatId: number, name: string, keys: string[]) => void;
  // Time series (watch-time-series): record a numeric data point for this alert on every check that
  // yields an extractable value, so "how has X moved this week" can be answered from stored data.
  // Optional; absent -> no series accumulated.
  recordPoint?: (chatId: number, name: string, v: number, t: number) => void;
  // Per-user profile context (product-loop) so a watched "weather near me" uses the saved location.
  contextFor?: (chatId: number) => string;
  // Trigger-to-action (trigger-to-action-alerts): when an alert with a `then` recipe fires, run that
  // recipe and return its result text to append to the notification (or null if the recipe is gone /
  // failed — the base alert still sends). Resolves the recipe's CURRENT task by name at fire time.
  // Optional; absent -> `then` is ignored (plain notify).
  runThen?: (chatId: number, recipeName: string) => Promise<string | null>;
  // Current epoch ms for stamping time-series points (watch-time-series). Optional; default Date.now.
  now?: () => number;
  // Watchlist (watchlists): record the members that changed this check (by label) so an unchanged
  // member doesn't re-fire. Called by the caller's post-send commit. Optional.
  setMemberLasts?: (chatId: number, name: string, updates: Array<{ label: string; value: string }>) => void;
  // Follow-feed subscriptions (follow-feed-subscriptions): fetch a keyless feed source's item titles
  // DIRECTLY (RSS/Reddit/HN/YouTube) instead of running the agent. Returns [] on any failure (the feed
  // path then stays silent, never a false "new item"). Absent -> a feedSource alert falls back to agent.
  fetchFeed?: (src: NonNullable<Alert["feedSource"]>) => Promise<Array<{ title: string; id?: string }>>;
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
  const noop = () => {};

  // Trigger-to-action (trigger-to-action-alerts): append the `then` recipe's output to a fired ping.
  // Hoisted above the watchlist branch so a WATCHLIST with a `then` runs it too (watchlist-then-dropped).
  const withThen = async (message: string): Promise<string> => {
    if (!alert.then || !deps.runThen) return message;
    try {
      const out = (await deps.runThen(alert.chatId, alert.then))?.trim();
      return out ? `${message}\n\n▶ ${alert.then}:\n${out}` : message;
    } catch { return message; }
  };

  // Watchlist (watchlists): run each member sub-task, compare to its own last value, and send ONE
  // grouped ping of only the members that CHANGED. First run seeds every member silently (no dump).
  // Member-last advances are deferred to the caller's post-send commit (a failed send re-reports).
  if (alert.members?.length) {
    const ctx = deps.contextFor?.(alert.chatId) || undefined;
    // Bounded fan-out: a watchlist can have up to MAX_WATCHLIST_MEMBERS members, each a full agent run +
    // browser session. mapPool caps in-flight at WATCHLIST_CONCURRENCY so it can't exhaust the shared
    // anvil pool (the DEV-0140 bound the digest runner + inbound dispatch already use). Per-member
    // try/catch keeps one failure from sinking the batch; order is preserved.
    const results = await mapPool(alert.members, WATCHLIST_CONCURRENCY, async (mem) => {
      try {
        const res = await deps.runAgent(mem.task, { llm: deps.llm, context: ctx, ...deps.agentEnv?.(alert.chatId) }, []);
        if (res.degraded) return { mem, value: null as string | null };
        return { mem, value: deps.formatReply(res.reply).trim() };
      } catch { return { mem, value: null as string | null }; }
    });
    const firstRunWl = alert.members.every((m) => m.last === undefined);
    const updates: Array<{ label: string; value: string }> = [];
    const changedLines: string[] = [];
    for (const { mem, value } of results) {
      if (value === null) continue; // couldn't read this member this tick — leave its baseline
      // Numberless-reply guard (alert-numberless-flap): if this member's prior value tracked a NUMBER but
      // the new reply has none ("N/A", "price unavailable" — real, not degraded), don't flag it changed
      // and DON'T overwrite its baseline. Otherwise changed() falls back to text-diff, false-pings, and
      // stores the numberless string, so the next real check re-fires + the tracked value is lost.
      if (!firstRunWl && mem.last !== undefined && extractValue(mem.last, mem.task) !== null && extractValue(value, mem.task) === null) {
        continue; // keep the last GOOD value as this member's baseline; stay silent for it
      }
      updates.push({ label: mem.label, value });
      if (!firstRunWl && mem.last !== undefined && changed(mem.last, value, undefined, mem.task)) {
        changedLines.push(`• ${mem.label}: ${value}`);
      }
    }
    const commit = () => deps.setMemberLasts?.(alert.chatId, alert.name, updates);
    if (firstRunWl) { commit(); return { notify: false, message: null, value: "", commit: noop }; } // seed silently
    if (!changedLines.length) {
      // No member changed -> nothing to send. BUT a member that had no baseline yet (never seeded — its
      // first check errored, so it recovered on a later quiet tick) must be seeded NOW, or the
      // `mem.last !== undefined` change-guard keeps it out of changedLines FOREVER: a dead watch with no
      // signal (watchlist-member-never-seeds). Commit only the fresh seeds immediately (no send to gate).
      const seeds = updates.filter((u) => alert.members!.find((m) => m.label === u.label)?.last === undefined);
      if (seeds.length) deps.setMemberLasts?.(alert.chatId, alert.name, seeds);
      return { notify: false, message: null, value: "", commit: noop };
    }
    const shown = changedLines.slice(0, 10);
    const more = changedLines.length > shown.length ? `\n…and ${changedLines.length - shown.length} more` : "";
    const base = `🔔 ${alert.name} — ${changedLines.length} update${changedLines.length === 1 ? "" : "s"}:\n${shown.join("\n")}${more}`;
    const message = await withThen(base); // run the `then` recipe on a watchlist change too (watchlist-then-dropped)
    return { notify: true, message, value: "", commit };
  }

  // Follow-feed subscriptions (follow-feed-subscriptions): a keyless feed source is fetched DIRECTLY
  // (RSS/Reddit/HN/YouTube) — no agent run — and pushed through the SAME new-item/seen-set logic as an
  // agent-driven feed watch. A fetch that returns no items leaves the baseline untouched + stays silent
  // (never a false "new" and never wiping the seen-set on a transient outage). Falls back to the agent
  // path if fetchFeed isn't wired.
  if (alert.feedSource && deps.fetchFeed) {
    let items: Array<{ title: string; id?: string }>;
    try { items = await deps.fetchFeed(alert.feedSource); } catch { items = []; }
    if (!items.length) return { notify: false, message: null, value: alert.lastValue ?? "", commit: noop };
    // Dedup by a STABLE id (link/guid) when the source gives one, else the normalized title
    // (feed-dedup-title-only): keying on title alone dropped a recurring headline ("Daily Discussion")
    // or two same-titled posts forever. Prefix so an id-key can't collide with a title-key.
    const keyOf = (it: { title: string; id?: string }) => it.id ? `id:${it.id}` : `t:${feedItemKey(it.title)}`;
    const seen = new Set(alert.seen ?? []);
    const freshByKey = new Map<string, string>(); // dedupKey -> display title
    for (const it of items) {
      const k = keyOf(it);
      if (!it.title || seen.has(k) || freshByKey.has(k)) continue;
      freshByKey.set(k, it.title);
    }
    const allKeys = items.map(keyOf);
    if (alert.seen === undefined) {
      deps.recordSeen?.(alert.chatId, alert.name, allKeys);
      deps.setLast(alert.chatId, alert.name, items[0]?.title ?? ""); // mark checked (seen !== undefined next time)
      return { notify: false, message: null, value: items[0]?.title ?? "", commit: noop };
    }
    if (freshByKey.size === 0) return { notify: false, message: null, value: alert.lastValue ?? "", commit: noop };
    const freshEntries = [...freshByKey.entries()]; // [key, displayText], insertion order
    const shownEntries = freshEntries.slice(0, 10);
    const more = freshEntries.length > shownEntries.length ? `\n…and ${freshEntries.length - shownEntries.length} more` : "";
    const header = freshEntries.length === 1 ? `🔔 ${alert.name}: 1 new` : `🔔 ${alert.name}: ${freshEntries.length} new`;
    const message = await withThen(`${header}\n${shownEntries.map(([, s]) => `• ${s}`).join("\n")}${more}`);
    // Record ONLY the items we actually SHOWED as seen (feed-seen-swallows-overflow): recording all
    // fresh keys when we only displayed the first 10 meant items 11+ were marked seen but never shown —
    // silently lost. The un-shown items stay unseen so they surface (and get shown) on the next check.
    return { notify: true, message, value: shownEntries[0]?.[1] ?? "", commit: () => deps.recordSeen?.(alert.chatId, alert.name, shownEntries.map(([k]) => k)) };
  }

  // The baseline advance for this value, run only by the caller (after a successful send on notify).
  const advance = (v: string) => () => deps.setLast(alert.chatId, alert.name, v);
  let value: string;
  try {
    const res = await deps.runAgent(alert.task, { llm: deps.llm, context: deps.contextFor?.(alert.chatId) || undefined, ...deps.agentEnv?.(alert.chatId) }, []);
    // A degraded (soft-failure) reply is NOT a real value — comparing it to lastValue would read as a
    // change and spam the user with the failure text. Skip notify, keep lastValue (DEV-0176).
    if (res.degraded) return { notify: false, message: null, value: alert.lastValue ?? "", commit: noop };
    value = deps.formatReply(res.reply).trim();
  } catch {
    return { notify: false, message: null, value: alert.lastValue ?? "", commit: noop };
  }

  const firstRun = alert.lastValue === undefined;

  // Time series (watch-time-series): record a numeric point on every successful check with an
  // extractable value (feed watches have no scalar). Independent of whether we notify — the series is
  // for "how has X moved", not the alert trigger. Deferred nothing: safe to record now (a check happened).
  if (!alert.feed && deps.recordPoint) {
    const num = extractValue(value, alert.task);
    if (num !== null) deps.recordPoint(alert.chatId, alert.name, num, (deps.now ?? Date.now)());
  }

  // Trigger-to-action (trigger-to-action-alerts): when this alert fires AND has a `then` recipe, run it
  // and append its result to the notification. Failures/absence just leave the base message unchanged
  // (the alert still notifies). Called at each notify site below.
  // Feed-watch (new-item-feed-watch): the task returns a LIST; notify only about entries we haven't
  // seen before. First run (seen undefined) seeds the whole list SILENTLY so setup doesn't dump every
  // current item as "new". After that, only genuinely-new item keys fire, and the seen-set advance is
  // deferred to the caller's post-send commit (a failed send re-reports next check).
  if (alert.feed) {
    const items = extractListItems(value);
    const seen = new Set(alert.seen ?? []);
    // Map key -> display text (first occurrence wins) so we report the human line, dedupe by key.
    const freshByKey = new Map<string, string>();
    for (const it of items) {
      const k = feedItemKey(it);
      if (!k || seen.has(k) || freshByKey.has(k)) continue;
      freshByKey.set(k, it);
    }
    const allKeys = items.map(feedItemKey).filter(Boolean);
    if (alert.seen === undefined) {
      // Seed silently: record every current item as seen, don't notify.
      deps.recordSeen?.(alert.chatId, alert.name, allKeys);
      deps.setLast(alert.chatId, alert.name, value); // mark checked (seen !== undefined next time)
      return { notify: false, message: null, value, commit: noop };
    }
    if (freshByKey.size === 0) {
      // Nothing new — stay silent, but still record (no-op) so the store reflects the check.
      return { notify: false, message: null, value, commit: noop };
    }
    const freshEntries = [...freshByKey.entries()]; // [key, displayText], insertion order
    const shownEntries = freshEntries.slice(0, 10);
    const more = freshEntries.length > shownEntries.length ? `\n…and ${freshEntries.length - shownEntries.length} more` : "";
    const header = freshEntries.length === 1 ? `🔔 ${alert.name}: 1 new` : `🔔 ${alert.name}: ${freshEntries.length} new`;
    const message = await withThen(`${header}\n${shownEntries.map(([, s]) => `• ${s}`).join("\n")}${more}`);
    // Record ONLY the SHOWN items as seen (feed-seen-swallows-overflow): recording all fresh keys while
    // displaying just the first 10 marked items 11+ seen without ever showing them — silently lost. The
    // un-shown items stay unseen so they surface + get shown on the next check.
    return { notify: true, message, value, commit: () => deps.recordSeen?.(alert.chatId, alert.name, shownEntries.map(([k]) => k)) };
  }

  // Predicate alert (below/above/in_stock): edge-triggered — notify when the condition FIRST becomes
  // true (was false/unknown last time), so "below 50k" pings once on the drop, not every check while
  // it stays below. On first run we seed silently unless it's already true.
  if (alert.condition) {
    const nowHolds = conditionHolds(alert.condition, value, alert.task);
    // Indeterminate reply ("price unavailable right now" — real, not degraded, but no comparable
    // value): DON'T store it as lastValue. Storing it made the next real check see prevHolds=null
    // and re-fire the edge ("🔔 below 50k") even though the value never left the below state. Keep
    // the last GOOD value as the baseline and stay silent this tick (mirrors the degraded guard).
    if (nowHolds === null) return { notify: false, message: null, value: alert.lastValue ?? value, commit: noop };
    const prevHolds = firstRun || alert.lastValue === undefined ? null : conditionHolds(alert.condition, alert.lastValue, alert.task);
    if (nowHolds === true && prevHolds !== true) {
      // Notify: DEFER the baseline advance to the caller's post-send commit, so a failed send leaves
      // prevHolds unchanged + the edge re-fires next check instead of being eaten.
      return { notify: true, message: await withThen(`🔔 ${alert.name}:\n${value}`), value, commit: advance(value) };
    }
    // Silent: safe to advance the baseline now (no send to gate on).
    deps.setLast(alert.chatId, alert.name, value);
    return { notify: false, message: null, value, commit: noop };
  }

  // Numeric-threshold watch ("... by 1000") + a transient reply with NO comparable number ("price
  // unavailable right now"): don't fire + don't poison the baseline. changed() would fall back to
  // text-diff (numeric-vs-non-numeric = "changed"), spuriously ping, and store the numberless string
  // as lastValue — silently bypassing the threshold across the gap. Keep the last GOOD value + stay
  // silent this tick (mirrors the predicate-refire guard above + the degraded guard). First run with
  // no number still seeds (nothing to protect yet).
  // Extends beyond the threshold case (alert-numberless-flap): ANY change-alert whose last value tracked
  // a NUMBER but whose new reply has none ("price unavailable") must not fire or poison the baseline —
  // changed() would fall back to text-diff (numeric-vs-nonnumeric = "changed"), spuriously ping, and store
  // the numberless string. Keep the last GOOD value + stay silent this tick. A genuinely non-numeric watch
  // (top HN story) is unaffected: its lastValue has no extractable number, so the guard doesn't trigger.
  if (!firstRun && alert.lastValue !== undefined && extractValue(alert.lastValue, alert.task) !== null && extractValue(value, alert.task) === null) {
    return { notify: false, message: null, value: alert.lastValue, commit: noop };
  }

  const didChange = firstRun ? true : changed(alert.lastValue!, value, alert.threshold, alert.task);
  // Capture the prior baseline STRING before any advance — setLast mutates alert.lastValue in place
  // (the store hands back the same object), so reading it after would see the NEW value and the delta
  // below would compute pv===nv (never renders). Snapshot now.
  const prevValue = alert.lastValue;

  // Unchanged: nothing to send, so advance the baseline now (keeps the last-notified value; refreshing
  // on every check would ratchet it and hide cumulative sub-threshold drift).
  if (!didChange) { return { notify: false, message: null, value, commit: noop }; }
  const header = firstRun ? `🔔 ${alert.name} (watching)` : `🔔 ${alert.name} changed`;
  // Show the move, not just the new value: on a real change where BOTH the prior baseline and the new
  // value are numeric, append "was <prev> → now <new> (±<delta>, up/down)" so the ping is a
  // self-contained answer the user doesn't have to go check. Non-numeric (or first-run) stays plain.
  let delta = "";
  if (!firstRun && prevValue !== undefined) {
    const pv = extractValue(prevValue, alert.task), nv = extractValue(value, alert.task);
    if (pv !== null && nv !== null && nv !== pv) {
      const d = nv - pv;
      const arrow = d > 0 ? "↑" : "↓";
      const mag = Math.abs(d);
      const num = Number.isInteger(pv) && Number.isInteger(nv) ? String(mag) : mag.toFixed(2);
      delta = `\n(was ${prevValue.trim()} → now ${value.trim()}; ${arrow}${num})`;
    }
  }
  // Notify: DEFER the baseline advance to the caller's post-send commit (a failed send leaves the old
  // baseline so the change re-fires next check). First-run baseline seeds the same way — if that very
  // first notify fails to send, we re-seed + notify next check rather than silently starting watched.
  return { notify: true, message: await withThen(`${header}:\n${value}${delta}`), value, commit: advance(value) };
}
