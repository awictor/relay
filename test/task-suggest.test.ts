import { describe, it, expect } from "vitest";
import { repeatedTaskNudge, matchRecipe, recurringCta, SAVE_NUDGE_MARKER } from "../src/lib/task-suggest.js";
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

describe("matchRecipe (recipe-auto-recall)", () => {
  const recipes = [{ name: "btc", task: "check the price of bitcoin" }, { name: "hn", task: "top hacker news story" }];
  it("matches a free-text message to a strongly-overlapping saved recipe", () => {
    expect(matchRecipe("check bitcoin price", recipes)).toEqual({ name: "btc" });   // {check,bitcoin,price} vs {check,price,bitcoin} = 1.0
    expect(matchRecipe("top hacker news story", recipes)).toEqual({ name: "hn" });  // exact salient tokens = 1.0
  });
  it("returns null when nothing overlaps enough (conservative)", () => {
    expect(matchRecipe("weather in Paris tomorrow", recipes)).toBeNull();
    expect(matchRecipe("bitcoin", recipes)).toBeNull(); // 1 token -> too weak
  });
  it("returns null for an empty recipe set", () => {
    expect(matchRecipe("check bitcoin price", [])).toBeNull();
  });
});

describe("recurringCta (content-aware-cta)", () => {
  it("offers a WATCH for a price/number answer", () => {
    expect(recurringCta("price of bitcoin", "Bitcoin is $67,000 right now.", ["web_search", "scrape"])).toMatch(/watch it:/i);
  });
  it("offers a digest/save for a fetched page with no price", () => {
    const c = recurringCta("top hacker news story", "The top story is X.", ["scrape"]);
    expect(c).toMatch(/every morning|save that as/i);
    expect(c).not.toMatch(/watch it:/i);
  });
  it("falls back to the plain daily tip for a no-tool answer", () => {
    expect(recurringCta("motivate me", "You got this!", [])).toMatch(/keep this coming/i);
  });
  it("always starts with the tip marker", () => {
    expect(recurringCta("x y z", "z", []).trim().startsWith("💡")).toBe(true);
  });
});
