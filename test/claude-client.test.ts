import { describe, it, expect } from "vitest";
import { ClaudeClient, toClaude, type LLMMessage, type ToolSpec } from "../src/llm.js";

// m24 claude-2: ClaudeClient is exercised fully OFFLINE via an injected transport (no
// ANTHROPIC_API_KEY, no network). We assert the request BODY shape sent to the Messages API and
// that both a tool_use and a text-only response parse into our neutral LLMResult.

const TOOLS: ToolSpec[] = [
  { name: "scrape", description: "read a page", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
];

// A fake transport that captures the request and returns a canned Anthropic response.
function fakeTransport(response: unknown, status = 200) {
  const captured: { url?: string; body?: any; headers?: any } = {};
  const fn = async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.headers = init.headers;
    captured.body = JSON.parse(String(init.body));
    return new Response(JSON.stringify(response), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fn, captured };
}

describe("toClaude mapping", () => {
  it("splits system out, maps user/assistant, and ties a tool_result to the prior tool_use", () => {
    const msgs: LLMMessage[] = [
      { role: "system", content: "you are relay" },
      { role: "user", content: "top HN story" },
      { role: "assistant", content: "", toolCall: { name: "scrape", args: { url: "https://news.ycombinator.com" } } },
      { role: "tool", name: "scrape", content: "TITLE: Hacker News" },
    ];
    const { system, messages } = toClaude(msgs);
    expect(system).toBe("you are relay");
    expect(messages[0]).toEqual({ role: "user", content: "top HN story" });
    // assistant turn carries a tool_use block with an id
    const asst = messages[1]!.content as any[];
    const use = asst.find((b) => b.type === "tool_use");
    expect(use).toMatchObject({ type: "tool_use", name: "scrape", input: { url: "https://news.ycombinator.com" } });
    expect(use.id).toBeTruthy();
    // the tool turn is a user turn with a tool_result referencing that same id
    const toolTurn = messages[2]!.content as any[];
    expect(toolTurn[0]).toMatchObject({ type: "tool_result", tool_use_id: use.id, content: "TITLE: Hacker News" });
  });

  it("concatenates multiple system messages", () => {
    expect(toClaude([{ role: "system", content: "a" }, { role: "system", content: "b" }]).system).toBe("a\n\nb");
  });
});

describe("ClaudeClient.complete (offline via injected transport)", () => {
  it("sends the right request shape: model, system, messages, tools with input_schema", async () => {
    const { fn, captured } = fakeTransport({ content: [{ type: "text", text: "hi" }] });
    const c = new ClaudeClient("test-key", { model: "claude-sonnet-5", fetch: fn });
    await c.complete([{ role: "system", content: "sys" }, { role: "user", content: "hey" }], TOOLS);
    expect(captured.url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured.headers["x-api-key"]).toBe("test-key");
    expect(captured.headers["anthropic-version"]).toBeTruthy();
    expect(captured.body.model).toBe("claude-sonnet-5");
    expect(captured.body.system).toBe("sys");
    expect(captured.body.messages[0]).toEqual({ role: "user", content: "hey" });
    expect(captured.body.tools[0]).toMatchObject({ name: "scrape", input_schema: { type: "object" } });
  });

  it("parses a tool_use response into LLMResult.toolCall", async () => {
    const { fn } = fakeTransport({
      content: [
        { type: "text", text: "let me look" },
        { type: "tool_use", id: "toolu_1", name: "scrape", input: { url: "https://x.com" } },
      ],
    });
    const c = new ClaudeClient("k", { fetch: fn });
    const res = await c.complete([{ role: "user", content: "read x" }], TOOLS);
    expect(res.text).toBe("let me look");
    expect(res.toolCall).toEqual({ name: "scrape", args: { url: "https://x.com" } });
  });

  it("parses a text-only response into LLMResult.text (no toolCall)", async () => {
    const { fn } = fakeTransport({ content: [{ type: "text", text: "the answer is 42" }] });
    const c = new ClaudeClient("k", { fetch: fn });
    const res = await c.complete([{ role: "user", content: "q" }], []);
    expect(res.text).toBe("the answer is 42");
    expect(res.toolCall).toBeUndefined();
  });

  it("surfaces an API error with the status so it can be classified (5xx transient)", async () => {
    const { fn } = fakeTransport({ error: { message: "overloaded" } }, 529);
    const c = new ClaudeClient("k", { fetch: fn });
    await expect(c.complete([{ role: "user", content: "q" }], [])).rejects.toThrow(/529/);
  });

  it("throws without an API key (never silently no-ops)", async () => {
    const c = new ClaudeClient("");
    await expect(c.complete([{ role: "user", content: "q" }], [])).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
