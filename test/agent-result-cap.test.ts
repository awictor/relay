import { describe, it, expect } from "vitest";
import { runAgent, type BrowserBackend } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec, ToolCall } from "../src/llm.js";

// DEV-0036: scrape/read/fetch_json push r.content.slice(0, 6000) into the model context so a huge
// page can't blow the prompt (token cost / model limit). Nothing pinned the cap — a refactor could
// drop it. Assert the tool message fed back to the LLM is <= 6000 chars for an oversized page.
class ScriptLLM implements LLMClient {
  calls: LLMMessage[][] = [];
  constructor(private script: LLMResult[]) {}
  async complete(messages: LLMMessage[], _tools: ToolSpec[]): Promise<LLMResult> {
    this.calls.push(messages.map((m) => ({ ...m })));
    return this.script.shift() ?? { text: "(no more script)" };
  }
}

const BIG = "x".repeat(20000); // 20k-char page body

function stubBackend(): BrowserBackend {
  return {
    scrape: async (url) => ({ title: "T", content: BIG, url }),
    createSession: async () => ({ id: "s1" }),
    navigate: async (_id, url) => ({ url, title: "T" }),
    click: async () => {},
    type: async () => {},
    readCurrent: async () => ({ title: "T", content: BIG, url: "u" }),
    releaseSession: async () => {},
    discoverLinks: async () => [],
    fetchJson: async () => ({ status: 200, contentType: "application/json", text: JSON.stringify({ data: BIG }) }),
  };
}

// The content slice cap. The tool message also carries a "TITLE: ...\n\n" prefix (or a
// "JSON from <url> ...:\n" prefix), so allow a small header margin above the 6000 body cap.
const BODY_CAP = 6000;
const HEADER_MARGIN = 200;

function toolContentAfter(llm: ScriptLLM, name: string): string {
  // the tool result is pushed as a {role:"tool", name} message; it's visible on the NEXT llm call
  for (const call of llm.calls) {
    const m = call.find((x) => x.role === "tool" && x.name === name);
    if (m) return m.content;
  }
  return "";
}

describe("agent tool-result size cap (DEV-0036)", () => {
  it("scrape result fed to the LLM is capped near 6000 chars", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "scrape", args: { url: "https://x.com/big" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "done" } } as ToolCall },
    ]);
    await runAgent("read big", { llm, backend: stubBackend() });
    const content = toolContentAfter(llm, "scrape");
    expect(content.length).toBeLessThanOrEqual(BODY_CAP + HEADER_MARGIN);
    expect(content).not.toContain(BIG); // the full 20k body must NOT be present verbatim
  });

  it("read result is capped too", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "browse", args: { url: "https://x.com/app" } } as ToolCall },
      { toolCall: { name: "read", args: {} } as ToolCall },
      { toolCall: { name: "reply", args: { text: "done" } } as ToolCall },
    ]);
    await runAgent("open + read big", { llm, backend: stubBackend() });
    expect(toolContentAfter(llm, "read").length).toBeLessThanOrEqual(BODY_CAP + HEADER_MARGIN);
  });

  it("fetch_json result is capped too", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "fetch_json", args: { url: "https://api.x.com/big" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "done" } } as ToolCall },
    ]);
    await runAgent("get big json", { llm, backend: stubBackend() });
    expect(toolContentAfter(llm, "fetch_json").length).toBeLessThanOrEqual(BODY_CAP + HEADER_MARGIN);
  });
});
