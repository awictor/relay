import { describe, it, expect, afterEach } from "vitest";
import { readJar, cookiesForHost, redactCookieValues, jarHosts, loadCookieJar, _resetCookieJarCache } from "../src/lib/cookie-jar.js";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dirs: string[] = [];
function tmpJar(content: string) {
  const d = mkdtempSync(join(tmpdir(), "relay-cj-")); dirs.push(d);
  const f = join(d, "cookies.json"); writeFileSync(f, content); return f;
}
afterEach(() => { _resetCookieJarCache(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("loadCookieJar cache contract (DEV-0195)", () => {
  it("loads the jar from the given file", () => {
    const f = tmpJar(JSON.stringify({ cookies: [{ name: "sid", value: "abc123", domain: "example.com" }] }));
    const jar = loadCookieJar(f);
    expect(jar).toHaveLength(1);
    expect(jar[0]!.name).toBe("sid");
  });

  it("a second call is CACHED — a rewrite of the file is NOT seen until reset (first-load-sticky)", () => {
    const f = tmpJar(JSON.stringify({ cookies: [{ name: "one", value: "v1", domain: "a.com" }] }));
    expect(loadCookieJar(f)).toHaveLength(1);
    // rewrite the file with a different jar; the cached load must still win
    writeFileSync(f, JSON.stringify({ cookies: [{ name: "two", value: "v2", domain: "b.com" }, { name: "three", value: "v3", domain: "c.com" }] }));
    const again = loadCookieJar(f);
    expect(again).toHaveLength(1);            // still the FIRST load
    expect(again[0]!.name).toBe("one");
  });

  it("_resetCookieJarCache forces a fresh load reflecting the new file", () => {
    const f = tmpJar(JSON.stringify({ cookies: [{ name: "one", value: "v1", domain: "a.com" }] }));
    loadCookieJar(f);
    writeFileSync(f, JSON.stringify({ cookies: [{ name: "two", value: "v2", domain: "b.com" }, { name: "three", value: "v3", domain: "c.com" }] }));
    _resetCookieJarCache();
    const fresh = loadCookieJar(f);
    expect(fresh).toHaveLength(2);            // re-read after reset
    expect(fresh.map((c) => c.name).sort()).toEqual(["three", "two"]);
  });

  it("a missing/corrupt file yields [] and caches [] (never throws)", () => {
    const missing = join(tmpdir(), "relay-cj-does-not-exist", "nope.json");
    expect(loadCookieJar(missing)).toEqual([]);
    // still [] on a second call (cached), and reset lets a real file load next
    expect(loadCookieJar(missing)).toEqual([]);
    _resetCookieJarCache();
    const f = tmpJar(JSON.stringify({ cookies: [{ name: "sid", value: "abc", domain: "x.com" }] }));
    expect(loadCookieJar(f)).toHaveLength(1);
  });
});

describe("readJar", () => {
  it("reads valid {cookies:[]} with the required fields", () => {
    const f = tmpJar(JSON.stringify({ cookies: [{ name: "sid", value: "abc", domain: "example.com" }] }));
    expect(readJar(f)).toHaveLength(1);
  });
  it("drops entries missing name/value/domain", () => {
    const f = tmpJar(JSON.stringify({ cookies: [{ name: "x", value: "y", domain: "e.com" }, { name: "bad" }] }));
    expect(readJar(f)).toHaveLength(1);
  });
  it("returns [] for absent / corrupt / unset", () => {
    expect(readJar(undefined)).toEqual([]);
    expect(readJar(join(tmpdir(), "nope-relay.json"))).toEqual([]);
    const bad = tmpJar("{not json"); expect(readJar(bad)).toEqual([]);
  });
});

describe("cookiesForHost (host-scoped selection)", () => {
  const jar = [
    { name: "sid", value: "aaaa", domain: "example.com" },
    { name: "evil", value: "bbbb", domain: "evil.com" },
    { name: "sub", value: "cccc", domain: ".example.com" },
  ];
  it("returns only cookies whose domain matches the host", () => {
    expect(cookiesForHost("example.com", jar).map((c) => c.name).sort()).toEqual(["sid", "sub"]);
  });
  it("returns nothing for an unrelated host", () => {
    expect(cookiesForHost("other.com", jar)).toEqual([]);
  });
});

describe("jarHosts (m30 — names only, never values)", () => {
  const jar = [
    { name: "sid", value: "aaaa", domain: "example.com" },
    { name: "x", value: "bbbb", domain: ".example.com" },   // dedupes with example.com
    { name: "y", value: "cccc", domain: "another.io" },
  ];
  it("returns distinct sorted hosts, leading dot stripped", () => {
    expect(jarHosts(jar)).toEqual(["another.io", "example.com"]);
  });
  it("never includes a cookie value", () => {
    const out = jarHosts(jar).join(" ");
    for (const c of jar) expect(out).not.toContain(c.value);
  });
  it("empty jar -> []", () => {
    expect(jarHosts([])).toEqual([]);
  });
});

describe("redactCookieValues", () => {
  const jar = [{ name: "sid", value: "supersecretvalue", domain: "example.com" }];
  it("masks a cookie value that appears in text", () => {
    const out = redactCookieValues("debug: cookie=supersecretvalue end", jar);
    expect(out).not.toContain("supersecretvalue");
    expect(out).toContain("[redacted-cookie]");
  });
  it("leaves text without cookie values untouched", () => {
    expect(redactCookieValues("nothing sensitive here", jar)).toBe("nothing sensitive here");
  });
  it("ignores very short values (avoids masking common substrings)", () => {
    const shortJar = [{ name: "x", value: "ab", domain: "e.com" }];
    expect(redactCookieValues("abracadabra", shortJar)).toBe("abracadabra");
  });
});
