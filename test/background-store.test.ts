import { describe, it, expect, afterEach } from "vitest";
import { BackgroundStore, planErrandReplay, STALE_ERRAND_MS, MAX_ERRAND_ATTEMPTS } from "../src/lib/background-store.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-bg-")); dirs.push(d); return join(d, "bg.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("BackgroundStore (background-errand-persist)", () => {
  it("adds, lists, removes, persists", () => {
    const f = tmp();
    const s = new BackgroundStore({ file: f });
    const id = s.add(5, "find the cheapest flights", NOW);
    expect(s.size()).toBe(1);
    expect(s.list()[0]).toMatchObject({ chatId: 5, text: "find the cheapest flights" });
    // survives a reload (a "crash")
    const reload = new BackgroundStore({ file: f });
    expect(reload.list()[0]!.id).toBe(id);
    reload.remove(id);
    expect(reload.size()).toBe(0);
    expect(new BackgroundStore({ file: f }).size()).toBe(0); // persisted
  });
  it("add stamps attempts=1; reinstate bumps it in place (poison guard)", () => {
    const s = new BackgroundStore({ file: tmp() });
    const id = s.add(1, "a", NOW);
    expect(s.list()[0]!.attempts).toBe(1);
    const e = s.list()[0]!;
    expect(s.reinstate(e, NOW + 1)).toBe(2); // bumped
    expect(s.list()[0]!.attempts).toBe(2);
    expect(s.list()[0]!.id).toBe(id);        // same record, not a duplicate
    expect(s.size()).toBe(1);
  });
  it("ids are unique across adds", () => {
    const s = new BackgroundStore({ file: tmp() });
    expect(s.add(1, "a", NOW)).not.toBe(s.add(1, "b", NOW));
  });
});

describe("planErrandReplay", () => {
  it("replays a fresh errand, notes a stale one", () => {
    const errands = [
      { id: "1", chatId: 5, text: "fresh task", startedAt: NOW - 60_000 },        // 1 min ago
      { id: "2", chatId: 6, text: "old task", startedAt: NOW - STALE_ERRAND_MS - 1 }, // just over the cap
    ];
    const plan = planErrandReplay(errands, NOW);
    expect(plan[0]!.replay).toBe(true);
    expect(plan[0]!.notice).toMatch(/restarted while working on "fresh task"/i);
    expect(plan[1]!.replay).toBe(false);
    expect(plan[1]!.notice).toMatch(/got interrupted before finishing/i);
    expect(plan[1]!.notice).toMatch(/old task/);
  });
  it("stops replaying a poison errand after MAX_ERRAND_ATTEMPTS (crash-loop guard)", () => {
    const poison = [{ id: "p", chatId: 5, text: "crashy task", startedAt: NOW, attempts: MAX_ERRAND_ATTEMPTS }];
    const plan = planErrandReplay(poison, NOW);
    expect(plan[0]!.replay).toBe(false);
    expect(plan[0]!.notice).toMatch(/kept crashing/i);
  });
});
