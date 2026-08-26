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

  it("unchanged value -> silent (no notify), still refreshes lastValue", async () => {
    const { d, lastSet } = deps("sunny");
    const r = await checkAlert(alert({ lastValue: "sunny" }), d);
    expect(r.notify).toBe(false);
    expect(r.message).toBeNull();
    expect(lastSet).toEqual([{ name: "btc", value: "sunny" }]);
  });

  it("changed value -> notify with a 'changed' message", async () => {
    const { d } = deps("rainy");
    const r = await checkAlert(alert({ lastValue: "sunny" }), d);
    expect(r.notify).toBe(true);
    expect(r.message).toMatch(/btc changed/);
    expect(r.message).toMatch(/rainy/);
  });

  it("threshold: small numeric move is silent, big move notifies", async () => {
    const small = await checkAlert(alert({ lastValue: "$65,000", threshold: 1000 }), deps("$65,200").d);
    expect(small.notify).toBe(false);
    const big = await checkAlert(alert({ lastValue: "$65,000", threshold: 1000 }), deps("$67,000").d);
    expect(big.notify).toBe(true);
  });

  it("an agent failure -> no notify, no spam, value left as-is", async () => {
    const { d } = deps("ignored", { runAgent: async () => { throw new Error("boom"); } });
    const r = await checkAlert(alert({ lastValue: "prev" }), d);
    expect(r.notify).toBe(false);
    expect(r.value).toBe("prev");
  });
});
