import { describe, it, expect } from "vitest";
import { runAgent, type BrowserBackend } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec, ToolCall } from "../src/llm.js";

// DEV-0014: the runAgent orchestration branches that the dispatch/browse suites don't
// cover — unknown-tool handling, conversation history threading, the empty-reply
// fallback, and that `tools` reflects every non-reply call across the loop. These are
// pure loop-control paths; a stub LLM + stub backend keep it offline.
class ScriptLLM implements LLMClient {
  calls: LLMMessage[][] = [];
  constructor(private script: LLMResult[]) {}
  async complete(messages: LLMMessage[], _tools: ToolSpec[]): Promise<LLMResult> {
    this.calls.push(messages.map((m) => ({ ...m })));
    return this.script.shift() ?? { text: "(no more script)" };
  }
}

function stubBackend(): BrowserBackend {
  return {
    scrape: async (url) => ({ title: "t", content: "c", url }),
    createSession: async () => ({ id: "s1" }),
    navigate: async (_id, url) => ({ url, title: "t" }),
    click: async () => {},
    type: async () => {},
    readCurrent: async () => ({ title: "t", content: "c", url: "u" }),
    releaseSession: async () => {},
    discoverLinks: async () => [],
    fetchJson: async () => ({ status: 200, contentType: "application/json", text: "{}" }),
  };
}

describe("runAgent loop control (DEV-0014)", () => {
  it("an unknown tool name is reported back to the model, loop continues to reply", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "teleport", args: { to: "moon" } } as unknown as ToolCall },
      { toolCall: { name: "reply", args: { text: "handled" } } as ToolCall },
    ]);
    const { reply, tools } = await runAgent("do a bad tool", { llm, backend: stubBackend() });
    expect(reply).toBe("handled");
    // the unknown tool is recorded as invoked but produced an error message to the model
    expect(tools).toContain("teleport");
    const afterUnknown = llm.calls[1]!;
    expect(afterUnknown.some((m) => m.role === "tool" && /unknown tool "teleport"/i.test(m.content))).toBe(true);
  });

  it("threads prior conversation history in before the new user message", async () => {
    const llm = new ScriptLLM([{ toolCall: { name: "reply", args: { text: "ok" } } as ToolCall }]);
    const history: LLMMessage[] = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    await runAgent("new question", { llm, backend: stubBackend() }, history);
    const seen = llm.calls[0]!;
    // order: system, ...history, user(new). System first, history preserved, new user last.
    expect(seen[0]!.role).toBe("system");
    expect(seen.some((m) => m.role === "user" && m.content === "earlier question")).toBe(true);
    expect(seen.some((m) => m.role === "assistant" && m.content === "earlier answer")).toBe(true);
    expect(seen[seen.length - 1]).toMatchObject({ role: "user", content: "new question" });
    // the earlier user message comes before the new one
    const idxOld = seen.findIndex((m) => m.content === "earlier question");
    const idxNew = seen.findIndex((m) => m.content === "new question");
    expect(idxOld).toBeLessThan(idxNew);
  });

  it("an empty reply text falls back to \"Done.\"", async () => {
    const llm = new ScriptLLM([{ toolCall: { name: "reply", args: { text: "   " } } as ToolCall }]);
    const { reply, steps } = await runAgent("finish", { llm, backend: stubBackend() });
    expect(reply).toBe("Done.");
    expect(steps).toBe(1);
  });

  it("a null tool call with empty text uses the couldn't-answer fallback", async () => {
    const llm = new ScriptLLM([{ text: "   " }]);
    const { reply } = await runAgent("blank", { llm, backend: stubBackend() });
    expect(reply).toMatch(/couldn't come up with an answer/i);
  });

  it("`tools` accumulates every non-reply call in order and excludes reply", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "scrape", args: { url: "https://x.com/a" } } as ToolCall },
      { toolCall: { name: "fetch_json", args: { url: "https://api.x.com/b" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "done" } } as ToolCall },
    ]);
    const { tools } = await runAgent("two tools then reply", { llm, backend: stubBackend() });
    expect(tools).toEqual(["scrape", "fetch_json"]);
  });
});
