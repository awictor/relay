import { describe, it, expect, afterEach } from "vitest";
import { NotesStore, parseRemember, parseForgetFact, isRecallRequest } from "../src/lib/notes.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-notes-")); dirs.push(d); return join(d, "n.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NOW = 1_700_000_000_000;

describe("parseRemember", () => {
  it("parses a durable fact from remember/note phrasings", () => {
    expect(parseRemember("remember my wife's birthday is June 3")).toBe("my wife's birthday is June 3");
    expect(parseRemember("remember that I'm vegetarian")).toBe("I'm vegetarian");
    expect(parseRemember("note that I park in section G")).toBe("I park in section G");
    expect(parseRemember("/remember the wifi code is swordfish")).toBe("the wifi code is swordfish");
  });
  it("does NOT capture a reminder to-do (that's a scheduled task)", () => {
    expect(parseRemember("remember to call mom")).toBeNull();
    expect(parseRemember("remind me to stretch in 10 min")).toBeNull();
  });
  it("strips quotes + trailing punctuation and caps length", () => {
    expect(parseRemember('remember "I like oat milk".')).toBe("I like oat milk");
    expect(parseRemember("remember " + "x".repeat(400))!.length).toBe(300);
  });
  it("null for a non-remember message", () => {
    expect(parseRemember("what's the weather")).toBeNull();
  });
});

describe("parseForgetFact", () => {
  it("parses a fuzzy fact-forget by term", () => {
    expect(parseForgetFact("forget that I'm vegetarian")).toEqual({ term: "I'm vegetarian" });
    expect(parseForgetFact("forget the fact that I park in G")).toEqual({ term: "I park in G" });
  });
  it("parses a clear-all", () => {
    expect(parseForgetFact("forget everything you know about me")).toEqual({ all: true });
    expect(parseForgetFact("forget what you know")).toEqual({ all: true });
  });
  it("does NOT match a plain /forget <recipe-name> (no fact phrasing)", () => {
    expect(parseForgetFact("forget btc-price")).toBeNull();
    expect(parseForgetFact("forget my-report")).toBeNull();
  });
});

describe("isRecallRequest", () => {
  it("detects a what-do-you-know ask", () => {
    expect(isRecallRequest("what do you know about me")).toBe(true);
    expect(isRecallRequest("what do you remember?")).toBe(true);
    expect(isRecallRequest("what have I told you")).toBe(true);
  });
  it("ignores a normal question", () => {
    expect(isRecallRequest("what do you think of bitcoin")).toBe(false);
  });
});

describe("NotesStore", () => {
  it("adds, lists, and injects facts into the agent context line", () => {
    const s = new NotesStore({ file: tmp() });
    s.add(1, "I'm vegetarian", NOW);
    s.add(1, "my wife's birthday is June 3", NOW + 1);
    expect(s.list(1).map((n) => n.text)).toEqual(["I'm vegetarian", "my wife's birthday is June 3"]);
    expect(s.contextLine(1)).toBe("things the user asked me to remember: I'm vegetarian; my wife's birthday is June 3");
    expect(s.contextLine(2)).toBe(""); // no notes for another chat
  });
  it("de-dupes an exact repeat (case-insensitive)", () => {
    const s = new NotesStore({ file: tmp() });
    s.add(1, "I'm vegetarian", NOW);
    s.add(1, "i'm VEGETARIAN", NOW + 1);
    expect(s.list(1)).toHaveLength(1);
  });
  it("forgets by whole-word match, returns the removed facts' text", () => {
    const s = new NotesStore({ file: tmp() });
    s.add(1, "I'm vegetarian", NOW);
    s.add(1, "I park in section G", NOW + 1);
    expect(s.forget(1, "vegetarian")).toEqual(["I'm vegetarian"]);
    expect(s.list(1).map((n) => n.text)).toEqual(["I park in section G"]);
    expect(s.forget(1, "nomatch")).toEqual([]);
  });
  it("does NOT delete an unrelated fact via a substring collision (notes-forget-substring-collateral)", () => {
    const s = new NotesStore({ file: tmp() });
    s.add(1, "I drink tea", NOW);
    s.add(1, "my niece Teagan's birthday is June 3", NOW + 1);
    // "tea" is a whole word only in the first fact — "Teagan" must survive.
    expect(s.forget(1, "I drink tea")).toEqual(["I drink tea"]);
    expect(s.list(1).map((n) => n.text)).toEqual(["my niece Teagan's birthday is June 3"]);
  });
  it("prefers the exact/all-words match tier over partial matches", () => {
    const s = new NotesStore({ file: tmp() });
    s.add(1, "I like oat milk", NOW);
    s.add(1, "I like almond milk", NOW + 1);
    s.add(1, "I'm allergic to soy milk", NOW + 2);
    // "oat milk" — both words hit only the first fact (score 2); the others share just "milk" (score 1).
    expect(s.forget(1, "oat milk")).toEqual(["I like oat milk"]);
    expect(s.list(1)).toHaveLength(2);
  });
  it("clears all facts for a chat", () => {
    const s = new NotesStore({ file: tmp() });
    s.add(1, "a", NOW); s.add(1, "b", NOW + 1);
    expect(s.clear(1)).toBe(2);
    expect(s.list(1)).toHaveLength(0);
  });
  it("caps notes per chat, dropping the oldest", () => {
    const s = new NotesStore({ file: tmp() });
    for (let i = 0; i < 35; i++) s.add(1, `fact ${i}`, NOW + i);
    const list = s.list(1);
    expect(list).toHaveLength(30);
    expect(list[0]!.text).toBe("fact 5");   // oldest 5 dropped
    expect(list[29]!.text).toBe("fact 34");
  });
  it("reports what was evicted at the cap so the caller can warn (notes-cap-silent-evict)", () => {
    const s = new NotesStore({ file: tmp() });
    for (let i = 0; i < 30; i++) s.add(1, `fact ${i}`, NOW + i); // fill to the cap
    const r = s.add(1, "the new fact", NOW + 100);
    expect(r.evicted).toEqual(["fact 0"]); // oldest aged out, and it's named
    expect(r.dup).toBe(false);
    // A normal add below the cap evicts nothing.
    s.clear(1);
    expect(s.add(1, "solo", NOW).evicted).toEqual([]);
  });
  it("marks an exact repeat as dup (nothing stored, nothing evicted)", () => {
    const s = new NotesStore({ file: tmp() });
    s.add(1, "I'm vegetarian", NOW);
    const r = s.add(1, "I'M VEGETARIAN", NOW + 1);
    expect(r.dup).toBe(true);
    expect(r.evicted).toEqual([]);
    expect(s.list(1)).toHaveLength(1);
  });
  it("persists across reloads", () => {
    const f = tmp();
    const a = new NotesStore({ file: f });
    a.add(9, "I like oat milk", NOW);
    const b = new NotesStore({ file: f });
    expect(b.list(9).map((n) => n.text)).toEqual(["I like oat milk"]);
  });
});
