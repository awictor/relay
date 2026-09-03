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

  it("a chained-recipe member runs via runChain, not as one literal task (digest-chain-member-literal)", async () => {
    let chainTask = "", agentTasks: string[] = [];
    const out = await runDigest(digest(["weather", "flow"]), deps({
      resolveRecipe: (_c: number, name: string) =>
        name === "weather" ? { task: "get the weather" } : name === "flow" ? { task: "step a >> step b" } : null,
      runAgent: async (task: string) => { agentTasks.push(task); return { reply: `RESULT[${task}]` }; },
      runChain: async (_c: number, task: string) => { chainTask = task; return "chained final"; },
    }));
    expect(chainTask).toBe("step a >> step b");       // ran the chain
    expect(agentTasks).not.toContain("step a >> step b"); // NOT a literal single-task agent run
    expect(out).toContain("• flow: chained final");
    expect(out).toContain("• weather: RESULT[get the weather]"); // non-chain member unaffected
  });

  it("a chain member with no runChain wired falls back to runAgent (prior behavior)", async () => {
    let ran = "";
    const out = await runDigest(digest(["flow"]), deps({
      resolveRecipe: (_c: number, name: string) => name === "flow" ? { task: "a >> b" } : null,
      runAgent: async (task: string) => { ran = task; return { reply: "fallback" }; },
    }));
    expect(ran).toBe("a >> b");
    expect(out).toContain("• flow: fallback");
  });

  it("a chain member whose chain returns empty becomes a fallback line (alongside a real member)", async () => {
    const out = await runDigest(digest(["weather", "flow"]), deps({
      resolveRecipe: (_c: number, name: string) => name === "weather" ? { task: "get the weather" } : name === "flow" ? { task: "a >> b" } : null,
      runChain: async () => "   ",
    }));
    expect(out).toContain("• flow: (couldn't fetch)");     // failed member still shown as a fallback line
    expect(out).toContain("• weather: RESULT[get the weather]"); // real member carries the digest
  });

  it("a digest whose recipes were ALL deleted returns null (empty-digest-fires-noise)", async () => {
    const out = await runDigest(digest(["gone", "alsogone"]), deps({ resolveRecipe: () => null }));
    expect(out).toBeNull(); // no real content -> scheduled fire stays silent, /run says "empty or gone"
  });

  it("a digest with no members returns null", async () => {
    const out = await runDigest(digest([]), deps());
    expect(out).toBeNull();
  });

  it("all members transiently FAIL -> sends a 'couldn't build it this time' note, not silence (digest-all-fail-silent-noshow)", async () => {
    // Recipes exist (not deleted) but every run throws — a network blip. Must NOT silently no-show.
    const out = await runDigest(digest(["weather", "hn"]), deps({ runAgent: async () => { throw new Error("net"); } }));
    // All-failed is now a distinct outcome (digest-all-failed-bypasses-gate): the scheduler streaks it,
    // but the note the user sees on /run is unchanged.
    expect(out && typeof out === "object" && "allFailed" in out).toBe(true);
    const note = (out as { note: string }).note;
    expect(note).toMatch(/couldn't put your briefing together|couldn't build/i);
    expect(note).toMatch(/temporary|try again/i);
  });

  it("an error-SHAPED member reply is demoted to '(couldn't fetch)', not shown as content (digest-error-as-content)", async () => {
    const out = await runDigest(digest(["weather", "btc"]), deps({
      runAgent: async (task: string) => task === "btc price"
        ? ({ reply: "the page returned a 404 error" }) // soft failure, NOT degraded
        : ({ reply: "sunny, 72F" }),
    }));
    expect(out).toContain("• btc: (couldn't fetch)");   // demoted, not the error text
    expect(out).not.toMatch(/404/);                      // the error string never reaches the briefing
    expect(out).toContain("• weather: sunny, 72F");      // the real member still carries it
  });

  it("ALL members error-shaped (not degraded) -> the all-failed note, not a briefing of errors", async () => {
    const out = await runDigest(digest(["weather", "hn"]), deps({
      runAgent: async () => ({ reply: "couldn't load that right now" }), // error-shaped, not degraded
    }));
    expect(out && typeof out === "object" && "allFailed" in out).toBe(true);
    const note = (out as { note: string }).note;
    expect(note).toMatch(/couldn't put your briefing together|couldn't build/i);
    expect(note).not.toMatch(/couldn't load that right now/); // the raw error isn't shown as content
  });

  it("all members DEGRADED (real recipes, no content) also sends the transient note, not silence", async () => {
    const out = await runDigest(digest(["weather", "hn"]), deps({ runAgent: async () => ({ reply: "", degraded: true }) }));
    expect(out && typeof out === "object" && "allFailed" in out).toBe(true);
    expect((out as { note: string }).note).toMatch(/couldn't/i);
  });

  it("mixed gone + failed (no real) still sends the transient note (a failed member means it's not just dead)", async () => {
    // "weather" exists but fails; "gone" is deleted. At least one FAILED -> treat as transient, notify.
    const out = await runDigest(digest(["weather", "gone"]), deps({ runAgent: async () => { throw new Error("net"); } }));
    expect(out && typeof out === "object" && "allFailed" in out).toBe(true);
    expect((out as { note: string }).note).toMatch(/couldn't/i);
  });

  it("a digest with at least one real member still sends (a transient fail doesn't blank it)", async () => {
    const out = await runDigest(digest(["weather", "gone"]), deps());
    expect(out).not.toBeNull();
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
