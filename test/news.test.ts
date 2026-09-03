import { describe, it, expect } from "vitest";
import { newsUrl, parseHeadlines, formatNews, getNews } from "../src/lib/news.js";

const rss = (titles: string[]) =>
  `<rss><channel><title>Top stories - Google News</title>${titles.map((t) => `<item><title>${t}</title><link>https://n/${encodeURIComponent(t)}</link></item>`).join("")}</channel></rss>`;

describe("newsUrl", () => {
  it("returns the general top-stories feed with no topic", () => {
    expect(newsUrl()).toBe("https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en");
  });
  it("returns a topic search feed when a topic is given", () => {
    expect(newsUrl("AI chips")).toContain("/rss/search?q=AI%20chips");
  });
});

describe("parseHeadlines", () => {
  it("pulls item titles, strips a trailing ' - Publisher', dedupes, caps", () => {
    const body = rss(["Big thing happens - BBC", "Big thing happens - CNN", "Another story - Reuters"]);
    const h = parseHeadlines(body);
    // "Big thing happens - BBC" and "- CNN" both clean to "Big thing happens" -> deduped to one.
    expect(h).toEqual(["Big thing happens", "Another story"]);
  });
  it("keeps a hyphenated title intact (only strips a short source tail)", () => {
    const body = rss(["Cost-benefit analysis of X - NPR"]);
    expect(parseHeadlines(body)).toEqual(["Cost-benefit analysis of X"]);
  });
  it("caps to the limit", () => {
    const body = rss(Array.from({ length: 12 }, (_, i) => `Story ${i}`));
    expect(parseHeadlines(body)).toHaveLength(8);
  });
  it("returns [] on malformed input", () => {
    expect(parseHeadlines("<html>no items</html>")).toEqual([]);
    expect(parseHeadlines("not xml")).toEqual([]);
  });
});

describe("formatNews", () => {
  it("labels a general vs topic feed, bullets the headlines", () => {
    expect(formatNews(["A", "B"])).toMatch(/Top headlines:\n• A\n• B/);
    expect(formatNews(["A"], "AI")).toMatch(/Top news about "AI":/);
  });
  it("notes when there's nothing", () => {
    expect(formatNews([])).toMatch(/couldn't pull the headlines/);
    expect(formatNews([], "AI")).toMatch(/couldn't find news about "AI"/);
  });
});

describe("getNews", () => {
  it("fetches the general feed + returns headlines when no topic", async () => {
    let seen = "";
    const r = await getNews(undefined, async (u) => { seen = u; return rss(["X happened - AP", "Y happened - BBC"]); });
    expect(seen).toBe(newsUrl());
    expect(r!.headlines).toEqual(["X happened", "Y happened"]);
    expect(r!.topic).toBeUndefined();
  });
  it("fetches the topic feed + echoes the topic", async () => {
    const r = await getNews("mars", async () => rss(["Rover finds water - NASA"]));
    expect(r!.topic).toBe("mars");
    expect(r!.headlines).toEqual(["Rover finds water"]);
  });
  it("returns null on empty parse or a fetch throw (caller falls back to web_search)", async () => {
    expect(await getNews(undefined, async () => "<html>nope</html>")).toBeNull();
    expect(await getNews(undefined, async () => { throw new Error("net"); })).toBeNull();
  });
});
