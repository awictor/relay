import { describe, it, expect } from "vitest";
import { runAgent, resolveMaxSteps } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec } from "../src/llm.js";

describe("resolveMaxSteps (DEV-0161)", () => {
  it("a valid positive integer string is used", () => {
    expect(resolveMaxSteps("5")).toBe(5);
    expect(resolveMaxSteps("12.9")).toBe(12); // floored
  });
  it("garbage / 0 / negative / undefined fall back to the default (never 0 = dead bot)", () => {
    for (const bad of ["abc", "0", "-3", "", undefined, "NaN"]) {
      expect(resolveMaxSteps(bad), String(bad)).toBe(8);
    }
    expect(resolveMaxSteps("abc", 4)).toBe(4); // custom fallback honored
  });
});

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
    const scrapeFn = async (url: string) => ({ title: "Hacker News", content: "Foo — 123 points. " + "more story text ".repeat(20), url });
    const { reply, steps } = await runAgent("top HN story?", { llm, scrapeFn });
    expect(reply).toBe("Top story: Foo (123 pts)");
    expect(steps).toBe(2);
    // The scrape result must have been fed back to the LLM on the 2nd call.
    const secondCallMsgs = llm.calls[1]!;
    expect(secondCallMsgs.some((m) => m.role === "tool" && m.content.includes("Foo"))).toBe(true);
  });

  it("a near-empty scraped page is flagged to the model, not answered from (empty-read-escalation)", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "scrape", args: { url: "https://paywall.example.com/x" } } },
      { toolCall: { name: "reply", args: { text: "That page needs a login." } } },
    ]);
    const scrapeFn = async (url: string) => ({ title: "", content: "Please sign in", url }); // ~13 chars
    await runAgent("summarize this", { llm, scrapeFn });
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool");
    expect(toolMsg!.content).toMatch(/came back nearly empty/i);
  });

  it("transcript tool feeds a YouTube transcript to the model (video-transcript-summary)", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "transcript", args: { url: "https://youtu.be/dQw4w9WgXcQ" } } },
      { toolCall: { name: "reply", args: { text: "The video explains X." } } },
    ]);
    let seenUrl = "";
    const backend = {
      scrape: async (url: string) => ({ title: "", content: "", url }),
      createSession: async () => ({ id: "s" }),
      navigate: async (_i: string, url: string) => ({ url, title: "" }),
      click: async () => {}, type: async () => {},
      readCurrent: async () => ({ title: "", content: "", url: "" }),
      releaseSession: async () => {},
      discoverLinks: async () => [],
      fetchJson: async () => ({ status: 200, contentType: "application/json", text: "{}" }),
      videoTranscript: async (url: string) => { seenUrl = url; return { videoId: "dQw4w9WgXcQ", text: "captions: the video explains X in detail " + "word ".repeat(20) }; },
    };
    const { reply, steps } = await runAgent("summarize this video https://youtu.be/dQw4w9WgXcQ", { llm, backend });
    expect(reply).toBe("The video explains X.");
    expect(steps).toBe(2);
    expect(seenUrl).toBe("https://youtu.be/dQw4w9WgXcQ");
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool");
    expect(toolMsg!.content).toMatch(/TRANSCRIPT of .*the video explains X/s);
  });

  it("transcript tool reports gracefully when captions are unavailable", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "transcript", args: { url: "https://youtu.be/dQw4w9WgXcQ" } } },
      { toolCall: { name: "reply", args: { text: "I couldn't read that video's transcript." } } },
    ]);
    const backend = {
      scrape: async (url: string) => ({ title: "", content: "", url }),
      createSession: async () => ({ id: "s" }),
      navigate: async (_i: string, url: string) => ({ url, title: "" }),
      click: async () => {}, type: async () => {},
      readCurrent: async () => ({ title: "", content: "", url: "" }),
      releaseSession: async () => {},
      discoverLinks: async () => [],
      fetchJson: async () => ({ status: 200, contentType: "application/json", text: "{}" }),
      videoTranscript: async () => null, // no captions
    };
    const { reply } = await runAgent("summarize https://youtu.be/dQw4w9WgXcQ", { llm, backend });
    expect(reply).toMatch(/couldn't read that video/i);
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool");
    expect(toolMsg!.content).toMatch(/No transcript available/i);
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

  // DEV-0042: after MAX_STEPS the loop makes ONE final forced-reply call (tools=[]) and returns its
  // text — or a fallback if that's empty. The forever test only checked non-empty; pin the content.
  it("MAX_STEPS exhausted -> returns the forced final-answer text", async () => {
    // Each in-loop call returns a scrape toolCall; the LAST call (post-budget, tools=[]) returns text.
    const llm: LLMClient = {
      async complete(_m, tools) {
        if (tools.length === 0) return { text: "best effort answer" }; // the forced final call
        return { toolCall: { name: "scrape", args: { url: "https://x.com" } } };
      },
    };
    const scrapeFn = async (url: string) => ({ title: "t", content: "c", url });
    const { reply, steps } = await runAgent("loop", { llm, scrapeFn });
    expect(reply).toBe("best effort answer");
    expect(steps).toBe(8); // RELAY_MAX_STEPS default
  });

  it("maxSteps raises the per-run step budget for a background errand (async-background-errands)", async () => {
    let inLoopCalls = 0;
    const llm: LLMClient = {
      async complete(_m, tools) {
        if (tools.length === 0) return { text: "done" };
        inLoopCalls++;
        return { toolCall: { name: "scrape", args: { url: "https://x.com" } } };
      },
    };
    const scrapeFn = async (url: string) => ({ title: "t", content: "c", url });
    const { steps } = await runAgent("big errand", { llm, scrapeFn, maxSteps: 20 });
    expect(steps).toBe(20);        // ran the raised budget, not the default 8
    expect(inLoopCalls).toBe(20);  // exactly the raised number of in-loop steps before the forced final
  });

  it("maxSteps is clamped to the ceiling so a runaway can't loop forever", async () => {
    const llm: LLMClient = {
      async complete(_m, tools) { return tools.length === 0 ? { text: "done" } : { toolCall: { name: "scrape", args: { url: "https://x.com" } } }; },
    };
    const scrapeFn = async (url: string) => ({ title: "t", content: "c", url });
    const { steps } = await runAgent("runaway", { llm, scrapeFn, maxSteps: 9999 });
    expect(steps).toBe(30); // MAX_STEPS_CEILING
  });

  it("MAX_STEPS exhausted with an empty forced answer -> the 'ran out of steps' fallback", async () => {
    const llm: LLMClient = {
      async complete(_m, tools) {
        if (tools.length === 0) return { text: "   " }; // forced call yields blank
        return { toolCall: { name: "scrape", args: { url: "https://x.com" } } };
      },
    };
    const scrapeFn = async (url: string) => ({ title: "t", content: "c", url });
    const { reply } = await runAgent("loop", { llm, scrapeFn });
    expect(reply).toMatch(/ran out of steps/i);
  });
});

