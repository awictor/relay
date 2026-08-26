import { describe, it, expect } from "vitest";
import { runDigest } from "../src/digest-runner.js";
import type { Digest } from "../src/lib/digests.js";

const NOW = 1_700_000_000_000;
const digest = (members: string[]): Digest => ({ chatId: 1, name: "morning", members, schedule: undefined, created: NOW });

function deps(over: Partial<Parameters<typeof runDigest>[1]> = {}) {
  const recipes: Record<string, string> = { weather: "get the weather", hn: "top HN story", btc: "btc price" };
  return {
    llm: {} as never,
    resolveRecipe: (_c: number, name: string) => (recipes[name] ? { task: recipes[name] } : null),
    runAgent: async (task: string) => ({ reply: `RESULT[${task}]` }),
    formatReply: (t: string) => t,
    ...over,
  };
}

describe("runDigest", () => {
  it("runs each member recipe and composes one labeled message", async () => {
    const out = await runDigest(digest(["weather", "hn"]), deps());
    expect(out).toMatch(/^📋 morning/);
    expect(out).toContain("• weather: RESULT[get the weather]");
    expect(out).toContain("• hn: RESULT[top HN story]");
  });

  it("an unknown member (recipe deleted) is noted, not fatal", async () => {
    const out = await runDigest(digest(["weather", "gone"]), deps());
    expect(out).toContain("• weather: RESULT[get the weather]");
    expect(out).toContain("• gone: (no such recipe anymore)");
  });

  it("a failed member run becomes a fallback line, others still run", async () => {
    let n = 0;
    const out = await runDigest(digest(["weather", "hn"]), deps({
      runAgent: async (task: string) => { n++; if (n === 1) throw new Error("boom"); return { reply: `RESULT[${task}]` }; },
    }));
    expect(out).toContain("• weather: (couldn't fetch)");
    expect(out).toContain("• hn: RESULT[top HN story]");
  });

  it("caps the number of members run", async () => {
    let calls = 0;
    const out = await runDigest(digest(["a", "b", "c", "d"]), deps({
      resolveRecipe: (_c, name) => ({ task: name }),
      runAgent: async (task: string) => { calls++; return { reply: task }; },
      maxMembers: 2,
    }));
    expect(calls).toBe(2);
    expect(out.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(2);
  });
});
