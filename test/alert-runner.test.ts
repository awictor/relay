import { describe, it, expect } from "vitest";
import { checkAlert } from "../src/alert-runner.js";
import type { Alert } from "../src/lib/alerts.js";
import { feedItemKey as normKey } from "../src/lib/alerts.js";

const NOW = 1_700_000_000_000;
const alert = (over: Partial<Alert> = {}): Alert => ({ chatId: 1, name: "btc", task: "price", created: NOW, ...over });

function deps(reply: string, over: Partial<Parameters<typeof checkAlert>[1]> = {}) {
  const lastSet: Array<{ name: string; value: string }> = [];
  return {
    d: {
      llm: {} as never,
      runAgent: async () => ({ reply }),
      formatReply: (t: string) => t,
      setLast: (_c: number, name: string, value: string) => lastSet.push({ name, value }),
      ...over,
    },
    lastSet,
  };
}

describe("checkAlert", () => {
  it("first run notifies (baseline) and seeds lastValue", async () => {
    const { d, lastSet } = deps("$65,000");
    const r = await checkAlert(alert(), d); // no lastValue
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/btc \(watching\)/);
    expect(lastSet).toEqual([]);        // baseline advance is DEFERRED to commit (post-send)
    r.commit();
    expect(lastSet).toEqual([{ name: "btc", value: "$65,000" }]);
  });

  it("DEV-0176: a degraded reply does NOT notify + does NOT overwrite lastValue (no spam)", async () => {
    const { d, lastSet } = deps("I ran out of steps before finishing. Try narrowing the request.", {
      runAgent: async () => ({ reply: "I ran out of steps before finishing.", degraded: true }),
    });
    const r = await checkAlert(alert({ lastValue: "$65,000" }), d);
    expect(r.notify).toBe(false);            // the failure text is NOT reported as a change
    expect(r.value).toBe("$65,000");         // lastValue preserved
    expect(lastSet).toEqual([]);             // setLast NOT called with the degraded value
  });

  it("unchanged value -> silent (no notify), keeps the baseline (does NOT re-seed lastValue)", async () => {
    const { d, lastSet } = deps("sunny");
    const r = await checkAlert(alert({ lastValue: "sunny" }), d);
    expect(r.notify).toBe(false);
    expect(r.message).toBeNull();
    expect(lastSet).toEqual([]); // baseline only advances when we notify (alert-baseline-ratchet)
  });

  it("threshold: cumulative sub-threshold drift eventually fires (baseline is last-NOTIFIED, not last-observed)", async () => {
    // 65000 -> 65600 -> 66200, threshold 1000. Each step < 1000, but the baseline must stay 65000
    // (last notified) so the cumulative +1200 move fires. The old bug re-seeded lastValue each check,
    // so the baseline chased the price and the move was never seen.
    const s1 = deps("$65,600");
    const c1 = await checkAlert(alert({ lastValue: "$65,000", threshold: 1000 }), s1.d);
    expect(c1.notify).toBe(false);
    expect(s1.lastSet).toEqual([]); // did NOT advance the baseline
    const s2 = deps("$66,200");
    const c2 = await checkAlert(alert({ lastValue: "$65,000", threshold: 1000 }), s2.d); // still vs 65000
    expect(c2.notify).toBe(true);  // +1200 >= 1000
    expect(s2.lastSet).toEqual([]);          // deferred to commit (post-send)
    c2.commit();
    expect(s2.lastSet).toEqual([{ name: "btc", value: "$66,200" }]); // advances only after send
  });

  it("a numeric-threshold watch stays silent + keeps baseline on a numberless reply (threshold-alert-numberless-guard)", async () => {
    // "by 1000" watch, last $65,000; a transient "price unavailable" has no number -> must NOT fire
    // (text-diff would) and must NOT overwrite the baseline (poisoning it bypasses the threshold).
    const { d, lastSet } = deps("Price temporarily unavailable");
    const r = await checkAlert(alert({ lastValue: "$65,000", threshold: 1000 }), d);
    expect(r.notify).toBe(false);
    expect(lastSet).toEqual([]);
    expect(r.value).toBe("$65,000");
    // next real check still measured vs the preserved 65000
    const again = await checkAlert(alert({ lastValue: "$65,000", threshold: 1000 }), deps("$65,200").d);
    expect(again.notify).toBe(false); // +200 < 1000
  });

  it("a PLAIN change-alert (no threshold) stays silent + keeps baseline on a numberless reply (alert-numberless-flap)", async () => {
    // Last was a number ($65,000); a transient "price unavailable" has none. Text-diff would false-ping
    // '🔔 changed' and store the garbage. Must stay silent + keep the last GOOD value.
    const { d, lastSet } = deps("Price temporarily unavailable");
    const r = await checkAlert(alert({ lastValue: "$65,000" }), d); // NO threshold
    expect(r.notify).toBe(false);
    expect(lastSet).toEqual([]);          // baseline NOT poisoned
    expect(r.value).toBe("$65,000");      // last GOOD value preserved
  });

  it("a genuinely non-numeric watch is unaffected by the numberless guard (top HN story)", async () => {
    // lastValue has no number, so the guard doesn't trigger; a real content change still fires.
    const { d } = deps("The top story is a new AI model launch");
    const r = await checkAlert(alert({ task: "top HN story", lastValue: "The top story is a merger" }), d);
    expect(r.notify).toBe(true);          // real change fires
  });

  it("first run with no number still seeds (nothing to protect yet)", async () => {
    const { d, lastSet } = deps("Price unavailable");
    const r = await checkAlert(alert({ threshold: 1000 }), d); // no lastValue
    expect(r.notify).toBe(true); // first run notifies (baseline)
    r.commit();
    expect(lastSet).toEqual([{ name: "btc", value: "Price unavailable" }]);
  });

  it("a notify's baseline advance is DEFERRED until commit (alert-notify-send-fail)", async () => {
    // A change fires but the baseline must NOT advance until the caller commits post-send — so a
    // failed send leaves the old baseline + the crossing re-fires next check instead of being eaten.
    const { d, lastSet } = deps("$67,000");
    const r = await checkAlert(alert({ lastValue: "$65,000", threshold: 1000 }), d);
    expect(r.notify).toBe(true);
    expect(lastSet).toEqual([]);   // NOT advanced yet — a send failure here would re-fire next check
    r.commit();                    // caller commits only after a successful send
    expect(lastSet).toEqual([{ name: "btc", value: "$67,000" }]);
  });

  it("changed value -> notify with a 'changed' message", async () => {
    const { d } = deps("rainy");
    const r = await checkAlert(alert({ lastValue: "sunny" }), d);
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/btc changed/);
    expect(r.message).toMatch(/rainy/);
  });

  it("a numeric change shows was->now + delta + direction (alert-delta-in-ping)", async () => {
    const r = await checkAlert(alert({ lastValue: "$65,000", threshold: 1000 }), deps("$67,000").d);
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/was \$65,000/);
    expect(r.message).toMatch(/now \$67,000/);
    expect(r.message).toMatch(/↑2000/); // +2000 up
  });
  it("a down move shows the down arrow", async () => {
    const r = await checkAlert(alert({ lastValue: "$67,000", threshold: 1000 }), deps("$65,000").d);
    expect(r.message).toMatch(/↓2000/);
  });
  it("delta still renders when setLast MUTATES the alert in place (real-store semantics — regression)", async () => {
    // The production store's setLast writes a.lastValue = value on the SAME object checkAlert holds.
    // If the delta read alert.lastValue AFTER setLast it would see the new value (pv===nv, no delta).
    // This mock mirrors that mutation to prove the fix snapshots prevValue before setLast.
    const a = alert({ lastValue: "$65,000", threshold: 1000 });
    const r = await checkAlert(a, deps("$67,000", {
      setLast: (_c: number, _n: string, value: string) => { a.lastValue = value; },
    }).d);
    expect(r.message).toMatch(/was \$65,000 → now \$67,000/);
    expect(r.message).toMatch(/↑2000/);
  });
  it("a non-numeric change stays plain (no delta line)", async () => {
    const r = await checkAlert(alert({ lastValue: "sunny" }), deps("rainy").d);
    expect(r.message).not.toMatch(/was |→|↑|↓/);
  });
  it("first run has no delta line (nothing to compare)", async () => {
    const r = await checkAlert(alert({ threshold: 1000 }), deps("$65,000").d); // no lastValue
    expect(r.notify).toBe(true);
    expect(r.message).not.toMatch(/was |→/);
  });

  it("threshold: small numeric move is silent, big move notifies", async () => {
    const small = await checkAlert(alert({ lastValue: "$65,000", threshold: 1000 }), deps("$65,200").d);
    expect(small.notify).toBe(false);
    const big = await checkAlert(alert({ lastValue: "$65,000", threshold: 1000 }), deps("$67,000").d);
    expect(big.notify).toBe(true);
  });

  describe("predicate alerts (below/above/in_stock) — edge-triggered", () => {
    const below = { op: "below" as const, operand: 50000 };
    it("fires once when the value FIRST drops below, not while it stays below", async () => {
      // was above -> now below: fire
      const cross = await checkAlert(alert({ lastValue: "$52,000", condition: below }), deps("$48,000").d);
      expect(cross.notify).toBe(true);
      expect(cross.message).toMatch(/btc/);
      // already below, still below: silent (no repeat spam)
      const still = await checkAlert(alert({ lastValue: "$49,000", condition: below }), deps("$48,000").d);
      expect(still.notify).toBe(false);
    });
    it("stays silent while above the threshold", async () => {
      const r = await checkAlert(alert({ lastValue: "$52,000", condition: below }), deps("$51,000").d);
      expect(r.notify).toBe(false);
    });
    it("first run already-true: fires immediately (the condition holds now — tell the user)", async () => {
      const r = await checkAlert(alert({ condition: below }), deps("$48,000").d); // no lastValue, already below
      expect(r.notify).toBe(true);
    });
    it("first run not-yet-true: silent (seeds, waits for the crossing)", async () => {
      const r = await checkAlert(alert({ condition: below }), deps("$52,000").d);
      expect(r.notify).toBe(false);
    });
    it("in_stock fires on out-of-stock -> in-stock transition", async () => {
      const cond = { op: "in_stock" as const };
      const r = await checkAlert(alert({ lastValue: "Sold out", condition: cond }), deps("In stock — add to cart").d);
      expect(r.notify).toBe(true);
    });
    it("a numberless (indeterminate) reply keeps the baseline + doesn't re-fire (predicate-refire-guard)", async () => {
      // Already below (lastValue $48,000). A transient "price unavailable" is real but has no number,
      // so conditionHolds is null. It must NOT be stored (else next check prevHolds=null re-fires) and
      // must stay silent this tick.
      const { d, lastSet } = deps("Price temporarily unavailable");
      const r = await checkAlert(alert({ lastValue: "$48,000", condition: below }), d);
      expect(r.notify).toBe(false);
      expect(lastSet).toEqual([]);        // baseline NOT overwritten with the numberless value
      expect(r.value).toBe("$48,000");    // last GOOD value preserved
      // next real check, still below -> stays silent (no spurious re-cross)
      const again = await checkAlert(alert({ lastValue: "$48,000", condition: below }), deps("$47,500").d);
      expect(again.notify).toBe(false);
    });
  });

  it("an agent failure -> no notify, no spam, value left as-is", async () => {
    const { d } = deps("ignored", { runAgent: async () => { throw new Error("boom"); } });
    const r = await checkAlert(alert({ lastValue: "prev" }), d);
    expect(r.notify).toBe(false);
    expect(r.value).toBe("prev");
  });
});