describe("runAgent convert_currency (fx-conversion-tool)", () => {
  it("uses the convert_currency tool + reports the live rate, no browser", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "convert_currency", args: { amount: 200, from: "USD", to: "EUR" } } },
      { toolCall: { name: "reply", args: { text: "200 USD is about 184.60 EUR." } } },
    ]);
    let seen: { amount: number; from: string; to: string } | null = null;
    const backend = {
      scrape: async (url: string) => ({ title: "", content: "", url }),
      createSession: async () => ({ id: "s" }),
      navigate: async (_i: string, url: string) => ({ url, title: "" }),
      click: async () => {}, type: async () => {},
      readCurrent: async () => ({ title: "", content: "", url: "" }),
      releaseSession: async () => {},
      discoverLinks: async () => [],
      fetchJson: async () => ({ status: 200, contentType: "application/json", text: "{}" }),
      convertCurrency: async (amount: number, from: string, to: string) => { seen = { amount, from, to }; return { amount, from: "USD", to: "EUR", rate: 0.923, result: amount * 0.923 }; },
    };
    const { reply } = await runAgent("how much is 200 USD in EUR", { llm, backend });
    expect(seen).toEqual({ amount: 200, from: "USD", to: "EUR" });
    expect(reply).toMatch(/184\.60 EUR/);
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool");
    expect(toolMsg!.content).toMatch(/200 USD = 184\.60 EUR/);
  });
  it("reports gracefully when a currency code is unrecognized", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "convert_currency", args: { from: "xxx", to: "EUR" } } },
      { toolCall: { name: "reply", args: { text: "I couldn't recognize that currency." } } },
    ]);
    const backend = {
      scrape: async (url: string) => ({ title: "", content: "", url }),
      createSession: async () => ({ id: "s" }),
      navigate: async (_i: string, url: string) => ({ url, title: "" }),
      click: async () => {}, type: async () => {},
      readCurrent: async () => ({ title: "", content: "", url: "" }),
      releaseSession: async () => {},
      discoverLinks: async () => [],
      fetchJson: async () => ({ status: 200, contentType: "application/json", text: "{}" }),
      convertCurrency: async () => null,
    };
    const { reply } = await runAgent("convert 5 blorp to EUR", { llm, backend });
    expect(reply).toMatch(/couldn't recognize/i);
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool");
    expect(toolMsg!.content).toMatch(/Couldn't convert/i);
  });
});

