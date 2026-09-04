import { describe, it, expect } from "vitest";
import { digestMemberChanged, DigestChangeStore } from "../src/lib/digest-change.js";

describe("digestMemberChanged", () => {
  it("first run is NOT a change (nothing to compare)", () => {
    expect(digestMemberChanged(undefined, "$65,000")).toBe(false);
  });
  it("numeric: material move changes, sub-deadband tick doesn't", () => {
    expect(digestMemberChanged("$65,000", "$70,000")).toBe(true);   // ~7.7% > 1%
    expect(digestMemberChanged("$65,000", "$65,010")).toBe(false);  // ~0.015% < 1%
    expect(digestMemberChanged("0", "5")).toBe(true);               // off zero
  });
  it("text: phrasing drift doesn't change, real content change does", () => {
    expect(digestMemberChanged("Sunny, 72°F.", "sunny, 72 F")).toBe(false);   // normalized-equal
    expect(digestMemberChanged("Top story: A", "Top story: B different")).toBe(true);
  });
  it("tracks the SALIENT value, not the first number (digest-change-tracks-wrong-number)", () => {
    // A leading percent/count must NOT be the tracked value: a real price move with a steady "up 2.5%"
    // used to read as unchanged (firstNumber grabbed 2.5 both runs) -> a quiet digest wrongly stayed silent.
    expect(digestMemberChanged("BTC up 2.5% at 68000", "BTC up 2.5% at 69500", "btc")).toBe(true);  // 68000->69500 = ~2.2% > 1%
    expect(digestMemberChanged("BTC up 2.5% at 68000", "BTC up 2.6% at 68010", "btc")).toBe(false); // price ~0.01% < 1% (the % delta is ignored)
    // magnitude suffix: "$60k" -> 60000, a move to $62k is +3.3% (firstNumber would've compared 60 vs 62)
    expect(digestMemberChanged("$60k", "$62k")).toBe(true);
    expect(digestMemberChanged("$60k", "$60.1k")).toBe(false); // ~0.17% < 1%
  });
});

describe("DigestChangeStore", () => {
  it("records + reports change per (chat,digest,member); first sighting not changed", () => {
    const s = new DigestChangeStore();
    expect(s.changed(1, "morning", "btc", "$65,000")).toBe(false); // first
    expect(s.changed(1, "morning", "btc", "$65,000")).toBe(false); // same
    expect(s.changed(1, "morning", "btc", "$71,000")).toBe(true);  // moved
  });
  it("keys are isolated across chats + digests + members", () => {
    const s = new DigestChangeStore();
    s.changed(1, "morning", "btc", "100");
    s.changed(2, "morning", "btc", "100"); // different chat -> its own baseline
    expect(s.changed(2, "morning", "btc", "100")).toBe(false);
    expect(s.changed(1, "evening", "btc", "100")).toBe(false);     // different digest name
  });
  it("seenBefore: false until a member of that digest is recorded (digest-skip-unchanged)", () => {
    const s = new DigestChangeStore();
    expect(s.seenBefore(1, "morning")).toBe(false);
    s.changed(1, "morning", "btc", "$100");
    expect(s.seenBefore(1, "morning")).toBe(true);
    expect(s.seenBefore(1, "evening")).toBe(false); // different digest
    expect(s.seenBefore(2, "morning")).toBe(false); // different chat
  });

  it("persist callback fires with a flat snapshot", () => {
    let saved: Record<string, string> | null = null;
    const s = new DigestChangeStore((o) => { saved = o; });
    s.changed(1, "d", "m", "x");
    expect(saved).toBeTruthy();
    expect(Object.values(saved!)).toContain("x");
  });
});
