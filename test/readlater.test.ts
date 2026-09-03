import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseSavePage, parseSavedRecall, hostLabel, SavedStore } from "../src/lib/readlater.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "relay-saved-")), "s.json");
const NOW = 1_700_000_000_000;

describe("parseSavePage (read-it-later-capture)", () => {
  it("captures a save/bookmark/read-later command with a URL", () => {
    expect(parseSavePage("save this https://ex.com/a")).toBe("https://ex.com/a");
    expect(parseSavePage("save this for later: https://ex.com/b")).toBe("https://ex.com/b");
    expect(parseSavePage("bookmark https://ex.com/c")).toBe("https://ex.com/c");
    expect(parseSavePage("read it later https://ex.com/d")).toBe("https://ex.com/d");
    expect(parseSavePage("/save https://ex.com/e")).toBe("https://ex.com/e");
    expect(parseSavePage("save https://ex.com/f to read later")).toBe("https://ex.com/f");
  });
  it("is null without a save verb, or with a verb but no URL", () => {
    expect(parseSavePage("read this https://ex.com/x")).toBeNull();   // fetch-now, not save
    expect(parseSavePage("should I save this article?")).toBeNull();  // a question, no URL
    expect(parseSavePage("save this")).toBeNull();                    // no URL
    expect(parseSavePage("https://ex.com/bare")).toBeNull();          // bare link -> agent
  });
});

describe("parseSavedRecall", () => {
  it("captures recall asks, with and without a topic", () => {
    expect(parseSavedRecall("what did I save about the fed")).toEqual({ topic: "the fed" });
    expect(parseSavedRecall("what have I saved")).toEqual({ topic: "" });
    expect(parseSavedRecall("show my saved pages")).toEqual({ topic: "" });
    expect(parseSavedRecall("my reading list")).toEqual({ topic: "" });
    expect(parseSavedRecall("search my saved for tariffs")).toEqual({ topic: "tariffs" });
    expect(parseSavedRecall("/saved rust")).toEqual({ topic: "rust" });
  });
  it("is null for non-recall chatter", () => {
    expect(parseSavedRecall("what's the weather")).toBeNull();
    expect(parseSavedRecall("save this https://ex.com")).toBeNull();
  });
});

describe("hostLabel", () => {
  it("strips protocol + www", () => {
    expect(hostLabel("https://www.nytimes.com/x/y")).toBe("nytimes.com");
    expect(hostLabel("http://example.org")).toBe("example.org");
    expect(hostLabel("not a url")).toBe("not a url");
  });
});

describe("SavedStore", () => {
  it("adds, lists, and searches by topic across title + summary", () => {
    const s = new SavedStore({ file: tmp() });
    s.add(1, { url: "https://a.com", title: "Fed holds rates", summary: "The central bank kept rates steady." }, NOW);
    s.add(1, { url: "https://b.com", title: "Rust 2.0 released", summary: "New borrow checker and async." }, NOW + 1);
    // topic hits the title (weighted) -> Fed page first.
    const fed = s.search(1, "fed rates");
    expect(fed[0]!.url).toBe("https://a.com");
    // topic in the summary still matches.
    expect(s.search(1, "async").map((p) => p.url)).toEqual(["https://b.com"]);
    // no topic -> most-recent first.
    expect(s.search(1, "").map((p) => p.url)).toEqual(["https://b.com", "https://a.com"]);
    // a miss returns nothing.
    expect(s.search(1, "quantum")).toEqual([]);
  });
  it("de-dupes a re-save by URL (updates in place, no duplicate)", () => {
    const s = new SavedStore({ file: tmp() });
    s.add(1, { url: "https://a.com", title: "v1", summary: "first" }, NOW);
    const r = s.add(1, { url: "https://a.com", title: "v2", summary: "second" }, NOW + 1);
    expect(r.dup).toBe(true);
    expect(s.list(1)).toHaveLength(1);
    expect(s.list(1)[0]!.title).toBe("v2");
  });
  it("falls back to a host-label title when none is given", () => {
    const s = new SavedStore({ file: tmp() });
    const r = s.add(1, { url: "https://www.example.com/deep/path", summary: "x" }, NOW);
    expect(r.page.title).toBe("example.com");
  });
  it("forgets by URL and by topic; persists across reload", () => {
    const f = tmp();
    const s = new SavedStore({ file: f });
    s.add(1, { url: "https://a.com", title: "Fed rates", summary: "steady" }, NOW);
    s.add(1, { url: "https://b.com", title: "Rust news", summary: "async" }, NOW + 1);
    expect(s.forget(1, "https://a.com")).toEqual(["Fed rates"]); // by URL
    expect(s.list(1)).toHaveLength(1);
    // reload -> persisted
    const s2 = new SavedStore({ file: f });
    expect(s2.list(1).map((p) => p.url)).toEqual(["https://b.com"]);
    expect(s2.forget(1, "rust")).toEqual(["Rust news"]);        // by topic (title whole-word)
    expect(s2.list(1)).toHaveLength(0);
  });
  it("caps per chat, evicting oldest", () => {
    const s = new SavedStore({ file: tmp() });
    for (let i = 0; i < 105; i++) s.add(1, { url: `https://x.com/${i}`, title: `t${i}`, summary: "s" }, NOW + i);
    expect(s.list(1).length).toBeLessThanOrEqual(100);
    // the oldest (t0) is gone, the newest (t104) remains.
    expect(s.list(1).some((p) => p.url === "https://x.com/0")).toBe(false);
    expect(s.list(1).some((p) => p.url === "https://x.com/104")).toBe(true);
  });
});
