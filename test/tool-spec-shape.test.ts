import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/agent.js";

// DEV-0075: TOOLS is mapped 1:1 into Gemini functionDeclarations (llm.ts: tools.map(t => ({name,
// description, parameters}))), so there is no separate declaration list to drift against — but a
// MALFORMED ToolSpec (empty description, non-object parameters, or a `required` key with no matching
// property) is silently accepted here and only rejected by Gemini at call time, breaking that tool in
// production. This pins the shape every declaration must satisfy.

describe("ToolSpec shape (DEV-0075)", () => {
  it("every tool has a unique non-empty name", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.every((n) => typeof n === "string" && n.length > 0)).toBe(true);
    expect(new Set(names).size, "duplicate tool names").toBe(names.length);
  });

  it("every tool has a non-trivial description (the LLM routes on it)", () => {
    for (const t of TOOLS) {
      expect(typeof t.description === "string" && t.description.length >= 10, `weak description: ${t.name}`).toBe(true);
    }
  });

  it("every tool's parameters is a JSON-schema object with a properties map", () => {
    for (const t of TOOLS) {
      expect(t.parameters?.type, `${t.name}.parameters.type`).toBe("object");
      expect(typeof t.parameters?.properties === "object" && t.parameters.properties !== null, `${t.name}.properties`).toBe(true);
    }
  });

  it("every `required` param names a declared property (no phantom required field)", () => {
    for (const t of TOOLS) {
      const props = Object.keys(t.parameters.properties ?? {});
      const required = (t.parameters as { required?: string[] }).required ?? [];
      const phantom = required.filter((r) => !props.includes(r));
      expect(phantom, `${t.name} requires undeclared param(s): ${phantom.join(", ")}`).toEqual([]);
    }
  });
});
