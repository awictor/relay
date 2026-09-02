import { describe, it, expect } from "vitest";
import { runAgent, formatPageForModel, looksPaywalled, type BrowserBackend } from "../src/agent.js";
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
    scrape: async (url) => { log.push(`scrape:${url}`); return { title: "S", content: "scraped page body ".repeat(20), url }; },
    createSession: async () => { log.push("createSession"); return { id: "sess-1" }; },
    navigate: async (id, url) => { log.push(`navigate:${url}`); return { url, title: "Nav" }; },
    click: async (id, sel) => { log.push(`click:${sel}`); },
    type: async (id, sel, text) => { log.push(`type:${sel}=${text}`); },
    readCurrent: async (id) => { log.push("read"); return { title: "R", content: "page after actions ".repeat(20), url: "https://x" }; },
    releaseSession: async (id) => { log.push(`release:${id}`); },
    ...overrides,
  };
  return { backend, log };
}

describe("formatPageForModel (empty-read-escalation)", () => {
  it("flags a near-empty page instead of passing it through", () => {
    const out = formatPageForModel("", "https://x.com/wall", "Log in to continue");
    expect(out).toMatch(/came back nearly empty/i);
    expect(out).toMatch(/login|JavaScript|blocked/i);
  });
  it("passes through a normal-length page", () => {
    const body = "Real article text here. ".repeat(20);
    const out = formatPageForModel("Story", "https://x.com/a", body);
    expect(out).toMatch(/^TITLE: Story/);
    expect(out).toContain("Real article text");
  });
  it("flags a short paywall stub instead of summarizing it (paywall-detection)", () => {
    const stub = "The Big Story headline that teases the article. " + "You've read your last free article this month. ".repeat(5) + " To continue reading, subscribe to continue. Already a subscriber? Sign in.";
    const out = formatPageForModel("The Big Story", "https://nyt.com/a", stub);
    expect(out).toMatch(/paywalled|subscriber-only/i);
    expect(out).toMatch(/free source|web_search/i);
  });
  it("does NOT flag a long article that merely mentions 'subscribe' in a footer", () => {
    const body = "Real article body. ".repeat(120) + " Subscribe to our newsletter."; // >1500 non-ws
    const out = formatPageForModel("Story", "https://x.com/a", body);
    expect(out).toMatch(/^TITLE: Story/); // passed through, not flagged
  });
});

describe("looksPaywalled (paywall-detection)", () => {
  it("true for common subscribe/register wall language", () => {
    for (const t of ["Subscribe to continue reading", "This article is for subscribers", "Create a free account to continue", "Become a member to unlock this story", "Start your free trial"]) {
      expect(looksPaywalled(t), t).toBe(true);
    }
  });
  it("false for ordinary article text", () => {
    expect(looksPaywalled("The company reported earnings today and shares rose.")).toBe(false);
  });
});

describe("runAgent current-datetime injection (inject-current-datetime)", () => {
  it("injects a 'Right now it is ...' system message when nowMs is provided", async () => {
    const llm = new MockLLM([{ toolCall: { name: "reply", args: { text: "ok" } } }]);
    const { backend } = mockBackend();
    await runAgent("what's the news today", { llm, backend, nowMs: 1_700_000_000_000, tzOffsetMin: -300 });
    const sys = llm.calls[0]!.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).toMatch(/Right now it is .*2023.*UTC-5/);
  });
  it("omits the datetime line when nowMs is absent (back-compat)", async () => {
    const llm = new MockLLM([{ toolCall: { name: "reply", args: { text: "ok" } } }]);
    const { backend } = mockBackend();
    await runAgent("hi", { llm, backend });
    const sys = llm.calls[0]!.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).not.toMatch(/Right now it is/);
  });
});

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

  it("does NOT refuse typing a query that merely contains a trigger word (dangerous-guard-typed-text)", async () => {
    // "book"/"order"/"cancel" in the TYPED text is a search term, not a committing action — the guard
    // must look at the click target, not the payload, so a normal search actually runs.
    const llm = new MockLLM([
      { toolCall: { name: "browse", args: { url: "https://www.goodreads.com" } } },
      { toolCall: { name: "type", args: { selector: "#search", text: "the best book on gardening" } } },
      { toolCall: { name: "read", args: {} } },
      { toolCall: { name: "reply", args: { text: "here are the results" } } },
    ]);
    const { backend, log } = mockBackend();
    const { reply } = await runAgent("search goodreads for the best book on gardening", { llm, backend });
    expect(reply).toBe("here are the results");
    expect(log).toContain("type:#search=the best book on gardening"); // typed, not refused
    expect(llm.calls.flat().some((m) => m.role === "tool" && /REFUSED/.test(m.content))).toBe(false);
  });

  it("still refuses a click whose SELECTOR names a committing action even with benign label", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "browse", args: { url: "https://shop.example.com" } } },
      { toolCall: { name: "click", args: { selector: "#checkout-submit", label: "next" } } },
      { toolCall: { name: "reply", args: { text: "won't do that" } } },
    ]);
    const { backend, log } = mockBackend();
    await runAgent("proceed", { llm, backend });
    expect(log).not.toContain("click:#checkout-submit"); // selector 'submit'/'checkout' still caught
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
