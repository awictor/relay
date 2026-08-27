import { describe, it, expect } from "vitest";
import { mapPool } from "../src/lib/pool.js";

describe("mapPool", () => {
  it("preserves item order regardless of completion order", async () => {
    const out = await mapPool([30, 0, 10], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:0", "2:10"]);
  });

  it("bounds in-flight fn calls to `limit`", async () => {
    let active = 0, maxActive = 0;
    await mapPool(Array.from({ length: 8 }, (_, i) => i), 3, async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBe(3);
  });

  it("clamps limit to >=1 (0/negative/NaN behave as 1 → sequential)", async () => {
    for (const bad of [0, -5, NaN]) {
      let active = 0, maxActive = 0;
      await mapPool([1, 2, 3], bad, async () => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 3));
        active--;
      });
      expect(maxActive).toBe(1);
    }
  });

  it("runs every item and passes the correct index", async () => {
    const seen: number[] = [];
    const out = await mapPool(["a", "b", "c", "d"], 2, async (v, i) => { seen.push(i); return `${v}${i}`; });
    expect(out).toEqual(["a0", "b1", "c2", "d3"]);
    expect(seen.sort()).toEqual([0, 1, 2, 3]);
  });

  it("empty input returns empty array, spawns no workers", async () => {
    let calls = 0;
    const out = await mapPool([], 4, async () => { calls++; return 1; });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
