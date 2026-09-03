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
    const body = JSON.stringify({ data: { children: [{ data: { title: "Post A", name: "t3_a" } }, { data: { title: "Post B", permalink: "/r/x/b" } }] } });
    expect(parseFeed("reddit", body)).toEqual([{ title: "Post A", id: "t3_a" }, { title: "Post B", id: "/r/x/b" }]);
  });
  it("parses HN Algolia hits with objectID as the stable id", () => {
    const body = JSON.stringify({ hits: [{ title: "Story A", objectID: "111" }, { story_title: "Story B", objectID: "222" }, { title: "" }] });
    expect(parseFeed("hn", body)).toEqual([{ title: "Story A", id: "111" }, { title: "Story B", id: "222" }]);
  });
  it("parses RSS <item> title + guid/link id, skipping the channel title", () => {
    const xml = `<rss><channel><title>My Blog</title>
      <item><title>First Post</title><guid>https://blog/1</guid></item>
      <item><title><![CDATA[Second & Third]]></title><link>https://blog/2</link></item>
    </channel></rss>`;
    expect(parseFeed("rss", xml)).toEqual([
      { title: "First Post", id: "https://blog/1" },
      { title: "Second & Third", id: "https://blog/2" },
    ]);
  });
  it("parses Atom <entry> title + link href id (YouTube/Reddit rss)", () => {
    const xml = `<feed><title>Channel Name</title>
      <entry><title>Video One</title><link href="https://yt/1"/></entry>
      <entry><title>Video Two</title><id>yt:video:2</id></entry></feed>`;
    expect(parseFeed("youtube", xml)).toEqual([
      { title: "Video One", id: "https://yt/1" },
      { title: "Video Two", id: "yt:video:2" },
    ]);
  });
  it("keeps two same-titled items distinct when their ids differ (feed-dedup-title-only)", () => {
    const xml = `<feed>
      <entry><title>Daily Discussion Thread</title><id>a</id></entry>
      <entry><title>Daily Discussion Thread</title><id>b</id></entry></feed>`;
    const items = parseFeed("rss", xml);
    expect(items).toHaveLength(2);
    expect(items[0]!.id).not.toBe(items[1]!.id);
  });
  it("returns [] on malformed input (caller stays silent, never a false new)", () => {
    expect(parseFeed("reddit", "not json")).toEqual([]);
    expect(parseFeed("rss", "<html>no items</html>")).toEqual([]);
  });
});

describe("parseXmlTitles (back-compat: titles only)", () => {
  it("decodes entities and strips CDATA", () => {
    const xml = `<feed><entry><title>Tom &amp; Jerry &lt;3</title></entry></feed>`;
    expect(parseXmlTitles(xml)).toEqual(["Tom & Jerry <3"]);
  });
});

describe("fetchFeedItems", () => {
  it("fetches the source URL and parses items into {title,id}", async () => {
    let seen = "";
    const items = await fetchFeedItems(
      { kind: "hn", url: "https://hn/x", label: "HN" },
      async (u) => { seen = u; return JSON.stringify({ hits: [{ title: "A", objectID: "9" }] }); },
    );
    expect(seen).toBe("https://hn/x");
    expect(items).toEqual([{ title: "A", id: "9" }]);
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
