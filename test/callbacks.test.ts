import { describe, it, expect } from "vitest";
import {
  encodeCallback, decodeCallback, alertButtons, digestButtons, recipeButtons, buttonsForTask,
  CALLBACK_MAX_BYTES,
} from "../src/lib/callbacks.js";

describe("callback codec", () => {
  it("round-trips every action kind", () => {
    for (const a of [
      { kind: "alert", action: "refresh", name: "btc" },
      { kind: "alert", action: "snooze", name: "btc" },
      { kind: "alert", action: "stop", name: "btc" },
      { kind: "digest", action: "run", name: "morning" },
      { kind: "recipe", action: "run", name: "flights" },
    ] as const) {
      const data = encodeCallback(a)!;
      expect(data).toBeTruthy();
      expect(decodeCallback(data)).toEqual(a);
    }
  });

  it("preserves a name containing the delimiter", () => {
    const data = encodeCallback({ kind: "alert", action: "stop", name: "a|b" })!;
    expect(decodeCallback(data)).toMatchObject({ name: "a|b", action: "stop" });
  });

  it("returns null when the payload would exceed Telegram's 64-byte cap", () => {
    const longName = "x".repeat(70);
    expect(encodeCallback({ kind: "alert", action: "refresh", name: longName })).toBeNull();
  });

  it("decodes null/garbage/unknown-op to null", () => {
    expect(decodeCallback(undefined)).toBeNull();
    expect(decodeCallback("")).toBeNull();
    expect(decodeCallback("noPipe")).toBeNull();
    expect(decodeCallback("zz|btc")).toBeNull(); // unknown opcode
    expect(decodeCallback("ar|")).toBeNull();    // empty name
  });
});

describe("keyboard builders", () => {
  it("alert keyboard has Refresh/Snooze/Stop", () => {
    const kb = alertButtons("btc")!;
    const labels = kb[0]!.map((b) => b.text);
    expect(labels.some((l) => /Refresh/.test(l))).toBe(true);
    expect(labels.some((l) => /Snooze/.test(l))).toBe(true);
    expect(labels.some((l) => /Stop/.test(l))).toBe(true);
    for (const b of kb.flat()) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
  });

  it("digest + recipe keyboards have a Run-again button", () => {
    expect(digestButtons("morning")![0]![0]!.text).toMatch(/again/i);
    expect(recipeButtons("flights")![0]![0]!.text).toMatch(/again/i);
    expect(decodeCallback(digestButtons("morning")![0]![0]!.callback_data)).toMatchObject({ kind: "digest", action: "run", name: "morning" });
  });

  it("drops buttons (undefined) when the name overflows the cap", () => {
    const longName = "y".repeat(80);
    expect(alertButtons(longName)).toBeUndefined();
    expect(digestButtons(longName)).toBeUndefined();
  });

  it("buttonsForTask maps the schedule marker to the right keyboard", () => {
    expect(decodeCallback(buttonsForTask("alert:btc")![0]![0]!.callback_data)).toMatchObject({ kind: "alert" });
    expect(decodeCallback(buttonsForTask("digest:morning")![0]![0]!.callback_data)).toMatchObject({ kind: "digest" });
    expect(decodeCallback(buttonsForTask("recipe:flights")![0]![0]!.callback_data)).toMatchObject({ kind: "recipe" });
    expect(buttonsForTask("take my meds")).toBeUndefined(); // plain reminder -> no buttons
  });
});
