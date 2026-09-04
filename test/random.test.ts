import { describe, it, expect } from "vitest";
import { parseRandomRequest, splitOptions, runRandom } from "../src/lib/random.js";

describe("parseRandomRequest (random-decision-helper)", () => {
  it("coin", () => {
    expect(parseRandomRequest("flip a coin")).toEqual({ kind: "coin" });
    expect(parseRandomRequest("heads or tails?")).toEqual({ kind: "coin" });
    expect(parseRandomRequest("give me a coin flip")).toEqual({ kind: "coin" });
  });
  it("dice", () => {
    expect(parseRandomRequest("roll a d20")).toEqual({ kind: "dice", count: 1, sides: 20 });
    expect(parseRandomRequest("roll 2d6")).toEqual({ kind: "dice", count: 2, sides: 6 });
    expect(parseRandomRequest("roll a die")).toEqual({ kind: "dice", count: 1, sides: 6 });
  });
  it("number ranges", () => {
    expect(parseRandomRequest("random number 1-100")).toEqual({ kind: "number", min: 1, max: 100 });
    expect(parseRandomRequest("pick a number between 1 and 10")).toEqual({ kind: "number", min: 1, max: 10 });
    expect(parseRandomRequest("random number up to 50")).toEqual({ kind: "number", min: 1, max: 50 });
    expect(parseRandomRequest("random number")).toEqual({ kind: "number", min: 1, max: 100 }); // bare default
    // reversed range is normalized
    expect(parseRandomRequest("random number between 20 and 5")).toEqual({ kind: "number", min: 5, max: 20 });
  });
  it("pick from options", () => {
    expect(parseRandomRequest("pick one: tacos, sushi, pizza")).toEqual({ kind: "pick", options: ["tacos", "sushi", "pizza"] });
    expect(parseRandomRequest("choose between tacos and sushi")).toEqual({ kind: "pick", options: ["tacos", "sushi"] });
    expect(parseRandomRequest("tacos or sushi")).toEqual({ kind: "pick", options: ["tacos", "sushi"] });
  });
  it("uuid / guid", () => {
    expect(parseRandomRequest("generate a uuid")).toEqual({ kind: "uuid" });
    expect(parseRandomRequest("random uuid")).toEqual({ kind: "uuid" });
    expect(parseRandomRequest("give me a guid")).toEqual({ kind: "uuid" });
    expect(parseRandomRequest("uuid v4")).toEqual({ kind: "uuid" });
  });
  it("null for a non-random message (no hijack)", () => {
    expect(parseRandomRequest("what's the weather")).toBeNull();
    expect(parseRandomRequest("a coin costs a dollar")).toBeNull();
    expect(parseRandomRequest("should I refactor this whole module or leave the legacy code alone for now")).toBeNull(); // long sides, not a quick pick
  });
});

describe("splitOptions", () => {
  it("splits on comma / or / vs", () => {
    expect(splitOptions("a, b, c")).toEqual(["a", "b", "c"]);
    expect(splitOptions("tacos or sushi")).toEqual(["tacos", "sushi"]);
    expect(splitOptions("cats vs dogs")).toEqual(["cats", "dogs"]);
  });
});

describe("runRandom (seeded rng)", () => {
  it("coin: rand<0.5 -> Heads, else Tails", () => {
    expect(runRandom({ kind: "coin" }, () => 0.1)).toBe("🪙 Heads");
    expect(runRandom({ kind: "coin" }, () => 0.9)).toBe("🪙 Tails");
  });
  it("single die shows the roll + die label", () => {
    expect(runRandom({ kind: "dice", count: 1, sides: 20 }, () => 0.5)).toBe("🎲 11 (d20)"); // 1+floor(0.5*20)=11
  });
  it("multi dice show each roll + total", () => {
    expect(runRandom({ kind: "dice", count: 2, sides: 6 }, () => 0)).toBe("🎲 1 + 1 = 2 (2d6)");
  });
  it("number is within the inclusive range", () => {
    expect(runRandom({ kind: "number", min: 1, max: 100 }, () => 0)).toBe("🔢 1 (1–100)");
    expect(runRandom({ kind: "number", min: 1, max: 100 }, () => 0.999)).toBe("🔢 100 (1–100)");
  });
  it("pick returns one of the options", () => {
    expect(runRandom({ kind: "pick", options: ["a", "b", "c"] }, () => 0)).toBe("👉 a");
    expect(runRandom({ kind: "pick", options: ["a", "b", "c"] }, () => 0.99)).toBe("👉 c");
  });
  it("uuid is a well-formed RFC-4122 v4 (version + variant nibbles fixed)", () => {
    // A real PRNG source — assert the SHAPE (version 4, variant 8-b), not an exact value.
    const out = runRandom({ kind: "uuid" }, Math.random);
    expect(out).toMatch(/^🆔 [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
