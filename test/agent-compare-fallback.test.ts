import { describe, it, expect } from "vitest";
import { runAgent } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec, ToolCall } from "../src/llm.js";
import type { BrowserBackend } from "../src/agent.js";

// LLM answers extractFields sub-calls (tools=[]) by reading PRICE= from the text handed
// in — so a page whose price only lives in JSON-LD/meta needs the structured fallback.
class CmpLLM implements LLMClient {
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

// Per-URL text + structured maps; records structured calls per url.
function backend(text: Record<string, string>, structured: Record<string, string>) {
  const structuredCalls: string[] = [];
  const b: BrowserBackend = {
    scrape: async (url) => ({ title: url, content: text[url] ?? "", url }),
    createSession: async () => ({ id: "s" }),
    navigate: async (_id, url) => ({ url, title: url }),
    click: async () => {},
    type: async () => {},
    readCurrent: async () => ({ title: "", content: "", url: "" }),
    releaseSession: async () => {},
    discoverLinks: async () => [],
    fetchJson: async () => ({ status: 200, contentType: "application/json", text: "{}" }),
    extractStructured: async (url) => { structuredCalls.push(url); return structured[url] ?? ""; },
  };
  return { b, structuredCalls };
}

describe("runAgent — compare JSON-LD/meta fallback per row", () => {
  it("uses structured data for a row whose visible text has no price", async () => {
    const A = "https://a.example.com/item";
    const B = "https://b.example.com/item";
    const { b, structuredCalls } = backend(
      { [A]: "PRICE=$10", [B]: "loading..." },      // B's text has no price
      { [A]: "unused", [B]: "JSON-LD PRICE=$20" }   // B's price is in structured data
    );
    const llm = new CmpLLM([
      { toolCall: { name: "compare", args: { urls: [A, B], fields: ["price"] } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "A $10, B $20" } } as ToolCall },
    ]);
    await runAgent("compare prices", { llm, backend: b });
    const toolMsg = llm.calls[llm.calls.length - 1]!.find((m) => m.role === "tool" && m.name === "compare");
    const rows = JSON.parse(toolMsg!.content.slice(toolMsg!.content.indexOf("[")));
    expect(rows.find((r: { url: string }) => r.url === A).price).toBe("$10"); // text sufficed
    expect(rows.find((r: { url: string }) => r.url === B).price).toBe("$20"); // structured fallback
    // Fallback only fired for B (A's text pass found the price).
    expect(structuredCalls).toEqual([B]);
  });
});
