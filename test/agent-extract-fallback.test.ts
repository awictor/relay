import { describe, it, expect } from "vitest";
import { runAgent, extractFieldsResult, extractListResult, extractOne } from "../src/agent.js";
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

describe("extractListResult (extract-across-pages)", () => {
  // An LLM that echoes a scripted array as its JSON output.
  const arrayLLM = (arr: unknown): LLMClient => ({ async complete() { return { text: JSON.stringify(arr) }; } } as unknown as LLMClient);

  it("returns rows normalized to the requested fields, capped at limit", async () => {
    const llm = arrayLLM([
      { title: "A", price: "$1", junk: "x" }, { title: "B", price: "$2" }, { title: "C", price: "$3" },
    ]);
    const r = await extractListResult(llm, "page", ["title", "price"], 2);
    expect(r.count).toBe(2);                             // capped
    expect(JSON.parse(r.json)).toEqual([{ title: "A", price: "$1" }, { title: "B", price: "$2" }]); // junk dropped
  });

  it("dedupes by the first field's value", async () => {
    const llm = arrayLLM([{ title: "A", price: "$1" }, { title: "A", price: "$9" }, { title: "B", price: "$2" }]);
    const r = await extractListResult(llm, "page", ["title", "price"], 10);
    expect(r.count).toBe(2); // the second "A" dropped
  });

  it("skips all-null junk rows", async () => {
    const llm = arrayLLM([{ title: "A", price: "$1" }, { title: null, price: null }]);
    const r = await extractListResult(llm, "page", ["title", "price"], 10);
    expect(r.count).toBe(1);
  });

  it("returns [] / count 0 on a non-array or unparseable response", async () => {
    expect((await extractListResult(arrayLLM({ not: "an array" }), "p", ["title"], 5)).count).toBe(0);
    const junkLLM = { async complete() { return { text: "no json here" }; } } as unknown as LLMClient;
    expect((await extractListResult(junkLLM, "p", ["title"], 5))).toEqual({ json: "[]", count: 0 });
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

// DEV-0197: extractOne directly — return contract + the extractStructured-absent guard branch that
// the runAgent-level tests above don't isolate (agent.ts:458 `allNull && backend.extractStructured`).
describe("extractOne (orchestrator)", () => {
  it("text pass succeeds → returns the json + the scrape title, no structured call", async () => {
    const llm = new ExtractLLM([]);
    const b = backend({ text: "PRICE=$7", structured: "PRICE=$999" });
    const r = await extractOne(llm, b, "https://x.com/i", ["price"]);
    expect(JSON.parse(r.json)).toEqual({ price: "$7" });
    expect(r.title).toBe("t");
    expect(b.structuredCalls).toBe(0);
  });

  it("text all-null + structured has it → retry result used", async () => {
    const llm = new ExtractLLM([]);
    const b = backend({ text: "spinner", structured: "PRICE=$42" });
    const r = await extractOne(llm, b, "https://x.com/i", ["price"]);
    expect(JSON.parse(r.json)).toEqual({ price: "$42" });
    expect(b.structuredCalls).toBe(1);
  });

  it("text all-null + backend WITHOUT extractStructured → stays all-null, never throws (the && guard)", async () => {
    const llm = new ExtractLLM([]);
    const b = backend({ text: "spinner" });
    // remove the optional capability entirely to exercise the `&& backend.extractStructured` guard
    delete (b as { extractStructured?: unknown }).extractStructured;
    const r = await extractOne(llm, b, "https://x.com/i", ["price"]);
    expect(JSON.parse(r.json)).toEqual({ price: null });
    expect(r.title).toBe("t");
  });

  it("text all-null + extractStructured throws → falls back to the all-null json (caught)", async () => {
    const llm = new ExtractLLM([]);
    const b = backend({ text: "spinner" });
    (b as { extractStructured: () => Promise<string> }).extractStructured = async () => { throw new Error("boom"); };
    const r = await extractOne(llm, b, "https://x.com/i", ["price"]);
    expect(JSON.parse(r.json)).toEqual({ price: null }); // .catch(()=>"") -> empty -> keeps all-null
  });
});
