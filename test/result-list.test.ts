import { describe, it, expect } from "vitest";
import { parseResultList, firstUrl } from "../src/lib/result-list.js";

describe("parseResultList", () => {
  it("parses an ascending numbered list", () => {
    const items = parseResultList("Here are the cheapest:\n1. LAX→JFK $220\n2. LAX→JFK $245\n3. LAX→EWR $260");
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ index: 0, text: "LAX→JFK $220" });
    expect(items[2]!.text).toMatch(/EWR/);
  });

  it("parses a bulleted list", () => {
    const items = parseResultList("New listings:\n• 2020 Civic — $18k\n- 2019 Corolla — $16k\n* 2021 Mazda3 — $20k");
    expect(items).toHaveLength(3);
    expect(items[1]!.text).toMatch(/Corolla/);
  });

  it("numbered wins when both markers appear", () => {
    const items = parseResultList("1. first\n2. second\n• a stray bullet");
    expect(items).toHaveLength(2);
    expect(items[0]!.text).toBe("first");
  });

  it("does NOT fire on prose with an incidental number", () => {
    expect(parseResultList("Step 1 is to open the door. Then relax.")).toEqual([]);
    expect(parseResultList("The answer is 42.")).toEqual([]);
  });

  it("skips a numbered list that doesn't start at 1", () => {
    expect(parseResultList("3. three\n4. four")).toEqual([]);
  });

  it("stops the run at a gap (a later 1. can't glue on)", () => {
    const items = parseResultList("1. one\n2. two\nSome prose.\n1. other-section");
    expect(items).toHaveLength(2);
  });

  it("needs 2+ items", () => {
    expect(parseResultList("1. lonely")).toEqual([]);
    expect(parseResultList("• single")).toEqual([]);
  });
});

describe("firstUrl", () => {
  it("extracts the first URL", () => {
    expect(firstUrl("Cheap flight https://kayak.com/x?a=1 book now")).toBe("https://kayak.com/x?a=1");
    expect(firstUrl("no link here")).toBeNull();
  });
});
