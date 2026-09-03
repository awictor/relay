import { describe, it, expect } from "vitest";
import { parseTranslateRequest, buildTranslatePrompt, translate } from "../src/lib/translate.js";
import type { LLMClient } from "../src/llm.js";

// A fake LLM that echoes the target + text so we can assert what it was asked to translate.
const fakeLLM = (reply: string): LLMClient => ({ complete: async () => ({ text: reply }) } as unknown as LLMClient);

describe("parseTranslateRequest", () => {
  it("parses 'translate X to <lang>'", () => {
    expect(parseTranslateRequest("translate 'hola amigo' to English")).toEqual({ target: "English", text: "hola amigo" });
    expect(parseTranslateRequest("translate good morning into French")).toEqual({ target: "French", text: "good morning" });
  });
  it("parses 'how do you say X in <lang>'", () => {
    expect(parseTranslateRequest("how do you say good morning in Japanese")).toEqual({ target: "Japanese", text: "good morning" });
  });
  it("parses a page URL target", () => {
    expect(parseTranslateRequest("translate this page to English: https://ex.com/de")).toEqual({ target: "English", url: "https://ex.com/de" });
    expect(parseTranslateRequest("translate https://ex.com/x to French")).toEqual({ target: "French", url: "https://ex.com/x" });
  });
  it("defaults the target to English when no 'to <lang>' clause", () => {
    expect(parseTranslateRequest("translate 'guten morgen'")).toEqual({ target: "English", text: "guten morgen" });
  });
  it("returns null for a non-translate message", () => {
    expect(parseTranslateRequest("what's the weather")).toBeNull();
    expect(parseTranslateRequest("remind me to call mom")).toBeNull();
  });
});

describe("buildTranslatePrompt", () => {
  it("asks for only the translation + a pronunciation line for non-Latin scripts", () => {
    const { system, user } = buildTranslatePrompt("good morning", "Japanese");
    expect(system).toMatch(/only the translation/i);
    expect(system).toMatch(/pronunciation/i);
    expect(user).toMatch(/into Japanese/);
    expect(user).toMatch(/good morning/);
  });
});

describe("translate", () => {
  it("translates pasted text via the LLM", async () => {
    const out = await translate({ target: "Spanish", text: "where is the bathroom" }, fakeLLM("¿Dónde está el baño?"));
    expect(out).toBe("¿Dónde está el baño?");
  });
  it("scrapes a URL then translates its content", async () => {
    let scraped = "";
    const out = await translate(
      { target: "English", url: "https://ex.com/de" },
      fakeLLM("Hello world"),
      async (u) => { scraped = u; return { content: "Hallo Welt" }; },
    );
    expect(scraped).toBe("https://ex.com/de");
    expect(out).toBe("Hello world");
  });
  it("returns null when a URL is given but no scraper (or the scrape fails)", async () => {
    expect(await translate({ target: "English", url: "https://x" }, fakeLLM("x"))).toBeNull();
    expect(await translate({ target: "English", url: "https://x" }, fakeLLM("x"), async () => null)).toBeNull();
    expect(await translate({ target: "English", url: "https://x" }, fakeLLM("x"), async () => { throw new Error("net"); })).toBeNull();
  });
  it("returns null on empty input or an empty model reply", async () => {
    expect(await translate({ target: "English", text: "" }, fakeLLM("x"))).toBeNull();
    expect(await translate({ target: "English", text: "hi" }, fakeLLM("   "))).toBeNull();
  });
});
