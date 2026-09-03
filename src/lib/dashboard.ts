// Unified dashboard (unified-dashboard): schedules, recipes, digests, and alerts each had their own
// /list command, so a user with a few automations had to run four commands to see what's running and
// lost track (then stopped adding). /dashboard rolls them into ONE at-a-glance view: what fires next,
// what each alert last saw, and what's paused. Pure formatter — the caller (index) gathers the data
// from the live stores (it owns the tz offset + pause state); this just renders, so it's unit-tested.

export interface DashboardData {
  schedules: Array<{ kind: string; task: string; whenText: string; paused?: boolean; pausedUntilText?: string }>;
  alerts: Array<{ name: string; trigger: string; lastValue?: string; paused?: boolean; pausedUntilText?: string }>;
  digests: Array<{ name: string; memberCount: number; scheduleText?: string; paused?: boolean; pausedUntilText?: string }>;
  recipes: Array<{ name: string; scheduled?: boolean; scheduleText?: string; paused?: boolean; pausedUntilText?: string }>;
}

/** A short "(paused …)" suffix for any row that's snoozed, or "" when it's live. */
function pausedSuffix(paused?: boolean, until?: string): string {
  if (!paused) return "";
  return until ? ` ⏸ (paused until ${until})` : " ⏸ (paused)";
}

/** Trim a task/value to one clean line for the rollup so a long prompt doesn't blow up the view. */
function oneLine(s: string, max = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Render the unified dashboard. Sections with no items are omitted; an entirely-empty dashboard returns
 * a friendly onboarding nudge instead of a wall of empty headers. Pure + deterministic (no clock — the
 * caller pre-formats every time via formatWhen). Kept plain-text (Telegram-safe), grouped by kind.
 */
export function formatDashboard(d: DashboardData): string {
  const total = d.schedules.length + d.alerts.length + d.digests.length + d.recipes.length;
  if (total === 0) {
    return "Your dashboard is empty. Try: \"remind me to stretch at 3pm\", \"watch btc: bitcoin below 50000\", or \"save morning: top 3 HN stories\".";
  }
  const out: string[] = ["📋 Your Relay dashboard"];

  if (d.schedules.length) {
    out.push("", `⏰ Reminders & scheduled (${d.schedules.length})`);
    for (const s of d.schedules) {
      out.push(`• ${oneLine(s.task)} — next ${s.whenText}${pausedSuffix(s.paused, s.pausedUntilText)}`);
    }
  }
  if (d.alerts.length) {
    out.push("", `🔔 Watching (${d.alerts.length})`);
    for (const a of d.alerts) {
      const last = a.lastValue ? ` — last: ${oneLine(a.lastValue, 40)}` : "";
      out.push(`• ${a.name}: ${a.trigger}${last}${pausedSuffix(a.paused, a.pausedUntilText)}`);
    }
  }
  if (d.digests.length) {
    out.push("", `📰 Digests (${d.digests.length})`);
    for (const dg of d.digests) {
      const sched = dg.scheduleText ? ` — ${dg.scheduleText}` : " — on demand";
      out.push(`• ${dg.name} (${dg.memberCount} item${dg.memberCount === 1 ? "" : "s"})${sched}${pausedSuffix(dg.paused, dg.pausedUntilText)}`);
    }
  }
  if (d.recipes.length) {
    out.push("", `📎 Recipes (${d.recipes.length})`);
    for (const r of d.recipes) {
      const sched = r.scheduled ? ` — runs ${r.scheduleText ?? "on schedule"}` : " — /run " + r.name;
      out.push(`• ${r.name}${sched}${pausedSuffix(r.paused, r.pausedUntilText)}`);
    }
  }

  out.push("", "Manage: /schedules /alerts /digests /recipes · pause one with \"snooze <name> 3 days\".");
  return out.join("\n");
}
