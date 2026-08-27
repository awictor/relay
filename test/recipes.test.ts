import { describe, it, expect, afterEach } from "vitest";
import { parseRecipeCommand, parseRunCommand, RecipeStore } from "../src/lib/recipes.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
function tmpFile() { const d = mkdtempSync(join(tmpdir(), "relay-recipe-")); dirs.push(d); return join(d, "r.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

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
