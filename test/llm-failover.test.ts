import { describe, it, expect, vi, afterEach } from "vitest";
import { GeminiClient } from "../src/llm.js";

// Stub global fetch to simulate per-model responses by URL.
function stubFetch(handler: (url: string, callIdx: number) => { status: number; body: unknown }) {
  let i = 0;
  return vi.fn(async (url: string) => {
    const { status, body } = handler(url, i++);
    return new Response(JSON.stringify(body), { status });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("GeminiClient model failover", () => {
  it("falls over to the next model on 429 quota", async () => {
    const modelsHit: string[] = [];
    vi.stubGlobal("fetch", stubFetch((url) => {
      const model = url.match(/models\/([^:]+):/)?.[1] ?? "?";
      modelsHit.push(model);
      // First model (lite) 429s; second returns a real answer.
      if (modelsHit.length === 1) return { status: 429, body: { error: { message: "quota" } } };
      return { status: 200, body: { candidates: [{ content: { parts: [{ text: "hello from failover" }] } }] } };
    }));
    const c = new GeminiClient("test-key");
    const res = await c.complete([{ role: "user", content: "hi" }], []);
    expect(res.text).toBe("hello from failover");
    expect(modelsHit.length).toBe(2); // advanced past the 429'd model
    expect(modelsHit[0]).not.toBe(modelsHit[1]);
  });

  it("throws a clear error only after ALL models fail", async () => {
    vi.stubGlobal("fetch", stubFetch(() => ({ status: 429, body: { error: { message: "quota" } } })));
    const c = new GeminiClient("test-key");
    await expect(c.complete([{ role: "user", content: "hi" }], [])).rejects.toThrow(/all models failed/i);
  });

  it("DEV-0149: a 502 retries the SAME model (not immediate failover)", async () => {
    const modelsHit: string[] = [];
    vi.stubGlobal("fetch", stubFetch((url) => {
      const model = url.match(/models\/([^:]+):/)?.[1] ?? "?";
      modelsHit.push(model);
      // First attempt on the primary model 502s; the retry (same model) succeeds.
      if (modelsHit.length === 1) return { status: 502, body: { error: { message: "bad gateway" } } };
      return { status: 200, body: { candidates: [{ content: { parts: [{ text: "recovered" }] } }] } };
    }));
    const c = new GeminiClient("test-key");
    const res = await c.complete([{ role: "user", content: "hi" }], []);
    expect(res.text).toBe("recovered");
    expect(modelsHit.length).toBe(2);
    expect(modelsHit[0]).toBe(modelsHit[1]); // SAME model retried, not failed over
  });

  it("does not fail over on a clean 200 (uses primary)", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", stubFetch(() => { calls++; return { status: 200, body: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }; }));
    const c = new GeminiClient("test-key");
    const res = await c.complete([{ role: "user", content: "hi" }], []);
    expect(res.text).toBe("ok");
    expect(calls).toBe(1); // primary only, no extra model calls
  });
});

// DEV-0040 (HARDEN): the RESPONSE-PARSE side of complete() — a functionCall part -> {toolCall}
// (incl thoughtSignature lifted from the fcPart OR a sibling), multi-text join, and functionCall
// taking precedence over text. A Gemini response-shape change must not silently drop tool calls.
describe("GeminiClient response parse (DEV-0040)", () => {
  const parts = (p: unknown[]) => ({ status: 200, body: { candidates: [{ content: { parts: p } }] } });

  it("a functionCall part becomes toolCall {name,args}", async () => {
    vi.stubGlobal("fetch", stubFetch(() => parts([{ functionCall: { name: "scrape", args: { url: "u" } } }])));
    const res = await new GeminiClient("k").complete([{ role: "user", content: "x" }], []);
    expect(res.toolCall).toEqual({ name: "scrape", args: { url: "u" } });
  });

  it("thoughtSignature on the functionCall part is carried onto the toolCall", async () => {
    vi.stubGlobal("fetch", stubFetch(() => parts([{ functionCall: { name: "read", args: {} }, thoughtSignature: "SIG" }])));
    const res = await new GeminiClient("k").complete([{ role: "user", content: "x" }], []);
    expect(res.toolCall?.thoughtSignature).toBe("SIG");
  });

  it("thoughtSignature on a SIBLING part is still lifted onto the toolCall", async () => {
    vi.stubGlobal("fetch", stubFetch(() => parts([{ thoughtSignature: "SIB" }, { functionCall: { name: "read", args: {} } }])));
    const res = await new GeminiClient("k").complete([{ role: "user", content: "x" }], []);
    expect(res.toolCall?.thoughtSignature).toBe("SIB");
  });

  it("functionCall takes precedence over text (returns toolCall, not a bare text)", async () => {
    vi.stubGlobal("fetch", stubFetch(() => parts([{ text: "let me look" }, { functionCall: { name: "scrape", args: { url: "u" } } }])));
    const res = await new GeminiClient("k").complete([{ role: "user", content: "x" }], []);
    expect(res.toolCall?.name).toBe("scrape");
    expect(res.text).toBe("let me look"); // text still surfaced alongside
  });

  it("multiple text parts are joined; args default to {} when absent", async () => {
    vi.stubGlobal("fetch", stubFetch(() => parts([{ text: "a" }, { text: "b" }])));
    const res = await new GeminiClient("k").complete([{ role: "user", content: "x" }], []);
    expect(res.text).toBe("ab");
    expect(res.toolCall).toBeUndefined();
  });

  it("a functionCall with no args yields args:{}", async () => {
    vi.stubGlobal("fetch", stubFetch(() => parts([{ functionCall: { name: "read" } }])));
    const res = await new GeminiClient("k").complete([{ role: "user", content: "x" }], []);
    expect(res.toolCall).toEqual({ name: "read", args: {} });
  });

  it("describeImage sends an inlineData part and returns the text answer (product-loop)", async () => {
    let sentBody: any = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "A receipt, total $42.50" }] } }] }), { status: 200 });
    }));
    const ans = await new GeminiClient("k").describeImage(new Uint8Array([1, 2, 3]), "image/png", "what's the total?");
    expect(ans).toBe("A receipt, total $42.50");
    const parts0 = sentBody.contents[0].parts;
    expect(parts0[0].text).toBe("what's the total?");
    expect(parts0[1].inlineData.mimeType).toBe("image/png");
    expect(typeof parts0[1].inlineData.data).toBe("string"); // base64
  });

  it("describeImage fails over on 429 then throws if all models 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 })));
    await expect(new GeminiClient("k").describeImage(new Uint8Array([1]), "image/jpeg", "x")).rejects.toThrow(/vision failed/i);
  });

  it("transcribeAudio sends an audio inlineData part and returns the transcript (product-loop)", async () => {
    let sentBody: any = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "what's the weather in Paris" }] } }] }), { status: 200 });
    }));
    const t = await new GeminiClient("k").transcribeAudio(new Uint8Array([1, 2]), "audio/ogg");
    expect(t).toBe("what's the weather in Paris");
    const parts0 = sentBody.contents[0].parts;
    expect(parts0[1].inlineData.mimeType).toBe("audio/ogg");
  });
});
