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

  it("does not fail over on a clean 200 (uses primary)", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", stubFetch(() => { calls++; return { status: 200, body: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }; }));
    const c = new GeminiClient("test-key");
    const res = await c.complete([{ role: "user", content: "hi" }], []);
    expect(res.text).toBe("ok");
    expect(calls).toBe(1); // primary only, no extra model calls
  });
});
