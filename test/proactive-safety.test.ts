import { describe, it, expect } from "vitest";
import { runAgent, type BrowserBackend } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec } from "../src/llm.js";

// m8 pobs-3: a PROACTIVE (scheduled/recipe) task runs through the SAME runAgent as inbound,
// so it inherits the dangerous-action guard + step bound. These pin that a scheduled task
// cannot do something an inbound message would refuse.
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
    scrape: async (url) => { log.push(`scrape:${url}`); return { title: "S", content: "x", url }; },
    createSession: async () => { log.push("createSession"); return { id: "s1" }; },
    navigate: async (_id, url) => { log.push(`navigate:${url}`); return { url, title: "N" }; },
    click: async (_id, sel) => { log.push(`click:${sel}`); },
    type: async (_id, sel, text) => { log.push(`type:${sel}=${text}`); },
    readCurrent: async () => { log.push("read"); return { title: "R", content: "page", url: "https://x" }; },
    releaseSession: async (id) => { log.push(`release:${id}`); },
    ...overrides,
  };
  return { backend, log };
}

describe("proactive tasks inherit inbound safety (m8 pobs-3)", () => {
  it("a scheduled task that tries a destructive click is REFUSED — no backend.click", async () => {
    // This is exactly what the runner passes to runAgent: the recipe/schedule task text,
    // fresh (no history). The agent tries browse -> a 'delete account' click -> the guard fires.
    const llm = new MockLLM([
      { toolCall: { name: "browse", args: { url: "https://acct.example.com/settings" } } },
      { toolCall: { name: "click", args: { selector: "#delete", label: "delete my account" } } },
      { toolCall: { name: "reply", args: { text: "I won't delete the account on my own." } } },
    ]);
    const { backend, log } = mockBackend();
    const { reply } = await runAgent("delete my account on acct.example.com", { llm, backend }, []);
    // The destructive click never reached the backend.
    expect(log.some((l) => l.startsWith("click:"))).toBe(false);
    // The tool result told the model it was refused.
    const refused = llm.calls.flat().some((m) => m.role === "tool" && /REFUSED/.test(m.content));
    expect(refused).toBe(true);
    expect(reply).toMatch(/won't|cannot|can't/i);
  });

  it("a scheduled task is bounded by RELAY_MAX_STEPS (can't loop forever)", async () => {
    // An LLM that never calls reply — runAgent must stop at the step budget and return.
    const forever: LLMClient = { async complete() { return { toolCall: { name: "scrape", args: { url: "https://x.com" } } }; } };
    const { backend } = mockBackend();
    const { reply, steps } = await runAgent("keep scraping forever", { llm: forever, backend }, []);
    expect(typeof reply).toBe("string");
    expect(steps).toBeLessThanOrEqual(Number(process.env.RELAY_MAX_STEPS ?? 8));
  });
});
