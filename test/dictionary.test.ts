import { describe, it, expect } from "vitest";
import { defineUrl, parseDefinition, formatDefinition, lookupWord } from "../src/lib/dictionary.js";

// A trimmed but realistic dictionaryapi.dev shape for "obsequious".
const OBSEQUIOUS = JSON.stringify([
  {
    word: "obsequious",
    phonetic: "/əbˈsiːkwɪəs/",
    phonetics: [{ text: "" }, { text: "/əbˈsiːkwɪəs/" }],
    meanings: [
      {
        partOfSpeech: "adjective",
        definitions: [
          { definition: "Obedient or attentive to an excessive or servile degree." },
          { definition: "Compliant in a fawning way." },
        ],
        synonyms: ["servile", "sycophantic", "fawning", "obsequent"],
      },
    ],
  },
]);

// The API's MISS payload is an object, not an array.
const MISS = JSON.stringify({ title: "No Definitions Found", message: "Sorry pal..." });

describe("defineUrl", () => {
  it("lowercases + encodes the word into the en endpoint", () => {
    expect(defineUrl("Escrow")).toBe("https://api.dictionaryapi.dev/api/v2/entries/en/escrow");
    expect(defineUrl("  déjà vu ")).toContain("d%C3%A9j%C3%A0%20vu");
  });
});

describe("parseDefinition", () => {
  it("parses word, phonetic, senses (capped), and merged synonyms", () => {
    const e = parseDefinition(OBSEQUIOUS)!;
    expect(e.word).toBe("obsequious");
    expect(e.phonetic).toBe("/əbˈsiːkwɪəs/");
    expect(e.senses).toHaveLength(1);
    expect(e.senses[0]!.partOfSpeech).toBe("adjective");
    expect(e.senses[0]!.definitions).toEqual([
      "Obedient or attentive to an excessive or servile degree.",
      "Compliant in a fawning way.",
    ]);
    expect(e.synonyms).toContain("servile");
  });

  it("falls back to the first non-empty phonetics[].text when top-level phonetic is missing", () => {
    const body = JSON.stringify([{ word: "x", phonetics: [{ text: "" }, { text: "/eks/" }], meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "the letter x" }] }] }]);
    expect(parseDefinition(body)!.phonetic).toBe("/eks/");
  });

  it("caps definitions per sense at 3", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ definition: `def ${i}` }));
    const body = JSON.stringify([{ word: "run", meanings: [{ partOfSpeech: "verb", definitions: many }] }]);
    expect(parseDefinition(body)!.senses[0]!.definitions).toHaveLength(3);
  });

  it("returns null for a miss (object payload), empty array, or junk", () => {
    expect(parseDefinition(MISS)).toBeNull();
    expect(parseDefinition("[]")).toBeNull();
    expect(parseDefinition("not json")).toBeNull();
    expect(parseDefinition(JSON.stringify([{ word: "x" }]))).toBeNull(); // no senses
  });
});

describe("formatDefinition", () => {
  it("renders word + phonetic, numbered defs, and a synonyms line", () => {
    const out = formatDefinition(parseDefinition(OBSEQUIOUS)!);
    expect(out).toMatch(/obsequious \/əbˈsiːkwɪəs\//);
    expect(out).toMatch(/\(adjective\)/);
    expect(out).toMatch(/1\. Obedient/);
    expect(out).toMatch(/Synonyms: servile/);
  });
});

describe("lookupWord", () => {
  it("fetches the define URL and returns the parsed entry", async () => {
    let seen = "";
    const e = await lookupWord("obsequious", async (u) => { seen = u; return OBSEQUIOUS; });
    expect(seen).toBe(defineUrl("obsequious"));
    expect(e!.word).toBe("obsequious");
  });
  it("returns null on a miss and on a fetch throw (falls back to web_search upstream)", async () => {
    expect(await lookupWord("asdfqwer", async () => MISS)).toBeNull();
    expect(await lookupWord("x", async () => { throw new Error("net"); })).toBeNull();
    expect(await lookupWord("  ", async () => OBSEQUIOUS)).toBeNull(); // empty word, no fetch
  });
});
