import { describe, it, expect } from "vitest";
import { resolveProvider } from "../src/llm.js";

describe("resolveProvider (DEV-0155)", () => {
  it("maps the two known values (case/space-insensitive), no warning", () => {
    expect(resolveProvider("claude")).toEqual({ provider: "claude" });
    expect(resolveProvider("  Claude  ")).toEqual({ provider: "claude" });
    expect(resolveProvider("gemini")).toEqual({ provider: "gemini" });
    expect(resolveProvider("GEMINI")).toEqual({ provider: "gemini" });
  });

  it("empty/unset defaults to gemini with no warning", () => {
    expect(resolveProvider("")).toEqual({ provider: "gemini" });
    expect(resolveProvider(undefined)).toEqual({ provider: "gemini" });
  });

  it("an unknown value defaults to gemini WITH a warning naming the bad value", () => {
    for (const bad of ["claud", "gpt", "openai", "anthropic"]) {
      const r = resolveProvider(bad);
      expect(r.provider).toBe("gemini");
      expect(r.warning).toBeTruthy();
      expect(r.warning).toContain(bad);
    }
  });
});
