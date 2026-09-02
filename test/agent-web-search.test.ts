import { describe, it, expect } from "vitest";
import { runAgent } from "../src/agent.js";
import { unwrapBingUrl } from "../src/anvil.js";
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

function backend(over: Partial<BrowserBackend> = {}): BrowserBackend {
  return {
    scrape: async (url) => ({ title: url, content: "", url }),
    createSession: async () => ({ id: "s" }),
    navigate: async (_id, url) => ({ url, title: url }),
    click: async () => {},
    type: async () => {},
    readCurrent: async () => ({ title: "", content: "", url: "" }),
    releaseSession: async () => {},
    discoverLinks: async () => [],
    ...over,
  };
}

describe("unwrapBingUrl", () => {
  it("decodes a /ck/a?...&u=a1<base64url> redirect to the real target", () => {
    const real = "https://en.wikipedia.org/wiki/Paris";
    const b64 = Buffer.from(real, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const wrapped = `https://www.bing.com/ck/a?!&&p=abc&u=a1${b64}&ntb=1`;
    expect(unwrapBingUrl(wrapped)).toBe(real);
  });
  it("passes a non-bing / non-ck url through unchanged", () => {
    expect(unwrapBingUrl("https://example.com/page")).toBe("https://example.com/page");
    expect(unwrapBingUrl("https://www.bing.com/search?q=x")).toBe("https://www.bing.com/search?q=x");
  });
  it("returns input on garbage", () => {
    expect(unwrapBingUrl("not a url")).toBe("not a url");
  });
});

describe("runAgent — web_search tool (m: product-loop)", () => {
  it("hands the model title/url/snippet for a plain-language query", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "web_search", args: { query: "who won the game" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "The home team won." } } as ToolCall },
    ]);
    let gotQuery = "";
    const b = backend({
      webSearch: async (q) => { gotQuery = q; return [
        { title: "Game recap", url: "https://espn.com/recap", snippet: "Home team won 3-1." },
        { title: "Box score", url: "https://sports.example.com/box", snippet: "Full stats." },
      ]; },
    });
    await runAgent("who won the game", { llm, backend: b });
    expect(gotQuery).toBe("who won the game");
    const toolMsg = llm.calls[llm.calls.length - 1]!.find((m) => m.role === "tool" && m.name === "web_search");
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content).toMatch(/espn\.com\/recap/);
    expect(toolMsg!.content).toMatch(/Home team won 3-1/);
  });

  it("reports no results cleanly", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "web_search", args: { query: "asdfqwer nonsense" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Nothing found." } } as ToolCall },
    ]);
    const b = backend({ webSearch: async () => [] });
    await runAgent("search nonsense", { llm, backend: b });
    const toolMsg = llm.calls[llm.calls.length - 1]!.find((m) => m.role === "tool" && m.name === "web_search");
    expect(toolMsg!.content).toMatch(/No results/i);
  });

  it("errors cleanly when no query given (no backend call)", async () => {
    let called = false;
    const llm = new ScriptLLM([
      { toolCall: { name: "web_search", args: {} } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    const b = backend({ webSearch: async () => { called = true; return []; } });
    await runAgent("x", { llm, backend: b });
    expect(called).toBe(false);
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool" && m.name === "web_search");
    expect(toolMsg!.content).toMatch(/no query/i);
  });

  it("reports unavailable when the backend has no webSearch (back-compat)", async () => {
    const llm = new ScriptLLM([
      { toolCall: { name: "web_search", args: { query: "x" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    const b = backend(); // no webSearch
    await runAgent("x", { llm, backend: b });
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool" && m.name === "web_search");
    expect(toolMsg!.content).toMatch(/isn't available|not available/i);
  });
});
