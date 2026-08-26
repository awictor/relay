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

function backend(links: string[]): BrowserBackend {
  return {
    scrape: async (url) => ({ title: url, content: "", url }),
    createSession: async () => ({ id: "s" }),
    navigate: async (_id, url) => ({ url, title: url }),
    click: async () => {},
    type: async () => {},
    readCurrent: async () => ({ title: "", content: "", url: "" }),
    releaseSession: async () => {},
    discoverLinks: async () => links,
  };
}

const SEARCH = "https://shop.example.com/search?q=widget";

describe("runAgent — search tool", () => {
  it("returns same-host candidate links and drops the search page + offsite", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "search", args: { url: SEARCH } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Found some." } } as ToolCall },
    ]);
    const b = backend([
      SEARCH, // the search page itself -> dropped
      "https://shop.example.com/item/1",
      "https://shop.example.com/item/2",
      "https://facebook.com/shop", // offsite -> dropped (same-host pool has >=3? no, 2 -> fallback keeps it)
      "https://shop.example.com/item/3",
    ]);
    await runAgent("find widgets", { llm, backend: b });
    const toolMsg = llm.calls[llm.calls.length - 1]!.find((m) => m.role === "tool" && m.name === "search");
    expect(toolMsg).toBeTruthy();
    const links = JSON.parse(toolMsg!.content.slice(toolMsg!.content.indexOf("["), toolMsg!.content.lastIndexOf("]") + 1));
    // same-host pool has 3 (item/1,2,3) >= 3 so offsite + search page are excluded
    expect(links).toContain("https://shop.example.com/item/1");
    expect(links).toContain("https://shop.example.com/item/3");
    expect(links).not.toContain(SEARCH);
    expect(links).not.toContain("https://facebook.com/shop");
  });

  it("SSRF-filters harvested links", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "search", args: { url: SEARCH } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    const b = backend([
      "https://shop.example.com/item/1",
      "http://169.254.169.254/latest", // SSRF -> dropped
      "https://shop.example.com/item/2",
      "https://shop.example.com/item/3",
    ]);
    await runAgent("find", { llm, backend: b });
    const toolMsg = llm.calls[llm.calls.length - 1]!.find((m) => m.role === "tool" && m.name === "search");
    expect(toolMsg!.content).not.toMatch(/169\.254/);
  });

  it("refuses an unsafe search url without harvesting", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "search", args: { url: "http://localhost:8080/admin" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "no" } } as ToolCall },
    ]);
    let harvested = false;
    const b: BrowserBackend = { ...backend([]), discoverLinks: async () => { harvested = true; return []; } };
    await runAgent("search admin", { llm, backend: b });
    expect(harvested).toBe(false);
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool" && m.name === "search");
    expect(toolMsg!.content).toMatch(/refused|Blocked/i);
  });

  it("honors the limit param (capped)", async () => {
    const many = Array.from({ length: 15 }, (_, i) => `https://shop.example.com/item/${i}`);
    const llm = new ScriptLLM([
      { toolCall: { name: "search", args: { url: SEARCH, limit: 3 } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("find", { llm, backend: backend(many) });
    const toolMsg = llm.calls[llm.calls.length - 1]!.find((m) => m.role === "tool" && m.name === "search");
    const links = JSON.parse(toolMsg!.content.slice(toolMsg!.content.indexOf("["), toolMsg!.content.lastIndexOf("]") + 1));
    expect(links).toHaveLength(3);
  });
});
