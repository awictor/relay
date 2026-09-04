import { describe, it, expect } from "vitest";
import {
  encodeCallback, decodeCallback, alertButtons, digestButtons, recipeButtons, buttonsForTask, pickButtons,
  tryButtons, actButtons, installButtons, confirmButtons, TRY_EXAMPLES, CALLBACK_MAX_BYTES,
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

  it("pick buttons: a numbered row carrying indices, round-trips", () => {
    const kb = pickButtons(3)!;
    const row = kb[0]!;
    expect(row.map((b) => b.text)).toEqual(["1", "2", "3"]);
    expect(decodeCallback(row[0]!.callback_data)).toEqual({ kind: "pick", index: 0 });
    expect(decodeCallback(row[2]!.callback_data)).toEqual({ kind: "pick", index: 2 });
  });

  it("pick buttons cap the count + need 2+", () => {
    expect(pickButtons(1)).toBeUndefined();
    expect(pickButtons(0)).toBeUndefined();
    expect(pickButtons(20)![0]!.length).toBe(8); // default max
  });

  it("pick decodes reject a non-integer/negative index", () => {
    expect(decodeCallback("pk|x")).toBeNull();
    expect(decodeCallback("pk|-1")).toBeNull();
    expect(decodeCallback("pk|2")).toEqual({ kind: "pick", index: 2 });
  });

  it("try buttons: one per example, 2 per row, round-trip to the example index", () => {
    const kb = tryButtons();
    const flat = kb.flat();
    expect(flat).toHaveLength(TRY_EXAMPLES.length);
    expect(kb[0]!.length).toBe(2); // two per row
    expect(decodeCallback(flat[0]!.callback_data)).toEqual({ kind: "try", index: 0 });
    expect(decodeCallback(flat[flat.length - 1]!.callback_data)).toEqual({ kind: "try", index: TRY_EXAMPLES.length - 1 });
    for (const b of flat) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
  });

  it("no tap-to-try example dead-ends a cold user with no saved location (onboarding-weather-deadend)", () => {
    // A bare "weather"/"near me" asks "which city?" for a user who hasn't shared a location — the
    // onboarding buttons must each land an answer cold, so the weather example NAMES a city + nothing
    // relies on a shared location.
    for (const ex of TRY_EXAMPLES) {
      const t = ex.text.toLowerCase();
      if (/\bweather\b/.test(t)) expect(t).toMatch(/\b(in|at|near)\s+\w/); // weather must name a place
      expect(t).not.toMatch(/\bnear me\b/);                                // nothing location-relative
    }
  });

  it("try decodes reject a non-integer index", () => {
    expect(decodeCallback("ty|x")).toBeNull();
    expect(decodeCallback("ty|0")).toEqual({ kind: "try", index: 0 });
  });

  it("act ops (tap-to-watch) are bare opcodes, round-trip, no payload", () => {
    const daily = encodeCallback({ kind: "act", mode: "daily" })!;
    const watch = encodeCallback({ kind: "act", mode: "watch" })!;
    expect(daily).not.toContain("|");
    expect(decodeCallback(daily)).toEqual({ kind: "act", mode: "daily" });
    expect(decodeCallback(watch)).toEqual({ kind: "act", mode: "watch" });
  });

  it("confirm ops (confirm-to-act) are bare opcodes, round-trip yes/no (confirm-to-act)", () => {
    const yes = encodeCallback({ kind: "confirm", decision: "yes" })!;
    const no = encodeCallback({ kind: "confirm", decision: "no" })!;
    expect(yes).not.toContain("|");
    expect(decodeCallback(yes)).toEqual({ kind: "confirm", decision: "yes" });
    expect(decodeCallback(no)).toEqual({ kind: "confirm", decision: "no" });
  });
  it("confirmButtons: a YES + NO row that decode to the right decision", () => {
    const kb = confirmButtons()!;
    expect(kb[0]!.map((b) => b.text)).toEqual(["✅ Yes, do it", "✋ No"]);
    expect(decodeCallback(kb[0]![0]!.callback_data)).toEqual({ kind: "confirm", decision: "yes" });
    expect(decodeCallback(kb[0]![1]!.callback_data)).toEqual({ kind: "confirm", decision: "no" });
  });

  it("actButtons: Every-morning by default, Watch-this only when watchable", () => {
    const noWatch = actButtons(false)!;
    expect(noWatch[0]!.map((b) => b.text)).toEqual(["🔁 Every morning"]);
    const withWatch = actButtons(true)!;
    expect(withWatch[0]!.some((b) => /Watch this/.test(b.text))).toBe(true);
    expect(decodeCallback(withWatch[0]!.find((b) => /Watch/.test(b.text))!.callback_data)).toEqual({ kind: "act", mode: "watch" });
  });

  it("actButtons: suppresses the daily button on a static answer (act-daily-noise-on-static-answers)", () => {
    // A definition/conversion has no meaningful "every morning" — offerDaily=false drops that button.
    expect(actButtons(false, false)).toBeUndefined();       // nothing to offer -> no keyboard at all
    const watchOnly = actButtons(true, false)!;
    expect(watchOnly[0]!.map((b) => b.text)).toEqual(["🔔 Watch this"]); // watch kept, daily gone
  });

  it("install op carries the template id + round-trips (starter-automation-gallery)", () => {
    const data = encodeCallback({ kind: "install", id: "morning" })!;
    expect(decodeCallback(data)).toEqual({ kind: "install", id: "morning" });
    expect(decodeCallback("in|")).toBeNull(); // empty id
  });

  it("installButtons: one per template, 2 per row, round-trips to the id", () => {
    const kb = installButtons([{ id: "morning", label: "☀️ Morning" }, { id: "price", label: "💲 Price" }, { id: "news", label: "📰 News" }]);
    const flat = kb.flat();
    expect(flat).toHaveLength(3);
    expect(kb[0]!.length).toBe(2);
    expect(decodeCallback(flat[0]!.callback_data)).toEqual({ kind: "install", id: "morning" });
    for (const b of flat) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
  });

  it("buttonsForTask maps the schedule marker to the right keyboard", () => {
    expect(decodeCallback(buttonsForTask("alert:btc")![0]![0]!.callback_data)).toMatchObject({ kind: "alert" });
    expect(decodeCallback(buttonsForTask("digest:morning")![0]![0]!.callback_data)).toMatchObject({ kind: "digest" });
    expect(decodeCallback(buttonsForTask("recipe:flights")![0]![0]!.callback_data)).toMatchObject({ kind: "recipe" });
    expect(buttonsForTask("take my meds")).toBeUndefined(); // plain reminder -> no buttons
  });
});
