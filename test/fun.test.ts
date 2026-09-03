import { describe, it, expect } from "vitest";
import { parseFunKind, funUrl, formatFun, getFun } from "../src/lib/fun.js";

describe("parseFunKind", () => {
  it("picks joke / fact / trivia from the request (default joke)", () => {
    expect(parseFunKind("tell me a joke")).toBe("joke");
    expect(parseFunKind("make me laugh")).toBe("joke"); // default
    expect(parseFunKind("give me a fun fact")).toBe("fact");
    expect(parseFunKind("did you know")).toBe("fact");
    expect(parseFunKind("trivia question")).toBe("trivia");
    expect(parseFunKind("quiz me")).toBe("trivia");
  });
});

describe("funUrl", () => {
  it("maps each kind to its keyless source", () => {
    expect(funUrl("joke")).toContain("official-joke-api");
    expect(funUrl("fact")).toContain("catfact.ninja");
    expect(funUrl("trivia")).toContain("opentdb.com");
  });
});

describe("formatFun", () => {
  it("formats a joke as setup + punchline", () => {
    const out = formatFun("joke", JSON.stringify({ setup: "Why?", punchline: "Because." }));
    expect(out).toBe("Why?\n\nBecause.");
  });
  it("formats a fact", () => {
    expect(formatFun("fact", JSON.stringify({ fact: "Cats sleep a lot." }))).toBe("Fun fact: Cats sleep a lot.");
  });
  it("formats a trivia question with the answer + decodes entities", () => {
    const body = JSON.stringify({ results: [{ question: "What&#039;s 2+2?", correct_answer: "Four", category: "Math &amp; Logic" }] });
    const out = formatFun("trivia", body)!;
    expect(out).toMatch(/Trivia \(Math & Logic\): What's 2\+2\?/);
    expect(out).toMatch(/Answer: Four/);
  });
  it("null on a bad/empty body", () => {
    expect(formatFun("joke", "{}")).toBeNull();
    expect(formatFun("trivia", JSON.stringify({ results: [] }))).toBeNull();
    expect(formatFun("fact", "nonsense")).toBeNull();
  });
});

describe("getFun (injected fetch)", () => {
  it("routes to the right source + returns the formatted text", async () => {
    let url = "";
    const r = await getFun("fun fact", async (u) => { url = u; return JSON.stringify({ fact: "Octopuses have three hearts." }); });
    expect(url).toContain("catfact.ninja");
    expect(r).toEqual({ kind: "fact", text: "Fun fact: Octopuses have three hearts." });
  });
  it("null on a fetch failure (caller falls back)", async () => {
    expect(await getFun("joke", async () => { throw new Error("net"); })).toBeNull();
  });
});