describe("checkAlert — feed-watch (new-item-feed-watch)", () => {
  function feedDeps(reply: string) {
    const lastSet: Array<{ name: string; value: string }> = [];
    const seenRec: Array<{ name: string; keys: string[] }> = [];
    return {
      d: {
        llm: {} as never,
        runAgent: async () => ({ reply }),
        formatReply: (t: string) => t,
        setLast: (_c: number, name: string, value: string) => lastSet.push({ name, value }),
        recordSeen: (_c: number, name: string, keys: string[]) => seenRec.push({ name, keys }),
      },
      lastSet, seenRec,
    };
  }

  it("first run seeds the whole list SILENTLY (no dump of current items as new)", async () => {
    const { d, seenRec } = feedDeps("• Job A\n• Job B\n• Job C");
    const r = await checkAlert(alert({ feed: true }), d); // seen undefined
    expect(r.notify).toBe(false);
    expect(seenRec).toHaveLength(1);
    expect(seenRec[0]!.keys).toHaveLength(3); // all three recorded as seen
  });

  it("notifies ONLY about a genuinely-new item; commit records it", async () => {
    const { d, seenRec } = feedDeps("• Job A\n• Job B\n• Job NEW");
    // seen already has A and B (by their normalized keys)
    const a = alert({ feed: true, seen: [normKey("Job A"), normKey("Job B")] });
    const r = await checkAlert(a, d);
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/1 new/);
    expect(r.message).toMatch(/Job NEW/);
    expect(r.message).not.toMatch(/Job A/); // only the new one
    expect(seenRec).toHaveLength(0);        // NOT recorded until commit (post-send)
    r.commit();
    expect(seenRec).toHaveLength(1);
    expect(seenRec[0]!.keys).toEqual([normKey("Job NEW")]);
  });

  it("stays silent when nothing is new", async () => {
    const { d } = feedDeps("• Job A\n• Job B");
    const r = await checkAlert(alert({ feed: true, seen: [normKey("Job A"), normKey("Job B")] }), d);
    expect(r.notify).toBe(false);
    expect(r.message).toBeNull();
  });
});

