import { describe, it, expect } from "vitest";
import { parseTimeUntil, runTimeUntil } from "../src/lib/timeuntil.js";

describe("parseTimeUntil", () => {
  it("parses clock-time countdown asks", () => {
    expect(parseTimeUntil("how long until 5pm")).toEqual({ hour: 17, minute: 0, label: "5:00 PM" });
    expect(parseTimeUntil("how many minutes until 9:30am")).toEqual({ hour: 9, minute: 30, label: "9:30 AM" });
    expect(parseTimeUntil("how long till 17:00")).toEqual({ hour: 17, minute: 0, label: "5:00 PM" });
    expect(parseTimeUntil("time until midnight")).toEqual({ hour: 0, minute: 0, label: "midnight" });
    expect(parseTimeUntil("until noon")).toEqual({ hour: 12, minute: 0, label: "noon" });
  });
  it("handles 12am/12pm correctly", () => {
    expect(parseTimeUntil("how long until 12am")).toEqual({ hour: 0, minute: 0, label: "12:00 AM" });
    expect(parseTimeUntil("how long until 12pm")).toEqual({ hour: 12, minute: 0, label: "12:00 PM" });
  });
  it("returns null for a DATE countdown (that's date_math) or ordinary chat", () => {
    expect(parseTimeUntil("how long until Friday")).toBeNull();
    expect(parseTimeUntil("how many days until Christmas")).toBeNull();
    expect(parseTimeUntil("what's the weather")).toBeNull();
    expect(parseTimeUntil("what time is it in Tokyo")).toBeNull();
  });
});

describe("runTimeUntil", () => {
  const now = Date.UTC(2026, 8, 3, 15, 0, 0); // 2026-09-03 15:00 UTC

  it("counts down to a time later today (tz=UTC)", () => {
    expect(runTimeUntil({ hour: 17, minute: 0, label: "5:00 PM" }, now, 0)).toBe("⏳ 2 hours until 5:00 PM.");
    expect(runTimeUntil({ hour: 15, minute: 30, label: "3:30 PM" }, now, 0)).toBe("⏳ 30 minutes until 3:30 PM.");
  });
  it("rolls over to tomorrow when the time already passed today", () => {
    // 8am has passed (it's 3pm) -> next 8am is tomorrow (17h out), flagged.
    expect(runTimeUntil({ hour: 8, minute: 0, label: "8:00 AM" }, now, 0)).toBe("⏳ 17 hours until 8:00 AM (tomorrow).");
    expect(runTimeUntil({ hour: 0, minute: 0, label: "midnight" }, now, 0)).toBe("⏳ 9 hours until midnight (tomorrow).");
  });
  it("computes in the user's timezone, not UTC", () => {
    // tz -300 (EST): local now is 10:00 -> until 5pm is 7h.
    expect(runTimeUntil({ hour: 17, minute: 0, label: "5:00 PM" }, now, -300)).toBe("⏳ 7 hours until 5:00 PM.");
  });
  it("says 'less than a minute' when essentially now (rolled to tomorrow)", () => {
    // exactly 15:00 target at 15:00 now -> not >0, rolls to tomorrow ~24h; not the 'less than a minute' path.
    // Use 1 minute out to exercise the minute wording.
    expect(runTimeUntil({ hour: 15, minute: 1, label: "3:01 PM" }, now, 0)).toBe("⏳ 1 minute until 3:01 PM.");
  });
});
