import { describe, it, expect } from "vitest";
import { runAgent } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec } from "../src/llm.js";

// Scripted mock LLM: returns a queued result per call, records what it saw.
class MockLLM implements LLMClient {
  calls: LLMMessage[][] = [];
  constructor(private script: LLMResult[]) {}
  async complete(messages: LLMMessage[], _tools: ToolSpec[]): Promise<LLMResult> {
    this.calls.push(messages);
    return this.script.shift() ?? { text: "(no more script)" };
  }
}

describe("runAgent", () => {
  it("runs a scrape tool call, then replies with a result derived from it", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "scrape", args: { url: "https://news.ycombinator.com" } } },
      { toolCall: { name: "reply", args: { text: "Top story: Foo (123 pts)" } } },
    ]);
    const scrapeFn = async (url: string) => ({ title: "Hacker News", content: "Foo — 123 points", url });
    const { reply, steps } = await runAgent("top HN story?", { llm, scrapeFn });
    expect(reply).toBe("Top story: Foo (123 pts)");
    expect(steps).toBe(2);
    // The scrape result must have been fed back to the LLM on the 2nd call.
    const secondCallMsgs = llm.calls[1]!;
    expect(secondCallMsgs.some((m) => m.role === "tool" && m.content.includes("Foo"))).toBe(true);
  });

  it("blocks an SSRF scrape target and reports the error to the model", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "scrape", args: { url: "http://169.254.169.254/latest/meta-data" } } },
      { toolCall: { name: "reply", args: { text: "I couldn't fetch that." } } },
    ]);
    let scrapeCalled = false;
    const scrapeFn = async (url: string) => { scrapeCalled = true; return { title: "", content: "", url }; };
    const { reply } = await runAgent("read the metadata endpoint", { llm, scrapeFn });
    expect(scrapeCalled).toBe(false); // SSRF guard prevented the fetch
    expect(reply).toBe("I couldn't fetch that.");
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool");
    expect(toolMsg?.content).toMatch(/refused|Blocked/i);
  });

  it("treats a direct text answer (no tool call) as the reply", async () => {
    const llm = new MockLLM([{ text: "42" }]);
    const { reply, steps } = await runAgent("what is 6x7?", { llm });
    expect(reply).toBe("42");
    expect(steps).toBe(1);
  });

  it("does not loop forever — stops at the step budget", async () => {
    // Always returns a scrape call; runAgent must bail at MAX_STEPS and force a final answer.
    const forever: LLMClient = {
      async complete() { return { toolCall: { name: "scrape", args: { url: "https://example.com" } } }; },
    };
    const scrapeFn = async (url: string) => ({ title: "x", content: "y", url });
    const { reply } = await runAgent("loop", { llm: forever, scrapeFn });
    expect(typeof reply).toBe("string");
    expect(reply.length).toBeGreaterThan(0);
  });
});
