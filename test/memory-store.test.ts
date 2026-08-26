import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../src/lib/memory-store.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Each test gets its own temp file so runs don't cross-contaminate.
const dirs: string[] = [];
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), "relay-mem-"));
  dirs.push(d);
  return join(d, "mem.json");
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("MemoryStore persistence", () => {
  it("survives a reload — the whole point (bot keeps context across restart)", () => {
    const file = tmpFile();
    const a = new MemoryStore({ file });
    a.set(42, [{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }]);
    // Simulate a restart: a brand-new store reading the same file.
    const b = new MemoryStore({ file });
    expect(b.get(42)).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }]);
  });

  it("returns [] for an unknown chat", () => {
    const s = new MemoryStore({ file: tmpFile() });
    expect(s.get(999)).toEqual([]);
  });

  it("trims each chat to maxTurns", () => {
    const file = tmpFile();
    const s = new MemoryStore({ file, maxTurns: 4 });
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `m${i}` }));
    s.set(1, msgs);
    const got = s.get(1) as { content: string }[];
    expect(got.length).toBe(4);
    expect(got[0].content).toBe("m6"); // kept the last 4
    expect(got[3].content).toBe("m9");
  });

  it("evicts the least-recently-updated chat past maxChats", () => {
    const file = tmpFile();
    const s = new MemoryStore({ file, maxChats: 2 });
    s.set(1, [{ content: "a" }], 1000);
    s.set(2, [{ content: "b" }], 2000);
    s.set(3, [{ content: "c" }], 3000); // exceeds cap -> chat 1 (oldest) evicted
    expect(s.size()).toBe(2);
    expect(s.get(1)).toEqual([]);       // gone
    expect(s.get(3)).toEqual([{ content: "c" }]);
  });

  it("eviction persists across a restart (evicted chat stays gone, survivors reload)", () => {
    const file = tmpFile();
    const a = new MemoryStore({ file, maxChats: 2 });
    a.set(1, [{ content: "a" }], 1000);
    a.set(2, [{ content: "b" }], 2000);
    a.set(3, [{ content: "c" }], 3000); // chat 1 evicted before persist
    // New instance on the same file: the evicted chat must not resurrect; survivors load.
    const b = new MemoryStore({ file, maxChats: 2 });
    expect(b.size()).toBe(2);
    expect(b.get(1)).toEqual([]);
    expect(b.get(2)).toEqual([{ content: "b" }]);
    expect(b.get(3)).toEqual([{ content: "c" }]);
  });

  it("the updated timestamp survives reload, so LRU ordering is correct post-restart", () => {
    const file = tmpFile();
    const a = new MemoryStore({ file, maxChats: 2 });
    a.set(1, [{ content: "old" }], 1000);
    a.set(2, [{ content: "mid" }], 2000);
    // Restart, then add a 3rd chat newer than both. Chat 1 (oldest, ts persisted) must evict.
    const b = new MemoryStore({ file, maxChats: 2 });
    b.set(3, [{ content: "new" }], 3000);
    expect(b.get(1)).toEqual([]);                     // oldest evicted using the RELOADED timestamp
    expect(b.get(2)).toEqual([{ content: "mid" }]);
    expect(b.get(3)).toEqual([{ content: "new" }]);
  });

  it("persists an empty-history set (explicit clear survives restart)", () => {
    const file = tmpFile();
    const a = new MemoryStore({ file });
    a.set(7, [{ content: "x" }]);
    a.set(7, []); // clear
    const b = new MemoryStore({ file });
    expect(b.get(7)).toEqual([]);
  });

  it("a corrupt file loads as empty, never throws (bad file must not crash the bot)", () => {
    const file = tmpFile();
    writeFileSync(file, "{not valid json", "utf8");
    const s = new MemoryStore({ file });   // must not throw
    expect(s.get(1)).toEqual([]);
    // and it recovers — a set persists valid JSON over the garbage
    s.set(1, [{ content: "ok" }]);
    const b = new MemoryStore({ file });
    expect(b.get(1)).toEqual([{ content: "ok" }]);
  });

  it("missing file is fine (first boot)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "relay-mem-")), "nope.json");
    expect(existsSync(file)).toBe(false);
    const s = new MemoryStore({ file }); // no throw
    expect(s.size()).toBe(0);
  });

  it("delete(chatId) clears one chat, persists, and survives reload (DEV-0023 /reset)", () => {
    const file = tmpFile();
    const a = new MemoryStore({ file });
    a.set(1, [{ content: "keep" }]);
    a.set(2, [{ content: "drop" }]);
    expect(a.delete(2)).toBe(true);   // had something
    expect(a.get(2)).toEqual([]);
    expect(a.get(1)).toEqual([{ content: "keep" }]); // other chat untouched
    // persisted: a fresh store from the same file still has 1 and not 2
    const b = new MemoryStore({ file });
    expect(b.get(1)).toEqual([{ content: "keep" }]);
    expect(b.get(2)).toEqual([]);
  });

  it("delete of an unknown chat returns false (no-op)", () => {
    const s = new MemoryStore({ file: tmpFile() });
    expect(s.delete(12345)).toBe(false);
  });
});
