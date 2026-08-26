import { describe, it, expect } from "vitest";
import { TOOLS, SYSTEM_PROMPT } from "../src/agent.js";

// DEV-0074: every tool in TOOLS must be described in SYSTEM_PROMPT, or the LLM never learns it exists
// and silently never calls it. This exact omission shipped twice (DEV-0035 scrape, DEV-0043
// screenshot/pdf). Mirrors the /help-vs-commands sync-guard. A new tool without a prompt line fails here.

describe("SYSTEM_PROMPT ↔ TOOLS sync (DEV-0074)", () => {
  it("mentions every tool name in TOOLS", () => {
    const missing = TOOLS.map((t) => t.name).filter((name) => !SYSTEM_PROMPT.includes(name));
    expect(missing, `tools shipped but absent from SYSTEM_PROMPT: ${missing.join(", ")}`).toEqual([]);
  });

  it("has a non-trivial TOOLS set (guards the guard)", () => {
    // If TOOLS somehow read empty, the assertion above would vacuously pass.
    expect(TOOLS.length).toBeGreaterThanOrEqual(10);
    expect(TOOLS.every((t) => typeof t.name === "string" && t.name.length > 0)).toBe(true);
  });
});
