import { describe, it, expect } from "vitest";
import { runAgent, type BrowserBackend } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec } from "../src/llm.js";

class MockLLM implements LLMClient {
  calls: LLMMessage[][] = [];
  constructor(private script: LLMResult[]) {}
  async complete(messages: LLMMessage[], _tools: ToolSpec[]): Promise<LLMResult> {
    this.calls.push(messages.map((m) => ({ ...m })));
    return this.script.shift() ?? { text: "(no more script)" };
  }
}

function mockBackend(overrides: Partial<BrowserBackend> = {}): { backend: BrowserBackend; log: string[] } {
  const log: string[] = [];
  const backend: BrowserBackend = {
    scrape: async (url) => { log.push(`scrape:${url}`); return { title: "S", content: "scraped", url }; },
    createSession: async () => { log.push("createSession"); return { id: "sess-1" }; },
    navigate: async (id, url) => { log.push(`navigate:${url}`); return { url, title: "Nav" }; },
    click: async (id, sel) => { log.push(`click:${sel}`); },
    type: async (id, sel, text) => { log.push(`type:${sel}=${text}`); },
    readCurrent: async (id) => { log.push("read"); return { title: "R", content: "page after actions", url: "https://x" }; },
    releaseSession: async (id) => { log.push(`release:${id}`); },
    ...overrides,
  };
  return { backend, log };
}

describe("runAgent multi-step browse", () => {
  it("browse -> type -> read -> reply, releases the session", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "browse", args: { url: "https://example.com/search" } } },
      { toolCall: { name: "type", args: { selector: "#q", text: "hello" } } },
      { toolCall: { name: "read", args: {} } },
      { toolCall: { name: "reply", args: { text: "found it" } } },
    ]);
    const { backend, log } = mockBackend();
    const { reply } = await runAgent("search example for hello", { llm, backend });
    expect(reply).toBe("found it");
    expect(log).toEqual(["createSession", "navigate:https://example.com/search", "type:#q=hello", "read", "release:sess-1"]);
  });

  it("refuses a destructive click and never calls the backend click", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "browse", args: { url: "https://shop.example.com" } } },
      { toolCall: { name: "click", args: { selector: "#buy", label: "Confirm purchase" } } },
      { toolCall: { name: "reply", args: { text: "I won't complete a purchase for you." } } },
    ]);
    const { backend, log } = mockBackend();
    const { reply } = await runAgent("buy the item", { llm, backend });
    expect(reply).toMatch(/purchase/i);
    expect(log).not.toContain("click:#buy"); // dangerous guard blocked it
    // the model saw the REFUSED tool result
    const afterClick = llm.calls[2]!;
    expect(afterClick.some((m) => m.role === "tool" && /REFUSED/.test(m.content))).toBe(true);
  });

  it("click/type before browse errors (no session)", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "click", args: { selector: "#x" } } },
      { toolCall: { name: "reply", args: { text: "ok" } } },
    ]);
    const { backend, log } = mockBackend();
    await runAgent("click x", { llm, backend });
    expect(log).not.toContain("createSession");
    const after = llm.calls[1]!;
    expect(after.some((m) => m.role === "tool" && /no page open/i.test(m.content))).toBe(true);
  });
});
