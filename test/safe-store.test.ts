import { describe, it, expect, afterEach } from "vitest";
import { atomicWriteJson, readJsonSafe, setPersistErrorHandler, setCorruptHandler } from "../src/lib/safe-store.js";
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
  it("fsyncs the contents before rename (durable overwrite; safe-store-no-fsync)", () => {
    // Not directly observable without a crash, but the openSync/writeSync/fsyncSync/rename path must
    // still produce a correct, complete file + overwrite an existing one atomically (no torn state).
    const f = join(tmp(), "s.json");
    expect(atomicWriteJson(f, { n: 1, big: "x".repeat(5000) })).toBe(true);
    expect(readJsonSafe<{ n: number; big: string }>(f)!.n).toBe(1);
    expect(atomicWriteJson(f, { n: 2 })).toBe(true);        // overwrite
    const got = readJsonSafe<{ n: number; big?: string }>(f)!;
    expect(got.n).toBe(2);
    expect(got.big).toBeUndefined();                        // fully replaced, not appended/torn
    expect(existsSync(`${f}.tmp`)).toBe(false);
  });
  it("never throws on an unwritable path", () => {
    // a path whose parent is a FILE (not a dir) can't be written; must swallow, not throw
    const d = tmp();
    const asFile = join(d, "afile");
    writeFileSync(asFile, "x");
    expect(() => atomicWriteJson(join(asFile, "cant.json"), { x: 1 })).not.toThrow();
  });
  it("returns true on success, false on failure (lists-remove-atomic-write-failure)", () => {
    const f = join(tmp(), "s.json");
    expect(atomicWriteJson(f, { ok: true })).toBe(true);
    // parent is a file -> write fails -> false, not a thrown error, not a silent true
    const asFile = join(tmp(), "afile");
    writeFileSync(asFile, "x");
    expect(atomicWriteJson(join(asFile, "cant.json"), { x: 1 })).toBe(false);
  });
  it("reports a write failure to the persist-error sink (observability)", () => {
    const seen: string[] = [];
    const prev = setPersistErrorHandler((file) => { seen.push(file); });
    try {
      const asFile = join(tmp(), "afile");
      writeFileSync(asFile, "x");
      const bad = join(asFile, "cant.json");
      atomicWriteJson(bad, { x: 1 });
      expect(seen).toContain(bad);
    } finally {
      setPersistErrorHandler(prev); // restore so other tests aren't affected
    }
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
  it("reports a corruption to the corrupt sink with the backup path (corrupt-store-silent-wipe)", () => {
    const seen: Array<{ file: string; backup: string | null }> = [];
    const prev = setCorruptHandler((file, backup) => seen.push({ file, backup }));
    try {
      const f = join(tmp(), "s.json");
      writeFileSync(f, "{ not json");
      readJsonSafe(f);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.file).toBe(f);
      expect(seen[0]!.backup).toBe(`${f}.corrupt`);
    } finally { setCorruptHandler(prev); }
  });
  it("does NOT call the corrupt sink for a missing or valid file", () => {
    let calls = 0;
    const prev = setCorruptHandler(() => { calls++; });
    try {
      readJsonSafe(join(tmp(), "none.json"));           // missing
      const f = join(tmp(), "ok.json"); writeFileSync(f, "{}"); readJsonSafe(f); // valid
      expect(calls).toBe(0);
    } finally { setCorruptHandler(prev); }
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
