import { describe, it, expect } from "vitest";
import { formatWhen } from "../src/lib/format-when.js";

// NOW = Tue 14 Nov 2023 22:13:20 UTC.
const NOW = 1_700_000_000_000;
const H = 3_600_000, D = 86_400_000;

describe("formatWhen (schedule-confirm-fire-time)", () => {
  it("renders the time in the user's zone (offset applied)", () => {
    // 09:00 UTC tomorrow; at UTC+0 that's "tomorrow 9:00am".
    const t = Date.UTC(2023, 10, 15, 9, 0);
    expect(formatWhen(t, 0, NOW)).toBe("tomorrow 9:00am");
    // Same instant, viewed at UTC-5 (Eastern) -> 4:00am, still the 15th so "tomorrow".
    expect(formatWhen(t, -300, NOW)).toBe("tomorrow 4:00am");
  });
  it("says 'today' for later the same day", () => {
    expect(formatWhen(NOW + 30 * 60_000, 0, NOW)).toMatch(/^today \d/);
  });
  it("uses a weekday name 2-6 days out", () => {
    const s = formatWhen(NOW + 3 * D, 0, NOW);
    expect(s).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d/);
  });
  it("adds month + date when more than a week out", () => {
    const s = formatWhen(NOW + 10 * D, 0, NOW);
    expect(s).toMatch(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d+,/);
  });
  it("formats pm + minutes correctly", () => {
    const t = Date.UTC(2023, 10, 15, 14, 30);
    expect(formatWhen(t, 0, NOW)).toBe("tomorrow 2:30pm");
  });
});
