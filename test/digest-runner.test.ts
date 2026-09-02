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

  it("a slotted member is skipped with a clear note, never run (digest-slot-guard)", async () => {
    let ran = false;
    const out = await runDigest(digest(["weather", "track"]), deps({
      resolveRecipe: (_c: number, name: string) =>
        name === "weather" ? { task: "get the weather" } : name === "track" ? { task: "price of {item}" } : null,
      runAgent: async (task: string) => { ran = true; return { reply: `RESULT[${task}]` }; },
    }));
    expect(out).toContain("• weather: RESULT[get the weather]");
    expect(out).toMatch(/• track: \(skipped — needs a value/);
    expect(out).not.toContain("{item}"); // the broken task never reached the agent/output
    // the non-slotted member still ran (ran flips true for weather), but track never did
    expect(ran).toBe(true);
  });

  it("a failed member run becomes a fallback line, others still run", async () => {
    let n = 0;
    const out = await runDigest(digest(["weather", "hn"]), deps({
      runAgent: async (task: string) => { n++; if (n === 1) throw new Error("boom"); return { reply: `RESULT[${task}]` }; },
    }));
    expect(out).toContain("• weather: (couldn't fetch)");
    expect(out).toContain("• hn: RESULT[top HN story]");
  });

  it("DEV-0139: sections stay in member order even when a later member resolves FIRST", async () => {
    // 'slow' resolves after 'fast' — with concurrent Promise.all the completion order is fast-then-
    // slow, but the output must still read slow-then-fast (member order), proving order != completion.
    const digest2: Digest = { chatId: 1, name: "morning", members: ["slow", "fast"], schedule: undefined, created: NOW };
    const out = await runDigest(digest2, deps({
      resolveRecipe: (_c, name) => ({ task: name }),
      runAgent: async (task: string) => {
        await new Promise((r) => setTimeout(r, task === "slow" ? 15 : 0));
        return { reply: `R[${task}]` };
      },
    }));
    const lines = out.split("\n").filter((l) => l.startsWith("•"));
    expect(lines[0]).toBe("• slow: R[slow]");
    expect(lines[1]).toBe("• fast: R[fast]");
  });

  it("DEV-0139: members run CONCURRENTLY, not sequentially", async () => {
    // Each member sleeps 20ms. Sequential would take >=60ms for 3; concurrent ~20ms. Assert well
    // under the sequential floor to prove the fan-out. (No real clock dependency beyond setTimeout.)
    let active = 0, maxActive = 0;
    const digest3: Digest = { chatId: 1, name: "m", members: ["a", "b", "c"], schedule: undefined, created: NOW };
    await runDigest(digest3, deps({
      resolveRecipe: (_c, name) => ({ task: name }),
      runAgent: async (task: string) => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { reply: task };
      },
    }));
    expect(maxActive).toBeGreaterThan(1); // more than one member in flight at once
  });

  it("DEV-0140: caps in-flight members at DIGEST_CONCURRENCY (default 3) while preserving order + fallbacks", async () => {
    // 6 members, default cap 3: an active-counter proves no more than 3 agents run at once (protects the
    // bounded anvil session pool), yet output stays in member order and unknown/failure fallbacks survive.
    let active = 0, maxActive = 0;
    const members = ["m0", "m1", "gone", "m3", "boom", "m5"];
    const dg: Digest = { chatId: 1, name: "big", members, schedule: undefined, created: NOW };
    const out = await runDigest(dg, deps({
      resolveRecipe: (_c, name) => (name === "gone" ? null : { task: name }),
      runAgent: async (task: string) => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        if (task === "boom") throw new Error("boom");
        return { reply: `R[${task}]` };
      },
    }));
    expect(maxActive).toBeLessThanOrEqual(3); // never more than the cap in flight
    expect(maxActive).toBeGreaterThan(1); // but genuinely concurrent, not sequential
    const lines = out.split("\n").filter((l) => l.startsWith("•"));
    expect(lines).toEqual([
      "• m0: R[m0]",
      "• m1: R[m1]",
      "• gone: (no such recipe anymore)",
      "• m3: R[m3]",
      "• boom: (couldn't fetch)",
      "• m5: R[m5]",
    ]);
  });

  it("DEV-0177: a degraded member reply becomes (couldn't fetch), not the failure text as content", async () => {
    // A soft-failure reply (agent ran out of steps / no answer, DEV-0176) RESOLVES with degraded:true
    // instead of throwing. It must be labeled like a fetch failure, never shown as this member's data.
    const out = await runDigest(digest(["weather", "hn"]), deps({
      runAgent: async (task: string) =>
        task === "get the weather"
          ? { reply: "I ran out of steps before finishing. Try narrowing the request.", degraded: true }
          : { reply: `RESULT[${task}]` },
    }));
    expect(out).toContain("• weather: (couldn't fetch)");   // degraded → fallback line
    expect(out).not.toContain("ran out of steps");           // failure text NOT leaked as briefing content
    expect(out).toContain("• hn: RESULT[top HN story]");     // healthy member unaffected
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
