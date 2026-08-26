import { describe, it, expect } from "vitest";
import { toGemini } from "../src/llm.js";
import type { LLMMessage } from "../src/llm.js";

// DEV-0039: toGemini maps our neutral LLMMessage[] to Gemini's {system, contents[]}. A wrong
// mapping silently breaks every call — especially the Gemini-2.5 thoughtSignature roundtrip
// (must echo back on the functionCall part) and tool output as a user-role functionResponse.

describe("toGemini (DEV-0039)", () => {
  it("concatenates multiple system messages into one systemInstruction", () => {
    const { system, contents } = toGemini([
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "hi" },
    ]);
    expect(system).toBe("A\n\nB");
    expect(contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("maps a user message to {role:user, parts:[{text}]}", () => {
    const { contents } = toGemini([{ role: "user", content: "hello" }]);
    expect(contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
  });

  it("maps an assistant toolCall to {role:model, functionCall} and echoes thoughtSignature", () => {
    const msg: LLMMessage = { role: "assistant", content: "", toolCall: { name: "scrape", args: { url: "u" }, thoughtSignature: "SIG" } };
    const { contents } = toGemini([msg]);
    expect(contents).toEqual([{ role: "model", parts: [{ functionCall: { name: "scrape", args: { url: "u" } }, thoughtSignature: "SIG" }] }]);
  });

  it("omits thoughtSignature when absent; keeps assistant text alongside the call", () => {
    const { contents } = toGemini([{ role: "assistant", content: "thinking", toolCall: { name: "read", args: {} } }]);
    expect(contents[0]!.role).toBe("model");
    expect(contents[0]!.parts[0]).toEqual({ text: "thinking" });
    expect(contents[0]!.parts[1]).toEqual({ functionCall: { name: "read", args: {} } });
    expect((contents[0]!.parts[1] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });

  it("maps a tool message to a user-role functionResponse {name, response.result}", () => {
    const { contents } = toGemini([{ role: "tool", name: "scrape", content: "PAGE TEXT" }]);
    expect(contents).toEqual([{ role: "user", parts: [{ functionResponse: { name: "scrape", response: { result: "PAGE TEXT" } } }] }]);
  });

  it("a tool message with no name falls back to 'tool'", () => {
    const { contents } = toGemini([{ role: "tool", content: "x" }]);
    expect((contents[0]!.parts[0] as { functionResponse: { name: string } }).functionResponse.name).toBe("tool");
  });

  it("an empty assistant message (no content, no toolCall) still yields a non-empty parts array", () => {
    // Gemini rejects a content with empty parts — must emit [{text:""}].
    const { contents } = toGemini([{ role: "assistant", content: "" }]);
    expect(contents).toEqual([{ role: "model", parts: [{ text: "" }] }]);
  });

  it("a full multi-turn thread maps in order (user, model+call, tool, user)", () => {
    const { contents } = toGemini([
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "", toolCall: { name: "scrape", args: { url: "u" } } },
      { role: "tool", name: "scrape", content: "res" },
      { role: "user", content: "q2" },
    ]);
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user", "user"]);
  });
});
