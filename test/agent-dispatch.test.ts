import { describe, it, expect } from "vitest";
import { runAgent, TOOLS } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec, ToolCall } from "../src/llm.js";
import type { BrowserBackend } from "../src/agent.js";

// Dispatch regression tests: as the tool set grows (scrape/browse/click/type/read/
// extract/compare/search/fetch_json/reply), assert each tool the model can emit is
// wired to the right backend call and the loop reaches "reply". NOT testing the model
// — testing that the tool surface + loop dispatch stay coherent.
class ScriptLLM implements LLMClient {
  calls: LLMMessage[][] = [];
  constructor(private script: LLMResult[]) {}
  async complete(messages: LLMMessage[], _tools: ToolSpec[]): Promise<LLMResult> {
    this.calls.push(messages);
    return this.script.shift() ?? { text: "(no more script)" };
  }
}

// A backend that records which methods the loop invoked.
function recordingBackend() {
  const hits: string[] = [];
  const b: BrowserBackend = {
    scrape: async (url) => { hits.push(`scrape:${url}`); return { title: "t", content: "PRICE=$1", url }; },
    createSession: async () => { hits.push("createSession"); return { id: "s1" }; },
    navigate: async (_id, url) => { hits.push(`navigate:${url}`); return { url, title: "t" }; },
    click: async (_id, sel) => { hits.push(`click:${sel}`); },
    type: async (_id, sel) => { hits.push(`type:${sel}`); },
    readCurrent: async () => { hits.push("readCurrent"); return { title: "t", content: "text", url: "u" }; },
    releaseSession: async () => { hits.push("releaseSession"); },
    discoverLinks: async (url) => { hits.push(`discoverLinks:${url}`); return ["https://x.com/a"]; },
    fetchJson: async (url) => { hits.push(`fetchJson:${url}`); return { status: 200, contentType: "application/json", text: "{}" }; },
  };
  return { b, hits };
}

describe("tool surface", () => {
  it("exposes exactly the expected tool names", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      ["browse", "click", "compare", "extract", "fetch_json", "read", "reply", "scrape", "search", "type"].sort()
    );
  });

  it("every tool has a description and object parameters", () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.parameters.type).toBe("object");
    }
  });
});

describe("runAgent dispatch", () => {
  it("scrape -> backend.scrape", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "scrape", args: { url: "https://x.com/p" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("read it", { llm, backend: b });
    expect(hits).toContain("scrape:https://x.com/p");
  });

  it("fetch_json -> backend.fetchJson", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "fetch_json", args: { url: "https://api.x.com/d" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("api", { llm, backend: b });
    expect(hits).toContain("fetchJson:https://api.x.com/d");
  });

  it("search -> backend.discoverLinks", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "search", args: { url: "https://x.com/s" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("find", { llm, backend: b });
    expect(hits.some((h) => h.startsWith("discoverLinks:"))).toBe(true);
  });

  it("browse -> createSession + navigate; read -> readCurrent; session released", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "browse", args: { url: "https://x.com/app" } } as ToolCall },
      { toolCall: { name: "read", args: {} } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("open + read", { llm, backend: b });
    expect(hits).toContain("createSession");
    expect(hits).toContain("navigate:https://x.com/app");
    expect(hits).toContain("readCurrent");
    expect(hits).toContain("releaseSession");
  });

  it("extract -> backend.scrape (then an LLM extraction sub-call)", async () => {
    const { b, hits } = recordingBackend();
    // fetch_json/extract sub-call returns JSON when tools=[] not needed here; extract
    // uses backend.scrape then an LLM sub-call which our ScriptLLM answers as text.
    const llm = new ScriptLLM([
      { toolCall: { name: "extract", args: { url: "https://x.com/i", fields: ["price"] } } as ToolCall },
      { text: '{"price":"$1"}' }, // extractFields sub-call
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("price", { llm, backend: b });
    expect(hits).toContain("scrape:https://x.com/i");
  });

  it("click/type on the browsed session dispatch to backend.click/type", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "browse", args: { url: "https://x.com/f" } } as ToolCall },
      { toolCall: { name: "type", args: { selector: "#q", text: "hi" } } as ToolCall },
      { toolCall: { name: "click", args: { selector: "#go", label: "go" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("interact", { llm, backend: b });
    expect(hits).toContain("type:#q");
    expect(hits).toContain("click:#go");
  });
});
