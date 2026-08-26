import { describe, it, expect } from "vitest";
import { runAgent, extractFieldsResult } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec, ToolCall } from "../src/llm.js";
import type { BrowserBackend } from "../src/agent.js";

// LLM that answers extractFields sub-calls (tools=[]) by pulling PRICE= from whatever
// text it's handed — so text vs JSON-LD input produce different results.
class ExtractLLM implements LLMClient {
  calls: LLMMessage[][] = [];
  constructor(private script: LLMResult[]) {}
  async complete(messages: LLMMessage[], tools: ToolSpec[]): Promise<LLMResult> {
    this.calls.push(messages);
    if (tools.length === 0) {
      const prompt = messages.find((m) => m.role === "user")?.content ?? "";
      const m = prompt.match(/PRICE=(\S+)/);
      return { text: JSON.stringify({ price: m ? m[1] : null }) };
    }
    return this.script.shift() ?? { text: "(no more)" };
  }
}

function backend(opts: { text: string; structured?: string }): BrowserBackend & { structuredCalls: number } {
  const b = {
    structuredCalls: 0,
    scrape: async (url: string) => ({ title: "t", content: opts.text, url }),
    createSession: async () => ({ id: "s" }),
    navigate: async (_id: string, url: string) => ({ url, title: "t" }),
    click: async () => {},
    type: async () => {},
    readCurrent: async () => ({ title: "", content: "", url: "" }),
    releaseSession: async () => {},
    discoverLinks: async () => [],
    fetchJson: async () => ({ status: 200, contentType: "application/json", text: "{}" }),
    extractStructured: async () => { b.structuredCalls++; return opts.structured ?? ""; },
  };
  return b;
}

describe("extractFieldsResult allNull flag", () => {
  it("reports allNull when nothing matches", async () => {
    const llm = new ExtractLLM([]);
    const r = await extractFieldsResult(llm, "no price here", ["price"]);
    expect(r.allNull).toBe(true);
  });
  it("reports not-allNull when a field is found", async () => {
    const llm = new ExtractLLM([]);
    const r = await extractFieldsResult(llm, "PRICE=$5", ["price"]);
    expect(r.allNull).toBe(false);
    expect(JSON.parse(r.json)).toEqual({ price: "$5" });
  });
});

describe("runAgent — extract JSON-LD/meta fallback", () => {
  it("falls back to extractStructured when the text pass is all-null", async () => {
    const llm = new ExtractLLM([
      { toolCall: { name: "extract", args: { url: "https://spa.example.com/item", fields: ["price"] } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "done" } } as ToolCall },
    ]);
    // Visible text has no price; JSON-LD/meta does.
    const b = backend({ text: "just a spinner", structured: "JSON-LD:\n{...} PRICE=$42" });
    await runAgent("price?", { llm, backend: b });
    expect(b.structuredCalls).toBe(1); // fallback was invoked
    const toolMsg = llm.calls[llm.calls.length - 1]!.find((m) => m.role === "tool" && m.name === "extract");
    expect(toolMsg?.content).toMatch(/\$42/); // used the structured data
  });

  it("does NOT call the fallback when the text pass already found data", async () => {
    const llm = new ExtractLLM([
      { toolCall: { name: "extract", args: { url: "https://x.com/i", fields: ["price"] } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "done" } } as ToolCall },
    ]);
    const b = backend({ text: "PRICE=$10", structured: "PRICE=$999" });
    await runAgent("price?", { llm, backend: b });
    expect(b.structuredCalls).toBe(0); // text pass sufficed
    const toolMsg = llm.calls[llm.calls.length - 1]!.find((m) => m.role === "tool" && m.name === "extract");
    expect(toolMsg?.content).toMatch(/\$10/);
    expect(toolMsg?.content).not.toMatch(/\$999/);
  });

  it("keeps all-null when neither text nor structured has the field", async () => {
    const llm = new ExtractLLM([
      { toolCall: { name: "extract", args: { url: "https://x.com/i", fields: ["price"] } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "not found" } } as ToolCall },
    ]);
    const b = backend({ text: "nothing", structured: "also nothing" });
    await runAgent("price?", { llm, backend: b });
    expect(b.structuredCalls).toBe(1);
    const toolMsg = llm.calls[llm.calls.length - 1]!.find((m) => m.role === "tool" && m.name === "extract");
    expect(toolMsg?.content).toMatch(/"price": null/);
  });
});
