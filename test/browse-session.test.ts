import { describe, it, expect } from "vitest";
import { BrowseSessionStore, browseContinuityEnabled, BROWSE_IDLE_MS, isCloseSessionRequest } from "../src/lib/browse-session.js";

describe("isCloseSessionRequest (session-status-surface)", () => {
  it("matches whole-message close asks", () => {
    for (const t of ["done", "I'm done", "close the page", "close it", "stop browsing", "nevermind", "nvm", "drop it", "that's all"]) {
      expect(isCloseSessionRequest(t)).toBe(true);
    }
  });
  it("does NOT match a real task that merely contains a close word", () => {
    for (const t of ["close my activity rings", "are you done?", "close reading on the topic", "stop the btc watch", "done with the flights, now book one"]) {
      expect(isCloseSessionRequest(t)).toBe(false);
    }
  });
});

describe("browseContinuityEnabled", () => {
  it("is OFF by default and on only for truthy flags", () => {
    expect(browseContinuityEnabled(undefined)).toBe(false);
    expect(browseContinuityEnabled("")).toBe(false);
    expect(browseContinuityEnabled("0")).toBe(false);
    for (const v of ["1", "true", "yes", "on", "ON", "Yes"]) expect(browseContinuityEnabled(v)).toBe(true);
  });
});

describe("BrowseSessionStore (persist-browse-session-across-turns)", () => {
  const mk = (idleMs = 1000) => {
    const released: string[] = [];
    let now = 1000;
    const store = new BrowseSessionStore((sid) => { released.push(sid); }, () => now, idleMs);
    return { store, released, at: (t: number) => { now = t; }, get now() { return now; } };
  };

  it("carries a session and returns it while fresh", () => {
    const h = mk();
    h.store.set(1, "sess-a");
    expect(h.store.get(1)).toBe("sess-a");
    expect(h.released).toEqual([]);
  });

  it("reaps + releases an idle session on get past the TTL", () => {
    const h = mk(1000);
    h.store.set(1, "sess-a");     // stamped at now=1000
    h.at(2500);                    // 1500ms later > 1000 TTL
    expect(h.store.get(1)).toBeUndefined();
    expect(h.released).toEqual(["sess-a"]);
  });

  it("replacing a chat's session releases the old one (one tab per chat)", () => {
    const h = mk();
    h.store.set(1, "sess-a");
    h.store.set(1, "sess-b");
    expect(h.released).toEqual(["sess-a"]);
    expect(h.store.get(1)).toBe("sess-b");
  });

  it("re-setting the SAME id just refreshes activity (no release, stays alive)", () => {
    const h = mk(1000);
    h.store.set(1, "sess-a");     // t=1000
    h.at(1800); h.store.set(1, "sess-a"); // refresh at t=1800
    h.at(2500);                    // 700ms after refresh < 1000 TTL
    expect(h.store.get(1)).toBe("sess-a");
    expect(h.released).toEqual([]);
  });

  it("drop releases + forgets a chat's session", () => {
    const h = mk();
    h.store.set(1, "sess-a");
    h.store.drop(1);
    expect(h.released).toEqual(["sess-a"]);
    expect(h.store.get(1)).toBeUndefined();
    h.store.drop(1); // no-op second time
    expect(h.released).toEqual(["sess-a"]);
  });

  it("a set for one chat opportunistically reaps OTHER chats' idle sessions", () => {
    const h = mk(1000);
    h.store.set(1, "sess-a");     // t=1000
    h.at(3000);                    // chat 1 now idle (2000ms > 1000)
    h.store.set(2, "sess-b");     // touching chat 2 reaps chat 1
    expect(h.released).toEqual(["sess-a"]);
    expect(h.store.size()).toBe(1);
    expect(h.store.get(2)).toBe("sess-b");
  });

  it("default idle window is a few minutes, env-clamped to >=30s", () => {
    expect(BROWSE_IDLE_MS).toBeGreaterThanOrEqual(30_000);
  });
});
