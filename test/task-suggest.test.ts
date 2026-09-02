import { describe, it, expect } from "vitest";
import { repeatedTaskNudge, SAVE_NUDGE_MARKER } from "../src/lib/task-suggest.js";
import type { LLMMessage } from "../src/llm.js";

const turn = (role: "user" | "assistant", content: string): LLMMessage => ({ role, content } as LLMMessage);

describe("repeatedTaskNudge (auto-suggest-save)", () => {
  it("nudges when the current task closely matches an earlier user turn", () => {
    const history = [turn("user", "check the price of bitcoin"), turn("assistant", "It's $65,000.")];
    const n = repeatedTaskNudge("check the price of bitcoin", history);
    expect(n).toMatch(/save it/i);
    expect(n).toContain(SAVE_NUDGE_MARKER);
    expect(n).toMatch(/save <name>:/);
  });

  it("does NOT nudge on a first-time / unique task", () => {
    const history = [turn("user", "top HN story"), turn("assistant", "Story X.")];
    expect(repeatedTaskNudge("weather in Paris tomorrow", history)).toBeNull();
  });

  it("does NOT nudge a trivial one-token message", () => {
    const history = [turn("user", "hi"), turn("assistant", "hey")];
    expect(repeatedTaskNudge("hi", history)).toBeNull();
  });

  it("does NOT stack: suppressed if the last assistant turn already nudged", () => {
    const history = [
      turn("user", "check the price of bitcoin"),
      turn("assistant", `It's $65,000.${SAVE_NUDGE_MARKER} want me to save it?`),
    ];
    expect(repeatedTaskNudge("check the price of bitcoin", history)).toBeNull();
  });

  it("catches the same intent through light wording drift + stopwords", () => {
    const history = [turn("user", "what's the bitcoin price"), turn("assistant", "$65k")];
    // salient tokens both sides = {bitcoin, price}; overlap 1.0 -> nudge (stopwords 'whats'/'please' dropped)
    expect(repeatedTaskNudge("the bitcoin price please", history)).toMatch(/save it/i);
  });
});
