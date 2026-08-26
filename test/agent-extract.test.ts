import { describe, it, expect } from "vitest";
import { runAgent, extractFields } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec } from "../src/llm.js";

// Scripted mock LLM (same shape as agent.test.ts) — records what it saw.
class MockLLM implements LLMClient {
  calls: LLMMessage[][] = [];
  constructor(private script: LLMResult[]) {}
  async complete(messages: LLMMessage[], _tools: ToolSpec[]): Promise<LLMResult> {
    this.calls.push(messages);
    return this.script.shift() ?? { text: "(no more script)" };
  }
}

describe("extractFields", () => {
  it("returns clean JSON for the requested fields", async () => {
    const llm = new MockLLM([{ text: '{"price":"$9.99","title":"Widget"}' }]);
    const out = await extractFields(llm, "Widget costs $9.99", ["price", "title"]);
    expect(JSON.parse(out)).toEqual({ price: "$9.99", title: "Widget" });
  });

  it("tolerates a code fence / leading prose and grabs the JSON block", async () => {
    const llm = new MockLLM([{ text: "Here you go:\n```json\n{\"price\":\"5\"}\n```" }]);
    const out = await extractFields(llm, "price 5", ["price"]);
    expect(JSON.parse(out)).toEqual({ price: "5" });
  });

  it("fills a missing field with null and drops extras", async () => {
    const llm = new MockLLM([{ text: '{"title":"X","junk":1}' }]);
    const out = await extractFields(llm, "X", ["title", "price"]);
    expect(JSON.parse(out)).toEqual({ title: "X", price: null });
  });

  it("returns an all-null object when the model emits no JSON", async () => {
    const llm = new MockLLM([{ text: "I could not find anything." }]);
    const out = await extractFields(llm, "nothing", ["price", "title"]);
    expect(JSON.parse(out)).toEqual({ price: null, title: null });
  });
});

describe("runAgent — extract tool", () => {
  it("scrapes then extracts fields and feeds JSON back to the model", async () => {
    // 1st call: extract tool. Sub-call inside extract: the JSON. 2nd loop call: reply.
    const llm = new MockLLM([
      { toolCall: { name: "extract", args: { url: "https://shop.example.com/item", fields: ["price", "title"] } } },
      { text: '{"price":"$12","title":"Thing"}' }, // extractFields sub-call
      { toolCall: { name: "reply", args: { text: "It's $12 (Thing)." } } },
    ]);
    let scraped = "";
    const scrapeFn = async (url: string) => { scraped = url; return { title: "Item Page", content: "Thing — $12", url }; };
    const { reply } = await runAgent("price + title of that item?", { llm, scrapeFn });
    expect(reply).toBe("It's $12 (Thing).");
    expect(scraped).toBe("https://shop.example.com/item");
    // The extracted JSON must have been fed back as a tool message.
    const lastCall = llm.calls[llm.calls.length - 1]!;
    const toolMsg = lastCall.find((m) => m.role === "tool" && m.name === "extract");
    expect(toolMsg?.content).toMatch(/\$12/);
    expect(toolMsg?.content).toMatch(/Thing/);
  });

  it("refuses an SSRF extract target without scraping", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "extract", args: { url: "http://169.254.169.254/", fields: ["token"] } } },
      { toolCall: { name: "reply", args: { text: "Can't read that." } } },
    ]);
    let scrapeCalled = false;
    const scrapeFn = async (url: string) => { scrapeCalled = true; return { title: "", content: "", url }; };
    const { reply } = await runAgent("extract the token", { llm, scrapeFn });
    expect(scrapeCalled).toBe(false);
    expect(reply).toBe("Can't read that.");
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool" && m.name === "extract");
    expect(toolMsg?.content).toMatch(/refused|Blocked/i);
  });

  it("errors clearly when no fields are supplied", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "extract", args: { url: "https://example.com", fields: [] } } },
      { toolCall: { name: "reply", args: { text: "Tell me which fields." } } },
    ]);
    const scrapeFn = async (url: string) => ({ title: "", content: "", url });
    await runAgent("extract stuff", { llm, scrapeFn });
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool" && m.name === "extract");
    expect(toolMsg?.content).toMatch(/no fields/i);
  });
});
