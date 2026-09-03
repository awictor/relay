import { describe, it, expect, afterEach } from "vitest";
import { parseRecipeCommand, parseRunCommand, parseRunWithArgs, parseSaveThatAs, parseWatchThat, parseScheduleThat, applySlots, slotNames, hasSlots, parseChainSteps, isChain, RecipeStore } from "../src/lib/recipes.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
function tmpFile() { const d = mkdtempSync(join(tmpdir(), "relay-recipe-")); dirs.push(d); return join(d, "r.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("parseRunWithArgs (parameterized recipes)", () => {
  it("splits name from args", () => {
    expect(parseRunWithArgs("/run track sneakers")).toEqual({ name: "track", args: "sneakers" });
    expect(parseRunWithArgs("run track blue running shoes")).toEqual({ name: "track", args: "blue running shoes" });
  });
  it("no args -> empty args string", () => {
    expect(parseRunWithArgs("/run morning")).toEqual({ name: "morning", args: "" });
    expect(parseRunWithArgs("run recipe morning")).toEqual({ name: "morning", args: "" });
  });
  it("null for a non-run message", () => {
    expect(parseRunWithArgs("what's the weather")).toBeNull();
  });
});

describe("parseSaveThatAs (save-that-as)", () => {
  it("captures the name from 'save that/this/it/the last one as <name>'", () => {
    expect(parseSaveThatAs("save that as morning-btc")).toBe("morning-btc");
    expect(parseSaveThatAs("save this as weather")).toBe("weather");
    expect(parseSaveThatAs("save it as hn")).toBe("hn");
    expect(parseSaveThatAs("save the last one as report")).toBe("report");
  });
  it("returns null for the colon form + non-save messages", () => {
    expect(parseSaveThatAs("save btc: check the price")).toBeNull(); // that's parseRecipeCommand's job
    expect(parseSaveThatAs("what's the weather")).toBeNull();
    expect(parseSaveThatAs("save that")).toBeNull(); // no name
  });
});

describe("parseWatchThat / parseScheduleThat (watch-schedule-that-by-ref)", () => {
  it("parseWatchThat captures the alert clause (or empty for a bare watch that)", () => {
    expect(parseWatchThat("watch that")).toEqual({ clause: "" });
    expect(parseWatchThat("watch that below 50000")).toEqual({ clause: "below 50000" });
    expect(parseWatchThat("alert me if that back in stock")).toEqual({ clause: "back in stock" });
    expect(parseWatchThat("watch btc: price")).toBeNull(); // a real define, not watch-that
    expect(parseWatchThat("what's the weather")).toBeNull();
  });
  it("parseScheduleThat captures the timing clause", () => {
    expect(parseScheduleThat("schedule that every morning")).toEqual({ clause: "every morning" });
    expect(parseScheduleThat("do that every day at 8am")).toEqual({ clause: "every day at 8am" });
    expect(parseScheduleThat("schedule morning every day")).toBeNull(); // named recipe, not "that"
    expect(parseScheduleThat("do that thing")).toBeNull(); // no cadence clause
  });
});

describe("applySlots", () => {
  it("fills a named slot with the arg string", () => {
    expect(applySlots("check the price of {item}", "sneakers")).toBe("check the price of sneakers");
  });
  it("fills every slot with the arg (recipes are simple)", () => {
    expect(applySlots("compare {item} on site A vs {item} on site B", "gpu")).toBe("compare gpu on site A vs gpu on site B");
  });
  it("no slot -> unchanged (stray args ignored)", () => {
    expect(applySlots("check bitcoin price", "sneakers")).toBe("check bitcoin price");
  });
  it("a repeated SAME slot name still fills both (one distinct slot)", () => {
    expect(applySlots("compare {item} vs {item}", "gpu")).toBe("compare gpu vs gpu");
  });
  it("DISTINCT slots fill by name=value pairs (multi-slot-recipes)", () => {
    expect(applySlots("track {item} at {store}", "item=milk store=HEB")).toBe("track milk at HEB");
    expect(applySlots('email {who} about {topic}', 'topic="the rent" who=bob')).toBe("email bob about the rent");
  });
  it("DISTINCT slots fill by POSITION when no pairs given (comma then whitespace)", () => {
    expect(applySlots("track {item} at {store}", "milk, HEB")).toBe("track milk at HEB");
    expect(applySlots("track {item} at {store}", "milk HEB")).toBe("track milk at HEB");
  });
  it("a distinct slot with no matching arg is left blank", () => {
    expect(applySlots("track {item} at {store}", "item=milk")).toBe("track milk at ");
  });
});

describe("slotNames", () => {
  it("returns distinct slot names in first-appearance order", () => {
    expect(slotNames("track {item} at {store} for {item}")).toEqual(["item", "store"]);
    expect(slotNames("no slots here")).toEqual([]);
  });
});

