import { describe, it, expect, afterEach } from "vitest";
import { PlacesStore, parseSavePlace, parseForgetPlace, isListPlacesRequest } from "../src/lib/places-store.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-places-")); dirs.push(d); return join(d, "p.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("parseSavePlace", () => {
  it("parses the common save forms", () => {
    expect(parseSavePlace("my work is 500 5th Ave, NYC")).toEqual({ name: "work", address: "500 5th Ave, NYC" });
    expect(parseSavePlace("save gym: Gold's on Main St")).toEqual({ name: "gym", address: "Gold's on Main St" });
    expect(parseSavePlace("save my gym as Gold's on Main")).toEqual({ name: "gym", address: "Gold's on Main" });
    expect(parseSavePlace("set home to 12 Oak Rd")).toEqual({ name: "home", address: "12 Oak Rd" });
    expect(parseSavePlace("remember my office is 1 Infinite Loop, Cupertino")).toEqual({ name: "office", address: "1 Infinite Loop, Cupertino" });
    expect(parseSavePlace("the gym is at 40 Fitness Way")).toEqual({ name: "gym", address: "40 Fitness Way" });
  });
  it("does NOT capture a normal status sentence", () => {
    expect(parseSavePlace("my day is great")).toBeNull();       // no place-shaped address
    expect(parseSavePlace("my flight is delayed")).toBeNull();
    expect(parseSavePlace("what's the weather")).toBeNull();
    expect(parseSavePlace("my really long alias phrase that is too many words is somewhere")).toBeNull(); // alias >3 words
  });
});

describe("parseForgetPlace / isListPlacesRequest", () => {
  it("parses a forget-place command", () => {
    expect(parseForgetPlace("forget my work address")).toBe("work");
    expect(parseForgetPlace("forget the gym place")).toBe("gym");
    expect(parseForgetPlace("forget everything")).toBeNull(); // not a place-forget
  });
  it("detects a list-places request", () => {
    expect(isListPlacesRequest("what places do you have")).toBe(true);
    expect(isListPlacesRequest("my saved places")).toBe(true);
    expect(isListPlacesRequest("list my addresses")).toBe(true);
    expect(isListPlacesRequest("weather at the gym")).toBe(false);
  });
});

describe("PlacesStore", () => {
  it("saves, resolves, overwrites, forgets, persists", () => {
    const f = tmp();
    const s = new PlacesStore({ file: f });
    s.save(1, "work", "500 5th Ave", NOW);
    expect(s.resolve(1, "work")).toBe("500 5th Ave");
    expect(s.resolve(1, "WORK")).toBe("500 5th Ave"); // case-insensitive
    expect(s.resolve(1, "gym")).toBeNull();
    // re-saving the same alias updates the address (a correction), no duplicate
    s.save(1, "work", "1 New Plaza", NOW + 1);
    expect(s.resolve(1, "work")).toBe("1 New Plaza");
    expect(s.list(1)).toHaveLength(1);
    // survives a reload
    expect(new PlacesStore({ file: f }).resolve(1, "work")).toBe("1 New Plaza");
    // forget
    expect(s.forget(1, "work")).toBe(true);
    expect(s.resolve(1, "work")).toBeNull();
    expect(s.forget(1, "work")).toBe(false); // already gone
  });
  it("contextLine injects the aliases for the agent, or empty when none", () => {
    const s = new PlacesStore({ file: tmp() });
    expect(s.contextLine(1)).toBe("");
    s.save(1, "work", "500 5th Ave", NOW);
    s.save(1, "gym", "Gold's", NOW);
    const line = s.contextLine(1);
    expect(line).toMatch(/work = 500 5th Ave/);
    expect(line).toMatch(/gym = Gold's/);
  });
  it("places are per-chat", () => {
    const s = new PlacesStore({ file: tmp() });
    s.save(1, "work", "A", NOW);
    expect(s.resolve(2, "work")).toBeNull();
  });
});
