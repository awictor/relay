import { describe, it, expect } from "vitest";
import { formatTurnLog } from "../src/lib/turn-log.js";

describe("formatTurnLog", () => {
  it("emits an [out] JSON line with shape/metadata only", () => {
    const line = formatTurnLog({ chatId: 123, steps: 3, tools: ["scrape", "extract"], elapsedMs: 1234.6, replyChars: 42, ok: true });
    expect(line.startsWith("[out] ")).toBe(true);
    const obj = JSON.parse(line.slice(6));
    expect(obj).toMatchObject({ chat: "123", steps: 3, tools: ["scrape", "extract"], ms: 1235, replyChars: 42, ok: true });
    expect(obj.error).toBeUndefined();
  });

  it("dedupes + counts repeated tools", () => {
    const obj = JSON.parse(formatTurnLog({ chatId: "c", steps: 4, tools: ["scrape", "scrape", "extract"], elapsedMs: 0, replyChars: 0, ok: true }).slice(6));
    expect(obj.tools).toContain("scrape x2");
    expect(obj.tools).toContain("extract");
  });

  it("includes a truncated error on failure and never message text", () => {
    const obj = JSON.parse(formatTurnLog({ chatId: 1, steps: 0, tools: [], elapsedMs: 10, replyChars: 0, ok: false, error: "x".repeat(500) }).slice(6));
    expect(obj.ok).toBe(false);
    expect(obj.error.length).toBe(200);
  });

  it("clamps negative/odd numbers", () => {
    const obj = JSON.parse(formatTurnLog({ chatId: 1, steps: 1, tools: [], elapsedMs: -5, replyChars: -3, ok: true }).slice(6));
    expect(obj.ms).toBe(0);
    expect(obj.replyChars).toBe(0);
  });
});
