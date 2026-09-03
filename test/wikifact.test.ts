import { describe, it, expect } from "vitest";
import { searchUrl, summaryUrl, parseSearchTitle, parseSummary, formatFact, getFact } from "../src/lib/wikifact.js";

const search = (title: string | null) => JSON.stringify({ query: { search: title ? [{ title }] : [] } });
const summary = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: "standard",
  title: "Mount Everest",
  description: "Earth's highest mountain",
  extract: "Mount Everest is Earth's highest mountain above sea level, located in the Himalayas.",
  content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Mount_Everest" } },
  ...over,
});

describe("url builders", () => {
  it("search uses full-text list=search; summary underscores the title", () => {
    expect(searchUrl("ceo of openai")).toContain("list=search&srsearch=ceo%20of%20openai");
    expect(summaryUrl("Mount Everest")).toContain("/page/summary/Mount_Everest");
  });
});

describe("parseSearchTitle", () => {
  it("returns the top result title, null on no match/bad json", () => {
    expect(parseSearchTitle(search("OpenAI"))).toBe("OpenAI");
    expect(parseSearchTitle(search(null))).toBeNull();
    expect(parseSearchTitle("nope")).toBeNull();
  });
});

describe("parseSummary", () => {
  it("parses a standard page", () => {
    const f = parseSummary(summary())!;
    expect(f).toMatchObject({ title: "Mount Everest", description: "Earth's highest mountain" });
    expect(f.extract).toMatch(/highest mountain/);
    expect(f.url).toMatch(/wiki\/Mount_Everest/);
  });
  it("returns null for a disambiguation page (don't pick a meaning)", () => {
    expect(parseSummary(summary({ type: "disambiguation", extract: "Topics referred to by the same term" }))).toBeNull();
  });
  it("returns null for an empty extract / bad json", () => {
    expect(parseSummary(summary({ extract: "" }))).toBeNull();
    expect(parseSummary("not json")).toBeNull();
  });
  it("clips a very long extract at a sentence boundary", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence ${i} about the topic.`).join(" ");
    const f = parseSummary(summary({ extract: long }))!;
    expect(f.extract.length).toBeLessThanOrEqual(601);
    expect(/\.\s*$|…$/.test(f.extract)).toBe(true); // ends on a stop or ellipsis
  });
});

describe("formatFact", () => {
  it("renders title — description, extract, citation", () => {
    const out = formatFact(parseSummary(summary())!);
    expect(out).toMatch(/Mount Everest — Earth's highest mountain/);
    expect(out).toMatch(/\(https:\/\/en\.wikipedia\.org\/wiki\/Mount_Everest\)/);
  });
});

describe("getFact (injected fetch)", () => {
  it("resolves query -> title -> summary", async () => {
    const seen: string[] = [];
    const r = await getFact("how tall is everest", async (u) => {
      seen.push(u);
      return u.includes("list=search") ? search("Mount Everest") : summary();
    });
    expect(seen[0]).toContain("list=search");
    expect(seen[1]).toContain("/summary/Mount_Everest");
    expect(r.fact!.title).toBe("Mount Everest");
  });
  it("no search match -> fact null (caller falls back)", async () => {
    const r = await getFact("asdfqwer", async () => search(null));
    expect(r.fact).toBeNull();
    expect(r.disambiguation).toBeUndefined();
  });
  it("a disambiguation summary -> fact null + disambiguation flag", async () => {
    const r = await getFact("mercury", async (u) =>
      u.includes("list=search") ? search("Mercury") : summary({ type: "disambiguation", extract: "many things" }));
    expect(r.fact).toBeNull();
    expect(r.disambiguation).toBe(true);
  });
  it("a fetch throw -> fact null (never throws)", async () => {
    const r = await getFact("x", async () => { throw new Error("net"); });
    expect(r.fact).toBeNull();
  });
});
