import { describe, it, expect } from "vitest";
import { parseWatchQuery, justWatchUrl, formatWatchWhere } from "../src/lib/watch-where.js";

describe("parseWatchQuery", () => {
  it("extracts the title from where-to-watch phrasings", () => {
    expect(parseWatchQuery("where can I watch Dune Part Two")).toBe("Dune Part Two");
    expect(parseWatchQuery("where can I stream Oppenheimer")).toBe("Oppenheimer");
    expect(parseWatchQuery("how do I watch The Matrix")).toBe("The Matrix");
    expect(parseWatchQuery("is Barbie on Netflix")).toBe("Barbie"); // strips the platform clause
    expect(parseWatchQuery("watch the movie Interstellar")).toBe("Interstellar"); // drops "the movie" filler
  });
  it("null when it isn't a watch ask", () => {
    expect(parseWatchQuery("who directed Dune")).toBeNull();
    expect(parseWatchQuery("Dune")).toBeNull();
    expect(parseWatchQuery("what's the weather")).toBeNull();
  });
  it("strips a trailing courtesy so it isn't folded into the title (courtesy-tail)", () => {
    // "where to watch Dune please" queries "Dune", not "Dune please" (the end-anchored title capture
    // would otherwise carry "please" into the JustWatch query).
    expect(parseWatchQuery("where can I watch Dune please")).toBe("Dune");
    expect(parseWatchQuery("where can I stream Oppenheimer thanks")).toBe("Oppenheimer");
  });
});

describe("justWatchUrl", () => {
  it("builds a per-region JustWatch search URL", () => {
    expect(justWatchUrl("Dune Part Two")).toBe("https://www.justwatch.com/us/search?q=Dune%20Part%20Two");
    expect(justWatchUrl("Barbie", "gb")).toContain("/gb/search?q=Barbie");
  });
});

describe("formatWatchWhere", () => {
  it("gives the JustWatch link + an honest can't-confirm-a-service note", () => {
    const out = formatWatchWhere("Oppenheimer");
    expect(out).toMatch(/justwatch\.com\/us\/search\?q=Oppenheimer/);
    expect(out).toMatch(/can't reliably confirm/i);
    expect(out).not.toMatch(/on Netflix/i); // never claims a specific service
  });
});
