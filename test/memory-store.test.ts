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
});