describe("checkAlert — trigger-to-action (trigger-to-action-alerts)", () => {
  it("appends the then-recipe result to a firing predicate alert", async () => {
    const { d } = deps("BTC is $48,000", {
      runThen: async (_c: number, name: string) => `ran ${name}: bought the dip`,
    });
    // below 50000, first crossing (no prior lastValue) -> notify + run `then`.
    const r = await checkAlert(alert({ condition: { op: "below", operand: 50000 }, then: "buy-alert" }), d);
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/BTC is \$48,000/);
    expect(r.message).toMatch(/▶ buy-alert:\nran buy-alert: bought the dip/);
  });

  it("a firing alert with NO then recipe is unchanged (plain notify)", async () => {
    const { d } = deps("BTC is $48,000", { runThen: async () => "should not appear" });
    const r = await checkAlert(alert({ condition: { op: "below", operand: 50000 } }), d); // no `then`
    expect(r.message).not.toMatch(/should not appear/);
  });

  it("a gone/failed then recipe leaves the base alert intact (still notifies)", async () => {
    const { d } = deps("BTC is $48,000", { runThen: async () => null }); // recipe deleted
    const r = await checkAlert(alert({ condition: { op: "below", operand: 50000 }, then: "gone" }), d);
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/BTC is \$48,000/);
    expect(r.message).not.toMatch(/▶/); // no appended block
  });

  it("appends to a feed alert's new-item notification too", async () => {
    const { d } = deps("• Job NEW", {
      runThen: async () => "summary: 1 new senior role",
    });
    const r = await checkAlert(alert({ feed: true, seen: [normKey("Job OLD")], then: "sum" }), d);
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/Job NEW/);
    expect(r.message).toMatch(/▶ sum:\nsummary: 1 new senior role/);
  });
});

