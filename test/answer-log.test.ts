import { describe, it, expect, afterEach } from "vitest";
import { AnswerLog, isAnswerRecall, recallKeywords } from "../src/lib/answer-log.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-ans-")); dirs.push(d); return join(d, "a.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("isAnswerRecall (answer-history-recall)", () => {
  it("true for asks about a PAST answer Relay gave", () => {
    for (const t of [
      "what was that sushi place you found?",
      "what did you tell me about the flights",
      "which restaurant did you recommend",
      "resend the report",
      "send me again the top story",
      "what did you find on the CRMs",
    ]) expect(isAnswerRecall(t), t).toBe(true);
  });
  it("false for a fresh task or a notes recall", () => {
    for (const t of ["weather in Paris", "what's the price of bitcoin", "what do you know about me", "remind me to stretch"]) {
      expect(isAnswerRecall(t), t).toBe(false);
    }
  });
});

describe("recallKeywords", () => {
  it("drops recall scaffolding + stopwords, keeps content words", () => {
    expect(recallKeywords("what was that sushi place you found")).toEqual(["sushi", "place"]);
    expect(recallKeywords("resend the flights report")).toEqual(["flights", "report"]);
  });
});

describe("AnswerLog", () => {
  it("records + searches by keyword, best match first", () => {
    const s = new AnswerLog({ file: tmp() });
    s.record(1, "best sushi near me", "Try Sushi Zen on Main St.", NOW);
    s.record(1, "cheapest flights to Lisbon", "TAP has $312 on the 14th.", NOW + 1);
    const hits = s.search(1, recallKeywords("what was that sushi place"), 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.reply).toMatch(/Sushi Zen/);
  });
  it("empty query returns most-recent answers", () => {
    const s = new AnswerLog({ file: tmp() });
    s.record(1, "a", "first", NOW);
    s.record(1, "b", "second", NOW + 1);
    const hits = s.search(1, [], 3);
    expect(hits[0]!.reply).toBe("second"); // newest first
  });
  it("returns [] when nothing matches / chat unknown", () => {
    const s = new AnswerLog({ file: tmp() });
    s.record(1, "sushi", "Zen", NOW);
    expect(s.search(1, ["flights"], 3)).toEqual([]);
    expect(s.search(99, [], 3)).toEqual([]);
  });
  it("skips empty task/reply + caps + persists", () => {
    const f = tmp();
    const s = new AnswerLog({ file: f });
    s.record(1, "  ", "x", NOW); // empty task -> not stored
    expect(s.size()).toBe(0);
    for (let i = 0; i < 120; i++) s.record(1, `q${i}`, `a${i}`, NOW + i);
    expect(s.size()).toBe(100);                       // capped
    const reload = new AnswerLog({ file: f });
    expect(reload.search(1, ["q119"], 1)[0]!.reply).toBe("a119"); // persisted + newest kept
    expect(reload.search(1, ["q0"], 1)).toEqual([]);              // oldest aged out
  });
});
