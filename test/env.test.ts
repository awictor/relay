import { describe, it, expect } from "vitest";
import { intEnv } from "../src/lib/env.js";

describe("intEnv (DEV-0163)", () => {
  it("undefined / blank / garbage / NaN -> fallback (never NaN)", () => {
    for (const bad of [undefined, "", "   ", "abc", "1O", "NaN"]) {
      expect(intEnv(bad, { fallback: 42 }), String(bad)).toBe(42);
    }
  });

  it("a valid integer is honored and floored", () => {
    expect(intEnv("30000", { fallback: 5 })).toBe(30000);
    expect(intEnv("12.9", { fallback: 5 })).toBe(12);
  });

  it("below min falls back (a bad value can't silently disable a feature)", () => {
    expect(intEnv("-5", { fallback: 10, min: 1 })).toBe(10);
    expect(intEnv("0", { fallback: 10, min: 1 })).toBe(10); // 0 not allowed as disable here
  });

  it("0 is honored only when allowZeroDisable", () => {
    expect(intEnv("0", { fallback: 10, allowZeroDisable: true })).toBe(0);
    expect(intEnv("0", { fallback: 10 })).toBe(10);
  });

  it("clamps to max when given", () => {
    expect(intEnv("999", { fallback: 5, max: 100 })).toBe(100);
  });
});
