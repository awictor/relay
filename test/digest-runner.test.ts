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

  it("a reserved 'reading list' member folds in the saved recap, no agent run (saved-page-digest-integration)", async () => {
    let agentRan = false;
    const out = await runDigest(digest(["weather", "reading list"]), deps({
      runAgent: async (task: string) => { agentRan = task === "reading list" ? true : agentRan; return { reply: `RESULT[${task}]` }; },
      savedRecap: () => "2 saved to revisit:\n  - Fed rates — https://a.com\n  - Rust 2.0 — https://b.com",
    }));
    expect(out).toContain("• weather: RESULT[get the weather]");
    expect(out).toContain("• reading list:\n2 saved to revisit:");
    expect(out).toContain("Fed rates — https://a.com");
    expect(agentRan).toBe(false); // recap is a store read, never an agent/recipe run
  });

  it("a 'my logs' member folds in the weekly tracker recap, no agent run (logs-weekly-summary)", async () => {
    let agentRan = false;
    const out = await runDigest(digest(["weather", "my logs"]), deps({
      runAgent: async (task: string) => { agentRan = task === "my logs" ? true : agentRan; return { reply: `RESULT[${task}]` }; },
      logsRecap: () => "this week you logged:\n  - weight 182→180 ↓2\n  - spent $45 on food (3x)",
    }));
    expect(out).toContain("• weather: RESULT[get the weather]");
    expect(out).toContain("• my logs:\nthis week you logged:");
    expect(out).toContain("weight 182→180");
    expect(agentRan).toBe(false); // recap is a store read, never an agent/recipe run
  });

  it("a 'my logs' member with nothing logged reads as empty (not a failure), digest still sends others", async () => {
    const out = await runDigest(digest(["weather", "trackers"]), deps({ logsRecap: () => null }));
    expect(out).toContain("• weather: RESULT[get the weather]");
    expect(out).toContain("• trackers: (nothing logged this week)");
  });

  it("a 'reading list' member with nothing saved reads as empty (not a failure), digest still sends its other members", async () => {
    const out = await runDigest(digest(["weather", "saved"]), deps({ savedRecap: () => null }));
    expect(out).toContain("• weather: RESULT[get the weather]");
    expect(out).toContain("• saved: (nothing saved yet)");
    expect(out).toMatch(/^📋 morning/); // weather is real content, so the briefing sends
  });

  it("a digest of ONLY an empty reading list stays silent (null), like an all-deleted digest", async () => {
    const out = await runDigest(digest(["reading list"]), deps({ savedRecap: () => null }));
    expect(out).toBeNull();
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

  it("smart ordering floats a CHANGED member to the top with a ✦ marker (digest-smart-ordering)", async () => {
    // memberChanged reports only "btc" as changed -> it should lead, marked ✦, others follow in order.
    const out = await runDigest(digest(["weather", "hn", "btc"]), deps({
      memberChanged: (_c, _d, member) => member === "btc",
    })) as string;
    expect(out).toMatch(/✦ = changed since last time/);
    const lines = out.split("\n");
    // first content line (after the title) is the changed btc member, marked
    expect(lines[1]).toMatch(/^✦ btc:/);
    expect(out).toMatch(/• weather:/); // unchanged members still present, un-marked
    expect(out).toMatch(/• hn:/);
  });

  it("quiet-unchanged: seen-before + nothing changed -> quietNoChange (digest-skip-unchanged)", async () => {
    const d: Digest = { chatId: 1, name: "morning", members: ["weather", "btc"], schedule: undefined, quietUnchanged: true, created: NOW };
    const out = await runDigest(d, deps({
      memberChanged: () => false,       // nothing moved
      digestSeenBefore: () => true,     // ran before -> not a first fire
    }));
    expect(out && typeof out === "object" && "quietNoChange" in out).toBe(true);
    expect((out as { text: string }).text).toMatch(/• weather:/); // composed text still available for /run
  });

  it("quiet-unchanged: FIRST run (not seen before) still SENDS (seeds baseline)", async () => {
    const d: Digest = { chatId: 1, name: "morning", members: ["weather", "btc"], schedule: undefined, quietUnchanged: true, created: NOW };
    const out = await runDigest(d, deps({ memberChanged: () => false, digestSeenBefore: () => false }));
    expect(typeof out).toBe("string"); // sends the briefing on the first fire
  });

  it("quiet-unchanged: a CHANGED member sends normally (not quiet)", async () => {
    const d: Digest = { chatId: 1, name: "morning", members: ["weather", "btc"], schedule: undefined, quietUnchanged: true, created: NOW };
    const out = await runDigest(d, deps({ memberChanged: (_c, _dn, m) => m === "btc", digestSeenBefore: () => true }));
    expect(typeof out).toBe("string");
    expect(out as string).toMatch(/✦ btc:/);
  });

  it("changed members get a 'what's new' header naming them (digest-change-summary)", async () => {
    const out = await runDigest(digest(["weather", "hn", "btc"]), deps({
      memberChanged: (_c, _d, m) => m === "btc" || m === "hn",
    })) as string;
    expect(out).toMatch(/new: hn, btc/); // header names the changed members, in float order
    expect(out.split("\n")[0]).toMatch(/✦ = changed since last time/);
  });

  it("no reorder when nothing changed (identical to definition-order briefing)", async () => {
    const out = await runDigest(digest(["weather", "hn"]), deps({
      memberChanged: () => false,
    })) as string;
    expect(out).not.toMatch(/✦/);
    const lines = out.split("\n");
    expect(lines[1]).toMatch(/^• weather:/); // definition order preserved
  });

  it("a chain member that STOPPED EARLY is flagged partial, not shown as a complete section (chain-partial-nonrun-paths)", async () => {
    const out = await runDigest(digest(["weather", "flow"]), deps({
      resolveRecipe: (_c: number, name: string) => name === "weather" ? { task: "get the weather" } : name === "flow" ? { task: "a >> b >> c" } : null,
      // structured result: the chain only completed 1 of 3 steps
      runChain: async () => ({ final: "half an answer", stoppedEarly: true, stepsDone: 1, stepsTotal: 3 }),
    }));
    expect(out).toContain("• flow: (partial — 1 of 3 steps) half an answer"); // flagged, not silent
    expect(out).toContain("• weather: RESULT[get the weather]");              // real member carries it
  });

  it("a digest of ONLY a stopped-early chain triggers the honest all-failed notice, not a half-answer", async () => {
    const out = await runDigest(digest(["flow"]), deps({
      resolveRecipe: (_c: number, name: string) => name === "flow" ? { task: "a >> b" } : null,
      runChain: async () => ({ final: "partial", stoppedEarly: true, stepsDone: 1, stepsTotal: 2 }),
    }));
    // partial counts as "failed" (not "real"), so an all-partial digest hits the all-failed path
    expect(out).toMatchObject({ allFailed: true });
  });

  it("a COMPLETED chain (stoppedEarly false) shows normally via the structured result", async () => {
    const out = await runDigest(digest(["flow"]), deps({
      resolveRecipe: (_c: number, name: string) => name === "flow" ? { task: "a >> b" } : null,
      runChain: async () => ({ final: "full answer", stoppedEarly: false, stepsDone: 2, stepsTotal: 2 }),
    }));
    expect(out).toContain("• flow: full answer");
    expect(out).not.toContain("partial");
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
