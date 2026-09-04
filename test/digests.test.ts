import { describe, it, expect, afterEach } from "vitest";
import { parseDigestCommand, DigestStore } from "../src/lib/digests.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
function tmpFile() { const d = mkdtempSync(join(tmpdir(), "relay-digest-")); dirs.push(d); return join(d, "d.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("parseDigestCommand", () => {
  it("parses 'define digest <name>: a, b, c'", () => {
    expect(parseDigestCommand("define digest morning: weather, hn, btc")).toEqual({ name: "morning", members: ["weather", "hn", "btc"] });
  });
  it("parses 'digest <name>: a, b' and normalizes", () => {
    expect(parseDigestCommand("digest Morning Brief: Weather , BTC")).toEqual({ name: "morning brief", members: ["weather", "btc"] });
  });
  it("null without members or colon", () => {
    expect(parseDigestCommand("digest morning:")).toBeNull();
    expect(parseDigestCommand("what's the weather")).toBeNull();
  });
  it("strips a trailing courtesy so the LAST member isn't silently dropped (courtesy-tail)", () => {
    // "hn please" matches no recipe -> the member would vanish from the digest without warning.
    expect(parseDigestCommand("digest morning: weather, hn please")).toEqual({ name: "morning", members: ["weather", "hn"] });
    expect(parseDigestCommand("define digest evening: btc, news thanks")).toEqual({ name: "evening", members: ["btc", "news"] });
  });
});

describe("DigestStore", () => {
  it("add/get/list/remove; members capped", () => {
    const s = new DigestStore({ file: tmpFile(), maxMembers: 2 });
    const rec = s.add(1, { name: "morning", members: ["a", "b", "c"] }, NOW)!;
    expect(rec.members).toEqual(["a", "b"]); // capped to 2
    expect(s.lastDroppedForCap()).toEqual(["c"]); // the over-cap member is reported, not silently dropped
    expect(s.get(1, "MORNING")!.name).toBe("morning"); // case-insensitive
    expect(s.list(1)).toHaveLength(1);
    expect(s.remove(1, "morning")).toBe(true);
    expect(s.get(1, "morning")).toBeUndefined();
  });

  it("DEV-0194: dedups repeated members (order-preserving), cap applies after dedup", () => {
    const s = new DigestStore({ file: tmpFile(), maxMembers: 10 });
    const rec = s.add(1, { name: "m", members: ["hn", "hn", "btc", "hn"] }, NOW)!;
    expect(rec.members).toEqual(["hn", "btc"]); // dup 'hn' collapsed to first, order kept
    // cap applies to the DEDUPED list: 3 distinct capped to 2, not 4-raw capped to 2
    const s2 = new DigestStore({ file: tmpFile(), maxMembers: 2 });
    expect(s2.add(1, { name: "m", members: ["a", "a", "b", "c"] }, NOW)!.members).toEqual(["a", "b"]);
  });

  it("update-in-place by name (no dupe), cap-exempt", () => {
    const s = new DigestStore({ file: tmpFile(), maxPerChat: 1 });
    s.add(1, { name: "m", members: ["a"] }, NOW);
    expect(s.add(1, { name: "n", members: ["b"] }, NOW)).toBeNull(); // capped
    expect(s.add(1, { name: "m", members: ["a", "b"] }, NOW)).toBeTruthy(); // update exempt
    expect(s.get(1, "m")!.members).toEqual(["a", "b"]);
    expect(s.list(1)).toHaveLength(1);
  });

  it("persists across reload (incl. schedule)", () => {
    const file = tmpFile();
    new DigestStore({ file }).add(7, { name: "m", members: ["a"], schedule: "every morning" }, NOW);
    const b = new DigestStore({ file });
    expect(b.get(7, "m")!.members).toEqual(["a"]);
    expect(b.get(7, "m")!.schedule).toBe("every morning");
  });
});
