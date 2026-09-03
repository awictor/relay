import { describe, it, expect, afterEach } from "vitest";
import { parseListCommand, parseListExport, normalizeListName, splitItems, ListStore, MAX_ITEMS_PER_LIST } from "../src/lib/lists.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-lists-")); dirs.push(d); return join(d, "lists.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d.replace(/\/lists\.json$/, ""), { recursive: true, force: true }); });

describe("normalizeListName", () => {
  it("strips leading my/the + trailing 'list' and lowercases", () => {
    expect(normalizeListName("my grocery list")).toBe("grocery");
    expect(normalizeListName("the groceries")).toBe("groceries");
    expect(normalizeListName("Grocery")).toBe("grocery");
    expect(normalizeListName("shopping list")).toBe("shopping");
  });
  it("defaults an empty/bare name to 'list'", () => {
    expect(normalizeListName("list")).toBe("list");
    expect(normalizeListName("my list")).toBe("list");
    expect(normalizeListName("")).toBe("list");
  });
});

describe("parseListExport (csv-export-tabular)", () => {
  it("parses export/download of a named list, with or without an 'as csv' tail", () => {
    expect(parseListExport("export my grocery list")).toEqual({ list: "grocery" });
    expect(parseListExport("download my grocery list as csv")).toEqual({ list: "grocery" });
    expect(parseListExport("send me the packing list as a spreadsheet")).toEqual({ list: "packing" });
    expect(parseListExport("save my to-do list to a file")).toEqual({ list: "to-do" });
  });
  it("requires an export verb + a 'list' target (doesn't hijack show/download-other)", () => {
    expect(parseListExport("my grocery list")).toBeNull();        // a show, handled elsewhere
    expect(parseListExport("what's on my grocery list")).toBeNull();
    expect(parseListExport("download my invoice")).toBeNull();     // not a list
    expect(parseListExport("export the data")).toBeNull();
  });
});

describe("parseListCommand", () => {
  it("parses add to a named list", () => {
    expect(parseListCommand("add eggs to my grocery list")).toEqual({ op: "add", list: "grocery", item: "eggs" });
    expect(parseListCommand("put oat milk on my shopping list")).toEqual({ op: "add", list: "shopping", item: "oat milk" });
    expect(parseListCommand("add milk and bread to my grocery list")).toEqual({ op: "add", list: "grocery", item: "milk and bread" });
  });
  it("requires the word 'list' for add (so 'add a comment to the PR' falls through)", () => {
    expect(parseListCommand("add a comment to the PR")).toBeNull();
    expect(parseListCommand("add this to the readme")).toBeNull();
  });
  it("parses remove / cross off / check off", () => {
    expect(parseListCommand("remove milk from my grocery list")).toEqual({ op: "remove", list: "grocery", item: "milk" });
    expect(parseListCommand("cross off eggs from my list")).toEqual({ op: "remove", list: "list", item: "eggs" });
    expect(parseListCommand("take milk off my grocery list")).toEqual({ op: "remove", list: "grocery", item: "milk" });
  });
  it("parses show variants", () => {
    expect(parseListCommand("what's on my grocery list")).toEqual({ op: "show", list: "grocery" });
    expect(parseListCommand("whats in my list")).toEqual({ op: "show", list: "list" });
    expect(parseListCommand("show me my grocery list")).toEqual({ op: "show", list: "grocery" });
    expect(parseListCommand("my grocery list")).toEqual({ op: "show", list: "grocery" });
    expect(parseListCommand("my grocery list?")).toEqual({ op: "show", list: "grocery" });
  });
  it("parses clear / empty", () => {
    expect(parseListCommand("clear my grocery list")).toEqual({ op: "clear", list: "grocery" });
    expect(parseListCommand("empty my list")).toEqual({ op: "clear", list: "list" });
  });
  it("returns null for non-list chatter", () => {
    expect(parseListCommand("what's the weather")).toBeNull();
    expect(parseListCommand("remind me to buy eggs")).toBeNull();
    expect(parseListCommand("my favorite color")).toBeNull(); // no 'list'
  });
});

describe("splitItems", () => {
  it("splits on 'and' and commas, trims trailing punctuation", () => {
    expect(splitItems("milk and bread")).toEqual(["milk", "bread"]);
    expect(splitItems("eggs, milk, bread")).toEqual(["eggs", "milk", "bread"]);
    expect(splitItems("eggs.")).toEqual(["eggs"]);
  });
  it("keeps a single item intact", () => {
    expect(splitItems("oat milk")).toEqual(["oat milk"]);
  });
});

describe("ListStore", () => {
  it("adds, dedupes case-insensitively, and shows", () => {
    const s = new ListStore({ file: tmp() });
    const first = s.add(1, "grocery", ["eggs", "milk"])!;
    expect(first.added).toEqual(["eggs", "milk"]);
    expect(first.saved).toBe(true); // persisted OK (lists-remove-atomic-write-failure)
    const r = s.add(1, "grocery", ["EGGS", "bread"]);
    expect(r!.added).toEqual(["bread"]); // eggs deduped
    expect(s.show(1, "grocery")).toEqual(["eggs", "milk", "bread"]);
  });
  it("removes an exact match, leaving whole-word neighbors alone (no substring collateral)", () => {
    const s = new ListStore({ file: tmp() });
    s.add(1, "grocery", ["milk", "almond milk", "milk chocolate", "eggs"]);
    // "milk" exactly matches only the "milk" item — NOT "almond milk" / "milk chocolate"
    // (lists-remove-substring-collateral: exact tier wins alone).
    expect(s.remove(1, "grocery", "milk")).toEqual(["milk"]);
    expect(s.show(1, "grocery")).toEqual(["almond milk", "milk chocolate", "eggs"]);
    expect(s.remove(1, "grocery", "nope")).toEqual([]);
  });
  it("removes an all-words match when there's no exact hit", () => {
    const s = new ListStore({ file: tmp() });
    s.add(1, "grocery", ["almond milk", "milk chocolate", "eggs"]);
    // no bare "almond milk" exact vs "almond milk" — it IS exact, removed alone
    expect(s.remove(1, "grocery", "almond milk")).toEqual(["almond milk"]);
    expect(s.show(1, "grocery")).toEqual(["milk chocolate", "eggs"]);
  });
  it("falls back to some-words match only when no exact/all-words hit exists", () => {
    const s = new ListStore({ file: tmp() });
    s.add(1, "grocery", ["oat milk", "eggs"]);
    // "milk" is not an exact item and no item contains ALL of {milk} as... actually {milk} IS all-words
    // of "oat milk" -> tier 2 removes it. Confirms a partial query still targets the right item.
    expect(s.remove(1, "grocery", "milk")).toEqual(["oat milk"]);
    expect(s.show(1, "grocery")).toEqual(["eggs"]);
  });
  it("clears a list and reports the count", () => {
    const s = new ListStore({ file: tmp() });
    s.add(1, "grocery", ["a", "b", "c"]);
    expect(s.clear(1, "grocery")).toBe(3);
    expect(s.show(1, "grocery")).toEqual([]);
    expect(s.clear(1, "grocery")).toBe(0); // already empty
  });
  it("keeps lists separate per chat and per name", () => {
    const s = new ListStore({ file: tmp() });
    s.add(1, "grocery", ["eggs"]);
    s.add(1, "packing", ["socks"]);
    s.add(2, "grocery", ["milk"]);
    expect(s.show(1, "grocery")).toEqual(["eggs"]);
    expect(s.show(1, "packing")).toEqual(["socks"]);
    expect(s.show(2, "grocery")).toEqual(["milk"]);
    expect(s.names(1).sort()).toEqual(["grocery", "packing"]);
  });
  it("persists across instances (atomic store)", () => {
    const f = tmp();
    new ListStore({ file: f }).add(1, "grocery", ["eggs"]);
    expect(new ListStore({ file: f }).show(1, "grocery")).toEqual(["eggs"]);
  });
  it("returns null when the per-chat list cap is exceeded on a new list", () => {
    const s = new ListStore({ file: tmp() });
    for (let i = 0; i < 20; i++) expect(s.add(1, `l${i}`, ["x"])).not.toBeNull();
    expect(s.add(1, "l20", ["x"])).toBeNull(); // 21st list rejected
  });
  it("reports items dropped because the list is FULL as `capped`, not silently (lists-cap-silent-drop)", () => {
    const s = new ListStore({ file: tmp() });
    const fill = Array.from({ length: MAX_ITEMS_PER_LIST }, (_, i) => `item${i}`);
    const full = s.add(1, "grocery", fill)!;
    expect(full.added).toHaveLength(MAX_ITEMS_PER_LIST);
    expect(full.capped).toEqual([]);
    // The list is now at the cap — two more items can't fit + must be reported, not swallowed.
    const over = s.add(1, "grocery", ["overflow-a", "overflow-b"])!;
    expect(over.added).toEqual([]);
    expect(over.capped).toEqual(["overflow-a", "overflow-b"]);
    expect(s.show(1, "grocery")).toHaveLength(MAX_ITEMS_PER_LIST); // nothing beyond the cap stored
  });
  it("a dedupe is NOT reported as capped (distinct signals)", () => {
    const s = new ListStore({ file: tmp() });
    s.add(1, "grocery", ["eggs"]);
    const r = s.add(1, "grocery", ["eggs", "milk"])!; // eggs dedupes, milk adds, nothing capped
    expect(r.added).toEqual(["milk"]);
    expect(r.capped).toEqual([]);
  });
});