describe("hasSlots", () => {
  it("true when the task has a {slot}", () => {
    expect(hasSlots("track price of {item}")).toBe(true);
  });
  it("false for a plain task", () => {
    expect(hasSlots("check bitcoin price")).toBe(false);
  });
});

describe("parseRecipeCommand", () => {
  it("parses 'save <name>: <task>'", () => {
    expect(parseRecipeCommand("save btc: check the price of bitcoin")).toEqual({ name: "btc", task: "check the price of bitcoin" });
  });
  it("parses 'save recipe <name>: <task>' and lowercases the name", () => {
    expect(parseRecipeCommand("save recipe Morning News: top 3 HN stories")).toEqual({ name: "morning news", task: "top 3 HN stories" });
  });
  it("returns null without the colon form", () => {
    expect(parseRecipeCommand("save this as btc")).toBeNull();
    expect(parseRecipeCommand("what's the weather")).toBeNull();
    expect(parseRecipeCommand("save btc:")).toBeNull(); // no task
  });
});

describe("parseRunCommand", () => {
  it("parses /run and natural run", () => {
    expect(parseRunCommand("/run btc")).toBe("btc");
    expect(parseRunCommand("run recipe Morning News")).toBe("morning news");
    expect(parseRunCommand("run btc")).toBe("btc");
  });
  it("DEV-0130: strips the explicit 'recipe' keyword in BOTH slash and natural forms", () => {
    expect(parseRunCommand("/run recipe btc")).toBe("btc"); // was "recipe btc" before the fix
    expect(parseRunCommand("/run recipe Morning News")).toBe("morning news");
    expect(parseRunCommand("run recipe btc")).toBe("btc");
    // a recipe literally named "recipe X" is not addressable via the keyword form — acceptable edge.
  });
  it("returns null for non-run text", () => {
    expect(parseRunCommand("running late")).toBeNull(); // "run" needs a space after it
    expect(parseRunCommand("what is /run")).toBeNull();
  });
});

describe("RecipeStore", () => {
  it("add/get/list/remove, name unique per chat", () => {
    const s = new RecipeStore({ file: tmpFile() });
    s.add(1, { name: "btc", task: "price of bitcoin" }, NOW);
    s.add(1, { name: "news", task: "top HN" }, NOW);
    expect(s.list(1).map((r) => r.name)).toEqual(["btc", "news"]);
    expect(s.get(1, "BTC")!.task).toBe("price of bitcoin"); // case-insensitive
    expect(s.remove(1, "btc")).toBe(true);
    expect(s.get(1, "btc")).toBeUndefined();
  });

  it("adding an existing name updates in place (no dupe)", () => {
    const s = new RecipeStore({ file: tmpFile() });
    s.add(1, { name: "btc", task: "old" }, NOW);
    s.add(1, { name: "btc", task: "new" }, NOW);
    expect(s.list(1)).toHaveLength(1);
    expect(s.get(1, "btc")!.task).toBe("new");
  });

  it("persists across reload", () => {
    const file = tmpFile();
    new RecipeStore({ file }).add(7, { name: "x", task: "do x", schedule: "every morning" }, NOW);
    const b = new RecipeStore({ file });
    expect(b.get(7, "x")!.task).toBe("do x");
    expect(b.get(7, "x")!.schedule).toBe("every morning");
  });

  it("enforces the per-chat cap, but an update to an existing name is exempt", () => {
    const s = new RecipeStore({ file: tmpFile(), maxPerChat: 2 });
    expect(s.add(1, { name: "a", task: "1" }, NOW)).toBeTruthy();
    expect(s.add(1, { name: "b", task: "2" }, NOW)).toBeTruthy();
    expect(s.add(1, { name: "c", task: "3" }, NOW)).toBeNull(); // capped
    expect(s.add(1, { name: "a", task: "updated" }, NOW)).toBeTruthy(); // update exempt
    expect(s.get(1, "a")!.task).toBe("updated");
  });
});

describe("parseChainSteps / isChain (recipe-chaining)", () => {
  it("splits on >> into ordered steps", () => {
    const s = parseChainSteps("find flight to {city} >> weather there >> summarize");
    expect(s.map((x) => x.text)).toEqual(["find flight to {city}", "weather there", "summarize"]);
    expect(s.every((x) => x.ifContains === undefined)).toBe(true);
  });
  it("parses an 'if <kw>:' gate on a step", () => {
    const s = parseChainSteps("check price >> if under: draft the order email");
    expect(s[1]).toEqual({ text: "draft the order email", ifContains: "under" });
  });
  it("a task with no >> is a single step; isChain reflects it", () => {
    expect(parseChainSteps("just one task")).toEqual([{ text: "just one task" }]);
    expect(isChain("a >> b")).toBe(true);
    expect(isChain("plain")).toBe(false);
  });
});
