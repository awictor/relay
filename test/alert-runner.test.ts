import { describe, it, expect } from "vitest";
import { checkAlert } from "../src/alert-runner.js";
import type { Alert } from "../src/lib/alerts.js";

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
    expect(s2.lastSet).toEqual([{ name: "btc", value: "$66,200" }]); // advances only now
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

  it("first run with no number still seeds (nothing to protect yet)", async () => {
    const { d, lastSet } = deps("Price unavailable");
    const r = await checkAlert(alert({ threshold: 1000 }), d); // no lastValue
    expect(r.notify).toBe(true); // first run notifies (baseline)
    expect(lastSet).toEqual([{ name: "btc", value: "Price unavailable" }]);
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
