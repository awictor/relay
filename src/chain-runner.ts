// Recipe chaining runner (recipe-chaining): a recipe task with ">>" steps is a small sequential
// workflow — each step runs in order, the PRIOR step's output fed into the next as context, so
// "find the cheapest flight to {city} >> then weather + top news there >> summarize" is one command.
// An "if <keyword>: <step>" gate stops the chain when the prior output lacks <keyword>. Injectable
// runAgent so it's unit-tested offline; reuses the same read-only agent (no new powers, safety intact).

import type { LLMClient, LLMMessage } from "./llm.js";
import { parseChainSteps, type ChainStep } from "./lib/recipes.js";

export interface ChainRunnerDeps {
  llm: LLMClient;
  runAgent: (userText: string, deps: { llm: LLMClient; context?: string }, history: LLMMessage[]) => Promise<{ reply: string; degraded?: boolean }>;
  formatReply: (text: string) => string;
  contextFor?: (chatId: number) => string; // per-user profile context (location/units/facts)
}

// True if `hay` contains `needle` NOT immediately preceded by a negation ("not"/"no"/"out of"/"n't").
// So an "if in stock" gate doesn't pass on "out of stock". Exported for tests.
export function containsUnnegated(hay: string, needle: string): boolean {
  const h = hay.toLowerCase(), n = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const i = h.indexOf(n, from);
    if (i < 0) return false;
    const before = h.slice(Math.max(0, i - 12), i);
    if (!/(?:\bnot\b|\bno\b|\bout of\b|n['’]t)\s*$/.test(before)) return true; // an un-negated occurrence
    from = i + n.length;
  }
}

export interface ChainResult {
  final: string;                 // the last step's output — the answer to relay to the user
  steps: Array<{ task: string; output: string; skipped?: boolean }>;
  stoppedEarly?: boolean;        // an if-gate wasn't satisfied
}

/**
 * Run a chained recipe task. Steps split on ">>"; each step's task is run through the agent with the
 * PRIOR step's output supplied as context ("Previous step result: ..."). An "if <kw>:" step runs only
 * when the prior output contains <kw> (case-insensitive), else the chain stops there. A degraded/empty
 * step output stops the chain too (no point feeding nothing downstream). Returns the final output +
 * a per-step trace. A single-step (no ">>") task just runs once. Never throws — a thrown step ends the
 * chain with what's gathered so far.
 */
export async function runChain(chatId: number, task: string, deps: ChainRunnerDeps): Promise<ChainResult> {
  const steps = parseChainSteps(task);
  const ctx = deps.contextFor?.(chatId) || undefined;
  const trace: ChainResult["steps"] = [];
  let prev = "";
  for (let i = 0; i < steps.length; i++) {
    const step: ChainStep = steps[i]!;
    // Conditional gate: skip-and-stop when the prior output doesn't contain the keyword. Guard against
    // a negated match ("in stock" inside "out of stock", "available" inside "not available") so the gate
    // doesn't fire on the OPPOSITE condition (recipe-chaining if-gate).
    if (step.ifContains && !containsUnnegated(prev, step.ifContains)) {
      trace.push({ task: step.text, output: "", skipped: true });
      return { final: prev, steps: trace, stoppedEarly: true };
    }
    // Feed the prior step's result forward as context (first step has none).
    const stepContext = [ctx, prev ? `Previous step result:\n${prev}` : ""].filter(Boolean).join("\n\n") || undefined;
    let output: string;
    try {
      const res = await deps.runAgent(step.text, { llm: deps.llm, context: stepContext }, []);
      output = res.degraded ? "" : deps.formatReply(res.reply).trim();
    } catch { output = ""; }
    trace.push({ task: step.text, output });
    if (!output) return { final: prev || "(the chain couldn't complete a step)", steps: trace, stoppedEarly: true };
    prev = output;
  }
  return { final: prev, steps: trace };
}
