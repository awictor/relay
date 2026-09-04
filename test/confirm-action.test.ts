import { describe, it, expect } from "vitest";
import { confirmToActEnabled, classifyConfirmReply, formatConfirmPrompt, PendingActionStore } from "../src/lib/confirm-action.js";

describe("confirmToActEnabled (opt-in flag, default OFF)", () => {
  it("is OFF for unset/blank/falsey and ON only for explicit truthy", () => {
    for (const v of [undefined, "", "0", "false", "no", "off", "nope"]) expect(confirmToActEnabled(v), String(v)).toBe(false);
    for (const v of ["1", "true", "yes", "on", "TRUE", "On"]) expect(confirmToActEnabled(v), v).toBe(true);
  });
});

describe("classifyConfirmReply", () => {
  it("treats a whole-message affirmative as yes", () => {
    for (const t of ["yes", "y", "YES", "ok", "confirm", "do it", "go ahead", "proceed", "👍", "yep!"]) expect(classifyConfirmReply(t), t).toBe("yes");
  });
  it("treats a whole-message negative as no", () => {
    for (const t of ["no", "n", "cancel", "stop", "nevermind", "don't", "abort", "❌"]) expect(classifyConfirmReply(t), t).toBe("no");
  });
  it("anything else is 'other' — NOT a false yes that would spend money", () => {
    for (const t of ["yes please also add milk", "what does it cost", "why", "the weather", "ok so what about X"]) expect(classifyConfirmReply(t), t).toBe("other");
  });
});

describe("formatConfirmPrompt", () => {
  it("names the exact click + host + a blunt warning + how to respond", () => {
    const out = formatConfirmPrompt({ label: "Place order", url: "https://www.amazon.com/checkout" }, 120000);
    expect(out).toMatch(/"Place order"/);
    expect(out).toMatch(/amazon\.com/);          // www. stripped
    expect(out).not.toMatch(/www\.amazon/);
    expect(out).toMatch(/YES/);
    expect(out).toMatch(/NO/);
    expect(out).toMatch(/2 min/);                // ttl rendered
    expect(out).toMatch(/irreversible|buy|pay|submit/i);
  });
  it("handles a missing label / unparseable url gracefully", () => {
    const out = formatConfirmPrompt({ label: "", url: "not a url" }, 60000);
    expect(out).toMatch(/that button/);
    expect(out).toMatch(/1 min/);
  });
});

describe("PendingActionStore", () => {
  const mk = (t: { t: number }) => new PendingActionStore(120000, () => t.t);
  const action = { chatId: 1, sessionId: "s1", selector: "#buy", label: "Place order", url: "https://x.com/checkout" };

  it("stores + returns a pending action within its TTL", () => {
    const clock = { t: 1000 };
    const s = mk(clock);
    s.set(action);
    expect(s.has(1)).toBe(true);
    expect(s.get(1)).toMatchObject({ selector: "#buy", label: "Place order", createdMs: 1000 });
  });
  it("expires + prunes a pending action past the TTL (a stale confirm must not fire)", () => {
    const clock = { t: 1000 };
    const s = mk(clock);
    s.set(action);
    clock.t = 1000 + 120000 + 1; // just past TTL
    expect(s.get(1)).toBeUndefined();
    expect(s.has(1)).toBe(false);
  });
  it("keeps only the MOST RECENT proposal per chat (a new one replaces the old)", () => {
    const clock = { t: 1000 };
    const s = mk(clock);
    s.set(action);
    s.set({ ...action, selector: "#pay", label: "Pay now" });
    expect(s.get(1)!.selector).toBe("#pay");
  });
  it("clear() discards (YES-consumed / NO)", () => {
    const clock = { t: 1000 };
    const s = mk(clock);
    s.set(action);
    s.clear(1);
    expect(s.get(1)).toBeUndefined();
  });
  it("is per-chat isolated", () => {
    const clock = { t: 1000 };
    const s = mk(clock);
    s.set(action);
    expect(s.get(2)).toBeUndefined();
  });
});
