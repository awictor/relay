import { describe, it, expect, afterEach } from "vitest";
import { atomicWriteJson, readJsonSafe } from "../src/lib/safe-store.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-ss-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("atomicWriteJson", () => {
  it("writes JSON and round-trips via readJsonSafe", () => {
    const f = join(tmp(), "s.json");
    atomicWriteJson(f, { v: 1, items: [{ id: "a" }] });
    expect(readJsonSafe<{ items: unknown[] }>(f)!.items).toHaveLength(1);
  });
  it("creates the parent dir if absent", () => {
    const f = join(tmp(), "nested", "deep", "s.json");
    atomicWriteJson(f, { ok: true });
    expect(existsSync(f)).toBe(true);
  });
  it("leaves no .tmp behind on success", () => {
    const f = join(tmp(), "s.json");
    atomicWriteJson(f, { ok: true });
    expect(existsSync(`${f}.tmp`)).toBe(false);
  });
  it("never throws on an unwritable path", () => {
    // a path whose parent is a FILE (not a dir) can't be written; must swallow, not throw
    const d = tmp();
    const asFile = join(d, "afile");
    writeFileSync(asFile, "x");
    expect(() => atomicWriteJson(join(asFile, "cant.json"), { x: 1 })).not.toThrow();
  });
});

describe("readJsonSafe", () => {
  it("returns null for a missing file (fresh start)", () => {
    expect(readJsonSafe(join(tmp(), "none.json"))).toBeNull();
  });
  it("backs a CORRUPT file aside to .corrupt and returns null (no silent wipe)", () => {
    const f = join(tmp(), "s.json");
    writeFileSync(f, "{ this is not json");
    expect(readJsonSafe(f)).toBeNull();
    expect(existsSync(`${f}.corrupt`)).toBe(true);          // data preserved for recovery
    expect(readFileSync(`${f}.corrupt`, "utf8")).toContain("not json");
    expect(existsSync(f)).toBe(false);                       // moved aside, not left to re-fail
  });
  it("reads valid JSON", () => {
    const f = join(tmp(), "s.json");
    writeFileSync(f, JSON.stringify({ hello: "world" }));
    expect(readJsonSafe<{ hello: string }>(f)!.hello).toBe("world");
  });
});

describe("crash-mid-write is survivable (atomic contract)", () => {
  it("a torn .tmp never becomes the live file; the previous good file stays readable", () => {
    const f = join(tmp(), "s.json");
    atomicWriteJson(f, { v: 1, items: ["good"] });
    // Simulate a crash that left a half-written temp: it exists but was never renamed.
    writeFileSync(`${f}.tmp`, "{ truncated");
    // The live file is still the last good one — readers never saw the torn temp.
    expect(readJsonSafe<{ items: string[] }>(f)!.items).toEqual(["good"]);
  });
});
