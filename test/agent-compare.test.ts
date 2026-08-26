import { describe, it, expect } from "vitest";
import { runAgent } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec, ToolCall } from "../src/llm.js";
import type { BrowserBackend } from "../src/agent.js";

// LLM that returns queued tool calls, and for the extractFields sub-call (no tools,
// a bare user prompt) returns JSON derived from the page text it was handed.
class CompareLLM implements LLMClient {
  calls: LLMMessage[][] = [];
  constructor(private script: LLMResult[]) {}
  async complete(messages: LLMMessage[], tools: ToolSpec[]): Promise<LLMResult> {
    this.calls.push(messages);
    // extractFields calls with tools=[] and a user prompt containing the page text.
    if (tools.length === 0) {
      const prompt = messages.find((m) => m.role === "user")?.content ?? "";
      const m = prompt.match(/PRICE=(\S+)/);
      return { text: JSON.stringify({ price: m ? m[1] : null }) };
    }
    return this.script.shift() ?? { text: "(no more script)" };
  }
}

function backendWithPages(pages: Record<string, string>): BrowserBackend {
  return {
    scrape: async (url) => ({ title: url, content: pages[url] ?? "", url }),
    createSession: async () => ({ id: "s" }),
    navigate: async (_id, url) => ({ url, title: url }),
    click: async () => {},
    type: async () => {},
    readCurrent: async () => ({ title: "", content: "", url: "" }),
    releaseSession: async () => {},
  };
}

describe("runAgent — compare tool", () => {
  it("extracts the same field from multiple pages into a JSON array", async () => {
    const llm = new CompareLLM([
      { toolCall: { name: "compare", args: { urls: ["https://a.example.com", "https://b.example.com"], fields: ["price"] } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "A is $10, B is $20." } } as ToolCall },
    ]);
    const backend = backendWithPages({
      "https://a.example.com": "widget PRICE=$10",
      "https://b.example.com": "widget PRICE=$20",
    });
    const { reply } = await runAgent("compare price across a and b", { llm, backend });
    expect(reply).toBe("A is $10, B is $20.");
    // The compare tool result fed back must contain both rows with their urls + prices.
    const lastCall = llm.calls[llm.calls.length - 1]!;
    const toolMsg = lastCall.find((m) => m.role === "tool" && m.name === "compare");
    expect(toolMsg).toBeTruthy();
    const rows = JSON.parse(toolMsg!.content.slice(toolMsg!.content.indexOf("[")));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ url: "https://a.example.com", price: "$10" });
    expect(rows[1]).toMatchObject({ url: "https://b.example.com", price: "$20" });
  });

  it("dedups repeated urls and skips unsafe (SSRF) targets", async () => {
    const llm = new CompareLLM([
      { toolCall: { name: "compare", args: { urls: ["https://a.example.com", "https://a.example.com", "http://169.254.169.254/"], fields: ["price"] } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "done" } } as ToolCall },
    ]);
    const backend = backendWithPages({ "https://a.example.com": "PRICE=$10" });
    await runAgent("compare", { llm, backend });
    const toolMsg = llm.calls[llm.calls.length - 1]!.find((m) => m.role === "tool" && m.name === "compare");
    const rows = JSON.parse(toolMsg!.content.slice(toolMsg!.content.indexOf("[")));
    expect(rows).toHaveLength(1); // dedup + SSRF drop -> only one page
    expect(toolMsg!.content).toMatch(/skipped 1 unsafe/);
  });

  it("errors when urls or fields are empty", async () => {
    const llm = new CompareLLM([
      { toolCall: { name: "compare", args: { urls: [], fields: ["price"] } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "need urls" } } as ToolCall },
    ]);
    const backend = backendWithPages({});
    await runAgent("compare nothing", { llm, backend });
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool" && m.name === "compare");
    expect(toolMsg!.content).toMatch(/no urls/i);
  });

  it("a per-URL scrape failure becomes an all-null row, not a whole failure", async () => {
    const llm = new CompareLLM([
      { toolCall: { name: "compare", args: { urls: ["https://ok.example.com", "https://bad.example.com"], fields: ["price"] } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "done" } } as ToolCall },
    ]);
    const backend: BrowserBackend = {
      ...backendWithPages({ "https://ok.example.com": "PRICE=$10" }),
      scrape: async (url) => {
        if (url.includes("bad")) throw new Error("boom");
        return { title: url, content: "PRICE=$10", url };
      },
    };
    await runAgent("compare", { llm, backend });
    const toolMsg = llm.calls[llm.calls.length - 1]!.find((m) => m.role === "tool" && m.name === "compare");
    const rows = JSON.parse(toolMsg!.content.slice(toolMsg!.content.indexOf("[")));
    expect(rows).toHaveLength(2);
    expect(rows.find((r: { url: string }) => r.url.includes("bad")).price).toBeNull();
  });
});
