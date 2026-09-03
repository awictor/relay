import { describe, it, expect } from "vitest";
import { resolveFeedSource, parseFeed, parseXmlTitles, fetchFeedItems, parseFollowCommand, normalizeFollowName } from "../src/lib/feeds.js";

describe("resolveFeedSource", () => {
  it("maps a subreddit to its keyless RSS feed (json 403s from datacenter IPs)", () => {
    const s = resolveFeedSource("r/programming")!;
    expect(s.kind).toBe("rss");
    expect(s.url).toContain("reddit.com/r/programming/new/.rss");
    expect(s.label).toBe("r/programming");
    expect(resolveFeedSource("reddit.com/r/rust")!.url).toContain("/r/rust/");
  });
  it("maps an HN topic to Algolia search-by-date, or front page when no query", () => {
    const q = resolveFeedSource("HN rust")!;
    expect(q.kind).toBe("hn");
    expect(q.url).toContain("query=rust");
    expect(q.url).toContain("tags=story");
    const fp = resolveFeedSource("hacker news")!;
    expect(fp.url).toContain("front_page");
  });
  it("maps a YouTube channel URL to its Atom feed", () => {
    const s = resolveFeedSource("https://youtube.com/channel/UCabc123")!;
    expect(s.kind).toBe("youtube");
    expect(s.url).toContain("channel_id=UCabc123");
  });
  it("treats a bare http(s) URL as an RSS feed", () => {
    const s = resolveFeedSource("https://blog.example.com/feed")!;
    expect(s.kind).toBe("rss");
    expect(s.label).toBe("blog.example.com");
  });
  it("returns null for an unresolvable target", () => {
    expect(resolveFeedSource("my favorite thing")).toBeNull();
    expect(resolveFeedSource("")).toBeNull();
  });
});

describe("parseFeed", () => {
  it("parses Reddit .json titles (kind reddit, legacy path)", () => {
    const body = JSON.stringify({ data: { children: [{ data: { title: "Post A" } }, { data: { title: "Post B" } }] } });
    expect(parseFeed("reddit", body)).toEqual(["Post A", "Post B"]);
  });
  it("parses HN Algolia hits (title or story_title)", () => {
    const body = JSON.stringify({ hits: [{ title: "Story A" }, { story_title: "Story B" }, { title: "" }] });
    expect(parseFeed("hn", body)).toEqual(["Story A", "Story B"]);
  });
  it("parses RSS <item> titles, skipping the channel title", () => {
    const xml = `<rss><channel><title>My Blog</title>
      <item><title>First Post</title></item>
      <item><title><![CDATA[Second & Third]]></title></item>
    </channel></rss>`;
    expect(parseFeed("rss", xml)).toEqual(["First Post", "Second & Third"]);
  });
  it("parses Atom <entry> titles (YouTube/Reddit rss), skipping the feed title", () => {
    const xml = `<feed><title>Channel Name</title>
      <entry><title>Video One</title></entry>
      <entry><title>Video Two</title></entry></feed>`;
    expect(parseFeed("youtube", xml)).toEqual(["Video One", "Video Two"]);
  });
  it("returns [] on malformed input (caller stays silent, never a false new)", () => {
    expect(parseFeed("reddit", "not json")).toEqual([]);
    expect(parseFeed("rss", "<html>no items</html>")).toEqual([]);
  });
});

describe("parseXmlTitles", () => {
  it("decodes entities and strips CDATA", () => {
    const xml = `<feed><entry><title>Tom &amp; Jerry &lt;3</title></entry></feed>`;
    expect(parseXmlTitles(xml)).toEqual(["Tom & Jerry <3"]);
  });
});

describe("fetchFeedItems", () => {
  it("fetches the source URL and parses items", async () => {
    let seen = "";
    const items = await fetchFeedItems(
      { kind: "hn", url: "https://hn/x", label: "HN" },
      async (u) => { seen = u; return JSON.stringify({ hits: [{ title: "A" }] }); },
    );
    expect(seen).toBe("https://hn/x");
    expect(items).toEqual(["A"]);
  });
  it("returns [] when the fetch throws (never a false new item)", async () => {
    const items = await fetchFeedItems({ kind: "rss", url: "https://x", label: "x" }, async () => { throw new Error("net"); });
    expect(items).toEqual([]);
  });
});

describe("parseFollowCommand", () => {
  it("parses a bare follow target", () => {
    expect(parseFollowCommand("follow r/programming")).toEqual({ name: "r/programming", target: "r/programming" });
    expect(parseFollowCommand("subscribe to https://blog.example.com/feed")).toEqual({ name: "blog.example.com", target: "https://blog.example.com/feed" });
  });
  it("parses an HN follow with the resolved label as the name", () => {
    expect(parseFollowCommand("follow HN rust")).toEqual({ name: "hn: rust", target: "HN rust" });
  });
  it("parses an explicit name before a colon when the tail is a real target", () => {
    expect(parseFollowCommand("follow rust news: r/rust")).toEqual({ name: "rust news", target: "r/rust" });
  });
  it("returns null when it isn't a follow command", () => {
    expect(parseFollowCommand("what's the weather")).toBeNull();
    expect(parseFollowCommand("following up on my order")).toBeNull();
  });
});

describe("normalizeFollowName", () => {
  it("lowercases, collapses whitespace, caps length, defaults to feed", () => {
    expect(normalizeFollowName("  My  Blog ")).toBe("my blog");
    expect(normalizeFollowName("")).toBe("feed");
  });
});