describe("checkAlert — time series (watch-time-series)", () => {
  it("records a numeric point on a check with an extractable value", async () => {
    const points: Array<{ name: string; v: number; t: number }> = [];
    const { d } = deps("BTC is $65,000", {
      recordPoint: (_c: number, name: string, v: number, t: number) => points.push({ name, v, t }),
      now: () => 12345,
    });
    await checkAlert(alert({ threshold: 1000, lastValue: "$64,000" }), d);
    expect(points).toEqual([{ name: "btc", v: 65000, t: 12345 }]);
  });
  it("does NOT record a point for a non-numeric or feed value", async () => {
    const points: unknown[] = [];
    const rp = (_c: number, n: string, v: number, t: number) => points.push({ n, v, t });
    await checkAlert(alert({ lastValue: "sunny" }), deps("cloudy", { recordPoint: rp }).d); // prose
    await checkAlert(alert({ feed: true, seen: [] }), deps("• item", { recordPoint: rp }).d); // feed
    expect(points).toEqual([]);
  });
});

describe("checkAlert — watchlists", () => {
  // Member-aware harness: runAgent replies per-task from a map; captures setMemberLasts commits.
  function wlDeps(replies: Record<string, string>) {
    const committed: Array<{ label: string; value: string }> = [];
    return {
      d: {
        llm: {} as never,
        runAgent: async (task: string) => ({ reply: replies[task] ?? "n/a" }),
        formatReply: (t: string) => t,
        setLast: () => {},
        setMemberLasts: (_c: number, _n: string, updates: Array<{ label: string; value: string }>) => committed.push(...updates),
      },
      committed,
    };
  }
  const wl = (members: Array<{ label: string; task: string; last?: string }>): Alert =>
    ({ chatId: 1, name: "mk", task: "wl", members, created: NOW });

  it("runs the 'then' recipe + appends its output when a watchlist member changes (watchlist-then-dropped)", async () => {
    const { d } = wlDeps({ "btc": "$65k", "eth": "$3k" });
    let ranThen = "";
    const alert: Alert = { chatId: 1, name: "mk", task: "wl", then: "summary", created: NOW,
      members: [{ label: "btc", task: "btc", last: "$60k" }, { label: "eth", task: "eth", last: "$3k" }] };
    const r = await checkAlert(alert, { ...d, runThen: async (_c: number, name: string) => { ranThen = name; return "market note: choppy"; } });
    expect(r.notify).toBe(true);
    expect(ranThen).toBe("summary");                 // the then-recipe ran on the change
    expect(r.message).toMatch(/▶ summary:\nmarket note: choppy/); // its output appended to the ping
  });

  it("first run seeds every member silently (no notify), commit records all", async () => {
    const { d, committed } = wlDeps({ "btc": "$60k", "eth": "$3k" });
    const r = await checkAlert(wl([{ label: "btc", task: "btc" }, { label: "eth", task: "eth" }]), d);
    expect(r.notify).toBe(false);
    expect(committed).toEqual([{ label: "btc", value: "$60k" }, { label: "eth", value: "$3k" }]); // seeded (commit runs immediately on first run)
  });

  it("notifies ONLY the changed members, grouped in one message", async () => {
    const { d } = wlDeps({ "btc": "$65k", "eth": "$3k" });
    // btc moved ($60k -> $65k), eth unchanged ($3k).
    const r = await checkAlert(wl([{ label: "btc", task: "btc", last: "$60k" }, { label: "eth", task: "eth", last: "$3k" }]), d);
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/mk — 1 update/);
    expect(r.message).toMatch(/btc: \$65k/);
    expect(r.message).not.toMatch(/eth/); // unchanged member omitted
  });

  it("stays silent when no member changed", async () => {
    const { d } = wlDeps({ "btc": "$60k", "eth": "$3k" });
    const r = await checkAlert(wl([{ label: "btc", task: "btc", last: "$60k" }, { label: "eth", task: "eth", last: "$3k" }]), d);
    expect(r.notify).toBe(false);
  });

  it("commit records the changed member's new value (deferred to post-send)", async () => {
    const { d, committed } = wlDeps({ "btc": "$65k", "eth": "$3k" });
    const r = await checkAlert(wl([{ label: "btc", task: "btc", last: "$60k" }, { label: "eth", task: "eth", last: "$3k" }]), d);
    expect(committed).toEqual([]);   // not yet
    r.commit();
    expect(committed).toContainEqual({ label: "btc", value: "$65k" });
  });

  it("a member whose numeric baseline gets a numberless reply is NOT flagged + keeps its baseline (alert-numberless-flap)", async () => {
    // btc reply is a transient "N/A" (no number, prior was $60k); eth genuinely moved. Only eth pings,
    // and btc's baseline is NOT overwritten (no stale-$60k -> "N/A" text-diff false-ping).
    const { d, committed } = wlDeps({ "btc price": "temporarily unavailable", "eth price": "$4k" });
    const r = await checkAlert(wl([{ label: "btc", task: "btc price", last: "$60k" }, { label: "eth", task: "eth price", last: "$3k" }]), d);
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/eth: \$4k/);
    expect(r.message).not.toMatch(/btc/);     // the numberless member did NOT false-fire
    r.commit();
    expect(committed).toContainEqual({ label: "eth", value: "$4k" });
    expect(committed).not.toContainEqual({ label: "btc", value: "temporarily unavailable" }); // baseline kept
  });

  it("a member that missed its first check gets SEEDED on a later quiet tick, not left dead (watchlist-member-never-seeds)", async () => {
    // gold never seeded (last undefined — its first check errored); this tick it returns a value while
    // btc is unchanged. No ping, but gold MUST be seeded now or it can never fire (the change-guard needs
    // a baseline). Seed is committed immediately (no send to gate on).
    const { d, committed } = wlDeps({ "btc price": "$60k", "gold price": "$2400" });
    const r = await checkAlert(wl([{ label: "btc", task: "btc price", last: "$60k" }, { label: "gold", task: "gold price" /* last undefined */ }]), d);
    expect(r.notify).toBe(false);                                  // nothing changed -> no ping
    expect(committed).toContainEqual({ label: "gold", value: "$2400" }); // but gold got seeded NOW
    expect(committed).not.toContainEqual({ label: "btc", value: "$60k" }); // unchanged, already-seeded member not re-committed
  });

  it("a fully-unchanged watchlist with all members seeded commits nothing (no needless writes)", async () => {
    const { d, committed } = wlDeps({ "btc price": "$60k", "eth price": "$3k" });
    const r = await checkAlert(wl([{ label: "btc", task: "btc price", last: "$60k" }, { label: "eth", task: "eth price", last: "$3k" }]), d);
    expect(r.notify).toBe(false);
    expect(committed).toEqual([]); // no fresh seeds, no change -> nothing written
  });
});

