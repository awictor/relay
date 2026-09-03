import { describe, it, expect } from "vitest";
import { runChain } from "../src/chain-runner.js";

// Mock agent: replies per-step from a scripted map keyed by the step text; records the context it saw.
function deps(replies: Record<string, string>, seen?: Array<{ task: string; context?: string }>) {
  return {
    llm: {} as never,
    runAgent: async (task: string, d: { context?: string }) => {
      seen?.push({ task, context: d.context });
      return { reply: replies[task] ?? `(no reply for ${task})` };
    },
    formatReply: (t: string) => t,
  };
}

describe("runChain (recipe-chaining)", () => {
  it("runs steps in order, feeding each output into the next as context", async () => {
    const seen: Array<{ task: string; context?: string }> = [];
    const r = await runChain(1, "find flight >> weather there >> summarize", deps({
      "find flight": "TAP $312 on the 14th",
      "weather there": "Lisbon: 22C sunny",
      "summarize": "Flight $312, weather sunny.",
    }, seen), );
    expect(r.final).toBe("Flight $312, weather sunny.");
    expect(r.steps.map((s) => s.output)).toEqual(["TAP $312 on the 14th", "Lisbon: 22C sunny", "Flight $312, weather sunny."]);
    // Step 2 got step 1's output as context; step 1 got none.
    expect(seen[0]!.context).toBeUndefined();
    expect(seen[1]!.context).toMatch(/Previous step result:\nTAP \$312/);
    expect(seen[2]!.context).toMatch(/Lisbon: 22C sunny/);
  });

  it("an if-gate stops the chain when the prior output lacks the keyword", async () => {
    const r = await runChain(1, "check price >> if under: draft order", deps({
      "check price": "The price is $500, above your target",
      "draft order": "Dear seller,",
    }));
    expect(r.stoppedEarly).toBe(true);
    expect(r.final).toMatch(/\$500/);          // stopped at step 1's output
    expect(r.steps[1]!.skipped).toBe(true);
    expect(r.steps[1]!.output).toBe("");        // draft never ran
  });

  it("an if-gate PROCEEDS when the keyword is present", async () => {
    const r = await runChain(1, "check price >> if under: draft order", deps({
      "check price": "Great news — it's under $400 now",
      "draft order": "Dear seller, I'd like to buy...",
    }));
    expect(r.stoppedEarly).toBeUndefined();
    expect(r.final).toMatch(/Dear seller/);
  });

  it("a degraded/empty step output stops the chain (no feeding nothing forward)", async () => {
    const r = await runChain(1, "step one >> step two", {
      llm: {} as never,
      runAgent: async (task: string) => task === "step one" ? { reply: "", degraded: true } : { reply: "should not run" },
      formatReply: (t: string) => t,
    });
    expect(r.stoppedEarly).toBe(true);
    expect(r.steps).toHaveLength(1); // step two never attempted
  });

  it("a single-step task (no >>) just runs once", async () => {
    const r = await runChain(1, "just do it", deps({ "just do it": "done" }));
    expect(r.final).toBe("done");
    expect(r.steps).toHaveLength(1);
  });
});
