import { describe, it, expect } from "vitest";
import { runAgent } from "../src/agent.js";
import { formatReply } from "../src/lib/format-reply.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec, ToolCall } from "../src/llm.js";
import type { BrowserBackend } from "../src/agent.js";

// End-to-end composition (offline): a scripted agent goes search -> compare -> reply,
// and the FINAL formatReply output is a readable line list, not raw JSON. Proves the
// tools + the SMS formatter compose into a user-facing answer.
class ChainLLM implements LLMClient {
  calls: LLMMessage[][] = [];
  constructor(private script: LLMResult[]) {}
  async complete(messages: LLMMessage[], tools: ToolSpec[]): Promise<LLMResult> {
    this.calls.push(messages);
    // extractFields sub-calls (no tools): read PRICE= from the page text handed in.
    if (tools.length === 0) {
      const prompt = messages.find((m) => m.role === "user")?.content ?? "";
      const m = prompt.match(/PRICE=(\S+)/);
      return { text: JSON.stringify({ price: m ? m[1] : null }) };
    }
    return this.script.shift() ?? { text: "(no more script)" };
  }
}

const SEARCH = "https://shop.example.com/search?q=widget";
const PAGES: Record<string, string> = {
  "https://shop.example.com/item/1": "Widget One PRICE=$10",
  "https://shop.example.com/item/2": "Widget Two PRICE=$20",
};
const LINKS = ["https://shop.example.com/item/1", "https://shop.example.com/item/2", "https://facebook.com/x"];

function backend(): BrowserBackend {
  return {
    scrape: async (url) => ({ title: url, content: PAGES[url] ?? "", url }),
    createSession: async () => ({ id: "s" }),
    navigate: async (_id, url) => ({ url, title: url }),
    click: async () => {},
    type: async () => {},
    readCurrent: async () => ({ title: "", content: "", url: "" }),
    releaseSession: async () => {},
    discoverLinks: async () => LINKS,
  };
}

describe("search -> compare -> reply composition", () => {
  it("harvests links, compares fields, and the formatted reply is readable (not JSON)", async () => {
    const llm = new ChainLLM([
      { toolCall: { name: "search", args: { url: SEARCH } } as ToolCall },
      // model then compares the two same-host links it got back
      { toolCall: { name: "compare", args: { urls: ["https://shop.example.com/item/1", "https://shop.example.com/item/2"], fields: ["price"] } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Item 1 is $10, item 2 is $20." } } as ToolCall },
    ]);
    const { reply, steps } = await runAgent("find widgets and compare their prices", { llm, backend: backend() });
    expect(steps).toBe(3);

    // The agent's reply is prose (model summarized) — formatReply passes it through, phone-sized.
    const out = formatReply(reply);
    expect(out).toBe("Item 1 is $10, item 2 is $20.");

    // And the chain actually flowed: search results, then a compare row set, reached the model.
    const flat = llm.calls.flat();
    const searchMsg = flat.find((m) => m.role === "tool" && m.name === "search");
    const compareMsg = flat.find((m) => m.role === "tool" && m.name === "compare");
    expect(searchMsg?.content).toMatch(/item\/1/);
    expect(compareMsg?.content).toMatch(/\$10/);
    expect(compareMsg?.content).toMatch(/\$20/);
  });

  it("if the model dumps the compare JSON as its reply, formatReply renders readable lines", async () => {
    // Simulate a lazy model that just returns the tool JSON as the reply text.
    const compareJson = JSON.stringify([
      { url: "https://shop.example.com/item/1", price: "$10" },
      { url: "https://shop.example.com/item/2", price: "$20" },
    ]);
    const llm = new ChainLLM([
      { toolCall: { name: "compare", args: { urls: Object.keys(PAGES), fields: ["price"] } } as ToolCall },
      { toolCall: { name: "reply", args: { text: compareJson } } as ToolCall },
    ]);
    const { reply } = await runAgent("compare", { llm, backend: backend() });
    const out = formatReply(reply);
    // Not raw JSON anymore — rendered as bullet lines with url leading.
    expect(out).not.toMatch(/^\s*\[/);
    expect(out).toContain("• url: https://shop.example.com/item/1 | price: $10");
    expect(out).toContain("• url: https://shop.example.com/item/2 | price: $20");
  });
});