describe("checkAlert — follow-feed subscriptions (direct fetch, no agent)", () => {
  const src = { kind: "rss" as const, url: "https://blog/feed", label: "blog" };
  const feedAlert = (over: Partial<Alert> = {}): Alert => ({ chatId: 1, name: "blog", task: "follow blog", feed: true, feedSource: src, created: NOW, ...over });

  // Title-keyed helper: pass plain titles; they become id-less FeedItems keyed as "t:<normTitle>".
  const tk = (title: string) => `t:${normKey(title)}`;
  function feedDeps(titles: string[]) {
    const seenWrites: string[][] = [];
    let ranAgent = false;
    return {
      seenWrites,
      ranAgent: () => ranAgent,
      d: {
        llm: {} as never,
        runAgent: async () => { ranAgent = true; return { reply: "SHOULD NOT RUN" }; },
        formatReply: (t: string) => t,
        setLast: () => {},
        recordSeen: (_c: number, _n: string, keys: string[]) => seenWrites.push(keys),
        fetchFeed: async () => titles.map((title) => ({ title })), // id-less -> title-keyed
      },
    };
  }

  it("first run seeds silently from the direct fetch, never touching the agent", async () => {
    const { d, ranAgent, seenWrites } = feedDeps(["Post A", "Post B"]);
    const r = await checkAlert(feedAlert({ seen: undefined }), d);
    expect(r.notify).toBe(false);        // seed, no ping
    expect(ranAgent()).toBe(false);      // keyless fetch, not the flaky agent
    expect(seenWrites[0]!.length).toBe(2); // both items seeded as seen
  });

  it("notifies only about NEW items on a later check", async () => {
    const { d } = feedDeps(["Post C", "Post A"]); // A already seen, C is new
    const r = await checkAlert(feedAlert({ seen: [tk("Post A")] }), d);
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/1 new/);
    expect(r.message).toMatch(/Post C/);
    expect(r.message).not.toMatch(/Post A/); // the already-seen item isn't re-reported
  });

  it("keeps two same-titled items distinct by id, so a repeated headline still fires (feed-dedup-title-only)", async () => {
    const seenWrites: string[][] = [];
    const d = {
      llm: {} as never,
      runAgent: async () => ({ reply: "x" }),
      formatReply: (t: string) => t,
      setLast: () => {},
      recordSeen: (_c: number, _n: string, keys: string[]) => seenWrites.push(keys),
      // Same title, different ids — an id-less title key would collapse these into one.
      fetchFeed: async () => [{ title: "Daily Discussion", id: "d2" }],
    };
    // "d1" already seen; "d2" (same title) is genuinely new and must fire.
    const r = await checkAlert(feedAlert({ seen: ["id:d1"] }), d);
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/Daily Discussion/);
  });

  it("stays silent (no baseline wipe) when the fetch returns nothing", async () => {
    const { d } = feedDeps([]);
    const r = await checkAlert(feedAlert({ seen: [tk("Post A")] }), d);
    expect(r.notify).toBe(false);
    expect(r.message).toBeNull();
  });

  it("records only the SHOWN items as seen when >10 are new, so the rest surface next check (feed-seen-swallows-overflow)", async () => {
    const titles = Array.from({ length: 15 }, (_, i) => `Post ${i + 1}`); // 15 new
    const { d, seenWrites } = feedDeps(titles);
    const r = await checkAlert(feedAlert({ seen: [] }), d); // seen defined (not first run) but empty
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/15 new/);
    expect(r.message).toMatch(/…and 5 more/);
    // Only the 10 shown items are committed as seen — items 11-15 stay unseen for the next check.
    r.commit();
    expect(seenWrites[0]!).toHaveLength(10);
    // The un-shown ones (Post 11..15) must NOT be in the seen set.
    expect(seenWrites[0]!.some((k) => k === tk("Post 15"))).toBe(false);
    expect(seenWrites[0]!.some((k) => k === tk("Post 1"))).toBe(true);
  });
});
