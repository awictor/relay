import { describe, it, expect } from "vitest";
import { runAgent } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec, ToolCall } from "../src/llm.js";
import type { BrowserBackend } from "../src/agent.js";

class ScriptLLM implements LLMClient {
  calls: LLMMessage[][] = [];
  constructor(private script: LLMResult[]) {}
  async complete(messages: LLMMessage[], _tools: ToolSpec[]): Promise<LLMResult> {
    this.calls.push(messages);
    return this.script.shift() ?? { text: "(no more script)" };
  }
}

function backend(fetchJson: BrowserBackend["fetchJson"]): BrowserBackend {
  return {
    scrape: async (url) => ({ title: url, content: "", url }),
    createSession: async () => ({ id: "s" }),
    navigate: async (_id, url) => ({ url, title: url }),
    click: async () => {},
    type: async () => {},
    readCurrent: async () => ({ title: "", content: "", url: "" }),
    releaseSession: async () => {},
    discoverLinks: async () => [],
    fetchJson,
  };
}

describe("runAgent — fetch_json tool", () => {
  it("returns JSON body to the model for a JSON endpoint", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "fetch_json", args: { url: "https://api.example.com/weather" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "It's 21°C." } } as ToolCall },
    ]);
    const b = backend(async () => ({ status: 200, contentType: "application/json", text: '{"tempC":21}' }));
    const { reply } = await runAgent("weather?", { llm, backend: b });
    expect(reply).toBe("It's 21°C.");
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool" && m.name === "fetch_json");
    expect(toolMsg?.content).toMatch(/tempC.*21/);
  });

  it("refuses an SSRF target without fetching", async () => {
    let called = false;
    const llm = new ScriptLLM([
      { toolCall: { name: "fetch_json", args: { url: "http://169.254.169.254/latest/meta-data" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "no" } } as ToolCall },
    ]);
    const b = backend(async () => { called = true; return { status: 200, contentType: "application/json", text: "{}" }; });
    await runAgent("read metadata", { llm, backend: b });
    expect(called).toBe(false);
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool" && m.name === "fetch_json");
    expect(toolMsg?.content).toMatch(/refused|Blocked/i);
  });

  it("rejects a non-JSON (HTML) response and suggests scrape", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "fetch_json", args: { url: "https://example.com/page" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "used scrape instead" } } as ToolCall },
    ]);
    const b = backend(async () => ({ status: 200, contentType: "text/html; charset=utf-8", text: "<html></html>" }));
    await runAgent("get data", { llm, backend: b });
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool" && m.name === "fetch_json");
    expect(toolMsg?.content).toMatch(/Not a JSON response/i);
    expect(toolMsg?.content).toMatch(/scrape/i);
  });

  it("reports invalid JSON body (JSON content-type but unparseable)", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "fetch_json", args: { url: "https://api.example.com/broken" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "bad data" } } as ToolCall },
    ]);
    const b = backend(async () => ({ status: 200, contentType: "application/json", text: "{not json" }));
    await runAgent("get", { llm, backend: b });
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool" && m.name === "fetch_json");
    expect(toolMsg?.content).toMatch(/not valid JSON/i);
  });
});
