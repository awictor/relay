import { describe, it, expect } from "vitest";
import { isOpenNow, openTag } from "../src/lib/openhours.js";

// dow: 0=Sun..6=Sat. mins = minutes since midnight (e.g. 9am = 540, 9pm = 1260).
describe("isOpenNow", () => {
  it("24/7 is always open", () => {
    expect(isOpenNow("24/7", 0, 0)).toBe("open");
    expect(isOpenNow("Mo-Su 00:00-24:00", 3, 1260)).toBe("open");
  });
  it("weekday range + time window: open inside, closed outside", () => {
    const spec = "Mo-Fr 08:00-18:00";
    expect(isOpenNow(spec, 1, 540)).toBe("open");    // Mon 9am
    expect(isOpenNow(spec, 5, 1020)).toBe("open");   // Fri 5pm
    expect(isOpenNow(spec, 1, 1260)).toBe("closed"); // Mon 9pm (after close)
    expect(isOpenNow(spec, 6, 540)).toBe("closed");  // Sat (not in Mo-Fr) -> closed
  });
  it("multiple day+time rules (';'-separated)", () => {
    const spec = "Mo-Fr 08:00-18:00; Sa 09:00-13:00";
    expect(isOpenNow(spec, 6, 600)).toBe("open");    // Sat 10am
    expect(isOpenNow(spec, 6, 840)).toBe("closed");  // Sat 2pm
    expect(isOpenNow(spec, 0, 600)).toBe("closed");  // Sun (no rule) -> closed
  });
  it("a no-day time rule means every day", () => {
    expect(isOpenNow("08:00-20:00", 0, 600)).toBe("open");  // Sun 10am
    expect(isOpenNow("08:00-20:00", 0, 1300)).toBe("closed"); // Sun ~9:40pm
  });
  it("split windows (lunch break)", () => {
    const spec = "Mo-Fr 09:00-12:00,13:00-17:00";
    expect(isOpenNow(spec, 2, 630)).toBe("open");    // 10:30
    expect(isOpenNow(spec, 2, 750)).toBe("closed");  // 12:30 (break)
    expect(isOpenNow(spec, 2, 840)).toBe("open");    // 14:00
  });
  it("overnight window that wraps midnight (openhours-overnight-window)", () => {
    const spec = "Mo-Su 18:00-02:00"; // a bar open 6pm–2am
    expect(isOpenNow(spec, 5, 1380)).toBe("open");   // Fri 11pm — after start
    expect(isOpenNow(spec, 6, 60)).toBe("open");     // Sat 1am — before end (early hours)
    expect(isOpenNow(spec, 6, 180)).toBe("closed");  // Sat 3am — past close
    expect(isOpenNow(spec, 3, 720)).toBe("closed");  // Wed noon — between windows
  });
  it("explicit closed rule for a day", () => {
    expect(isOpenNow("Mo-Sa 08:00-18:00; Su off", 0, 600)).toBe("closed");
  });
  it("unknown for an empty or unparseable spec", () => {
    expect(isOpenNow("", 1, 540)).toBe("unknown");
    expect(isOpenNow("by appointment", 1, 540)).toBe("unknown");
  });
});

describe("openTag", () => {
  it("maps state to a short tag; '' when unknown or no spec", () => {
    expect(openTag("Mo-Fr 08:00-18:00", 1, 540)).toBe("open now");
    expect(openTag("Mo-Fr 08:00-18:00", 1, 1260)).toBe("closed now");
    expect(openTag(undefined, 1, 540)).toBe("");
    expect(openTag("by appointment", 1, 540)).toBe("");
  });
});