describe("runAgent get_weather (geo-tool-cluster)", () => {
  const wx = { place: "Austin", current: { tempC: 30, tempF: 86, code: 0, desc: "clear", windKph: 5 }, today: { hiC: 35, loC: 25, hiF: 95, loF: 77, precipPct: 0 } };
  function wxBackend(over: Record<string, unknown> = {}) {
    return {
      scrape: async (url: string) => ({ title: "", content: "", url }),
      createSession: async () => ({ id: "s" }),
      navigate: async (_i: string, url: string) => ({ url, title: "" }),
      click: async () => {}, type: async () => {},
      readCurrent: async () => ({ title: "", content: "", url: "" }),
      releaseSession: async () => {},
      discoverLinks: async () => [],
      fetchJson: async () => ({ status: 200, contentType: "application/json", text: "{}" }),
      ...over,
    };
  }
  it("uses get_weather for a named place, no browser", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "get_weather", args: { place: "Austin" } } },
      { toolCall: { name: "reply", args: { text: "Austin: 86°F, clear." } } },
    ]);
    let seen: unknown = null;
    const backend = wxBackend({ getWeather: async (opts: unknown) => { seen = opts; return wx; } });
    const { reply } = await runAgent("what's the weather in Austin", { llm, backend });
    expect(seen).toEqual({ place: "Austin" });
    expect(reply).toMatch(/86°F/);
    expect(llm.calls[1]!.find((m) => m.role === "tool")!.content).toMatch(/Austin: 86°F, clear/);
  });
  it("with no place but saved coords, uses the coords (near-me weather)", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "get_weather", args: {} } },
      { toolCall: { name: "reply", args: { text: "It's 30C where you are." } } },
    ]);
    let seen: { lat?: number; lng?: number } | null = null;
    const backend = wxBackend({ getWeather: async (opts: { lat?: number; lng?: number }) => { seen = opts; return wx; } });
    await runAgent("weather", { llm, backend, weatherCoords: { lat: 30.27, lng: -97.74 }, weatherUnits: "metric" });
    expect(seen).toEqual({ lat: 30.27, lng: -97.74 });
    // metric units requested -> the tool result renders °C
    expect(llm.calls[1]!.find((m) => m.role === "tool")!.content).toMatch(/30°C/);
  });
  it("no place and no coords -> asks for a city, no crash", async () => {
    const llm = new MockLLM([
      { toolCall: { name: "get_weather", args: {} } },
      { toolCall: { name: "reply", args: { text: "Which city?" } } },
    ]);
    const backend = wxBackend({ getWeather: async () => wx });
    const { reply } = await runAgent("weather", { llm, backend });
    expect(reply).toMatch(/which city/i);
    expect(llm.calls[1]!.find((m) => m.role === "tool")!.content).toMatch(/no saved location/i);
  });
});
