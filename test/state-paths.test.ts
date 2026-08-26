import { describe, it, expect, afterEach } from "vitest";
import { statePaths, readStoreItems } from "../src/lib/state-paths.js";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-sp-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("statePaths", () => {
  it("defaults to the data/ paths when env is empty", () => {
    const p = statePaths({});
    expect(p.schedules).toBe("data/relay-schedules.json");
    expect(p.recipes).toBe("data/relay-recipes.json");
    expect(p.digests).toBe("data/relay-digests.json");
    expect(p.alerts).toBe("data/relay-alerts.json");
    expect(p.memory).toBe("data/relay-memory.json");
    expect(p.metrics).toBe("data/relay-metrics.json");
  });

  it("env overrides win (a deploy can relocate the data dir)", () => {
    const p = statePaths({ RELAY_SCHEDULE_FILE: "/srv/s.json", RELAY_ALERT_FILE: "/srv/a.json" });
    expect(p.schedules).toBe("/srv/s.json");
    expect(p.alerts).toBe("/srv/a.json");
    expect(p.recipes).toBe("data/relay-recipes.json"); // unset -> default
  });
});

describe("readStoreItems", () => {
  it("reads the items array from a {v,items} store file", () => {
    const f = join(tmp(), "s.json");
    writeFileSync(f, JSON.stringify({ v: 1, items: [{ chatId: 1 }, { chatId: 2 }] }));
    expect(readStoreItems(f)).toHaveLength(2);
  });

  it("returns [] for a missing file (never throws)", () => {
    expect(readStoreItems(join(tmp(), "nope.json"))).toEqual([]);
  });

  it("returns [] for corrupt JSON", () => {
    const f = join(tmp(), "bad.json");
    writeFileSync(f, "{not json");
    expect(readStoreItems(f)).toEqual([]);
  });

  it("returns [] when items is missing or not an array", () => {
    const f = join(tmp(), "shape.json");
    writeFileSync(f, JSON.stringify({ v: 1, items: { nope: true } }));
    expect(readStoreItems(f)).toEqual([]);
  });
});
