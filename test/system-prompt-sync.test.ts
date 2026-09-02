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

  it("carries the clarify-once guidance for underspecified tasks (clarify-once-ambiguous)", () => {
    // A behavioral instruction (not a tool) — guard it so a future prompt edit doesn't silently drop
    // the "ask one question instead of guessing on a vague first errand" behavior.
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/underspecified/);
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/one (short )?question|ask at most once/);
  });

  it("carries the answer-directly carve-out for deterministic math/facts (instant-calc-convert)", () => {
    // Guard the "don't browse for arithmetic/conversions/known facts" behavior against prompt edits.
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/answer directly/);
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/arithmetic|conversion|deterministic/);
    // must still steer live/moving data (prices, rates) to tools
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/time-sensitive|live|current/);
  });

  it("carries the cite-source guidance for fetched answers (cite-source-link)", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/cite your source|source: <url>/);
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/never invent or guess a link/);
  });
});
