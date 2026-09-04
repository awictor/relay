import { describe, it, expect } from "vitest";
import { briefenReply } from "../src/lib/brief.js";

describe("briefenReply (reply-style-apply-to-agent-length)", () => {
  const long =
    "The weather in Austin is sunny and 82 degrees. Winds are light out of the south at 5 mph. " +
    "Humidity sits around 40 percent. There is no rain expected today. Tomorrow will be similar.";

  it("caps long prose to its first few sentences", () => {
    const out = briefenReply(long);
    expect(out).toBe("The weather in Austin is sunny and 82 degrees. Winds are light out of the south at 5 mph. Humidity sits around 40 percent.");
    expect(out.length).toBeLessThan(long.length);
  });

  it("respects an explicit sentence budget", () => {
    expect(briefenReply(long, { maxSentences: 1 })).toBe("The weather in Austin is sunny and 82 degrees.");
  });

  it("leaves already-short prose unchanged", () => {
    expect(briefenReply("It's 82 and sunny.")).toBe("It's 82 and sunny.");
  });

  it("does NOT mangle a bulleted/structured list (only prose is trimmed)", () => {
    const list = "Top stories:\n• AI beats benchmark\n• New chip launches\n• Market rallies\n• Fourth\n• Fifth";
    expect(briefenReply(list)).toBe(list);
  });

  it("does NOT trim a numbered list", () => {
    const numbered = "Options:\n1. Tacos\n2. Sushi\n3. Pizza\n4. Ramen";
    expect(briefenReply(numbered)).toBe(numbered);
  });

  it("hard-caps a single run-on sentence on a word boundary under maxChars", () => {
    const runOn = "word ".repeat(200).trim() + ".";
    const out = briefenReply(runOn, { maxChars: 100 });
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(" ")).toBe(false);        // trimmed trailing space
    expect(runOn.startsWith(out.replace(/…$/, ""))).toBe(true); // a prefix of the original
  });

  it("keeps only the first paragraph of multi-paragraph prose", () => {
    const multi = "First point here. Still first.\n\nA whole second paragraph that should be dropped in brief mode.";
    const out = briefenReply(multi);
    expect(out).toContain("First point here");
    expect(out).not.toContain("second paragraph");
  });

  it("returns empty for empty input", () => {
    expect(briefenReply("")).toBe("");
    expect(briefenReply("   ")).toBe("");
  });
});
