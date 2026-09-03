import { describe, it, expect } from "vitest";
import { formatDashboard, type DashboardData } from "../src/lib/dashboard.js";

const empty: DashboardData = { schedules: [], alerts: [], digests: [], recipes: [] };

describe("formatDashboard (unified-dashboard)", () => {
  it("an empty dashboard returns an onboarding nudge, not empty headers", () => {
    const out = formatDashboard(empty);
    expect(out).toMatch(/empty/i);
    expect(out).toMatch(/remind me|watch|save/i);
    expect(out).not.toMatch(/Reminders &/); // no section headers when there's nothing
  });

  it("renders each populated section with counts + omits empty ones", () => {
    const out = formatDashboard({
      ...empty,
      schedules: [{ kind: "daily", task: "tell me the weather", whenText: "tomorrow 9:00am" }],
      alerts: [{ name: "btc", trigger: "below 50000", lastValue: "$61,200" }],
    });
    expect(out).toMatch(/⏰ Reminders & scheduled \(1\)/);
    expect(out).toMatch(/tell me the weather — next tomorrow 9:00am/);
    expect(out).toMatch(/🔔 Watching \(1\)/);
    expect(out).toMatch(/btc: below 50000 — last: \$61,200/);
    expect(out).not.toMatch(/Digests/);  // empty section omitted
    expect(out).not.toMatch(/Recipes/);
  });

  it("shows a paused suffix with the resume time, or a bare paused for indefinite", () => {
    const out = formatDashboard({
      ...empty,
      schedules: [{ kind: "daily", task: "weather", whenText: "tomorrow 9am", paused: true, pausedUntilText: "Fri 9am" }],
      alerts: [{ name: "btc", trigger: "on change", paused: true }],
    });
    expect(out).toMatch(/weather — next tomorrow 9am ⏸ \(paused until Fri 9am\)/);
    expect(out).toMatch(/btc: on change ⏸ \(paused\)/);
  });

  it("digests show member count + schedule/on-demand; recipes show run hint or schedule", () => {
    const out = formatDashboard({
      ...empty,
      digests: [
        { name: "morning", memberCount: 3, scheduleText: "every day at 07:00" },
        { name: "adhoc", memberCount: 1 },
      ],
      recipes: [
        { name: "btc", scheduled: false },
        { name: "brief", scheduled: true, scheduleText: "every morning" },
      ],
    });
    expect(out).toMatch(/morning \(3 items\) — every day at 07:00/);
    expect(out).toMatch(/adhoc \(1 item\) — on demand/);
    expect(out).toMatch(/btc — \/run btc/);
    expect(out).toMatch(/brief — runs every morning/);
  });

  it("truncates a very long task to one line", () => {
    const long = "x".repeat(200);
    const out = formatDashboard({ ...empty, schedules: [{ kind: "once", task: long, whenText: "today 5pm" }] });
    expect(out).toMatch(/x+…/);
    expect(out).not.toContain(long);
  });
});
