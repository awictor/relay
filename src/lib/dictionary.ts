// Word definitions (dictionary-tool): "what does obsequious mean" / "define escrow" / "synonyms for
// happy" is among the most common quick phone errands, yet Relay either answered from model memory (no
// source, can be wrong) or burned 10-30s on a web_search+scrape for a one-word lookup. This hits the
// keyless dictionaryapi.dev API (no signup) for an instant definition + part-of-speech + phonetics +
// synonyms, mirroring get_crypto/get_quote/convert_currency. Pure parse/format helpers exported +
// unit-tested; the network fetch is injected (guarded GET in prod, a fake in tests).

export interface WordSense { partOfSpeech: string; definitions: string[]; synonyms: string[]; }
export interface WordEntry { word: string; phonetic?: string; senses: WordSense[]; synonyms: string[]; }

// dictionaryapi.dev keyless endpoint. Only English (`en`) — the free API's other languages are spotty.
export function defineUrl(word: string): string {
  return `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.trim().toLowerCase())}`;
}

/**
 * Parse a dictionaryapi.dev response into a compact WordEntry, or null (unknown word / bad shape — the
 * API returns a `{title:"No Definitions Found"}` object, not an array, for a miss). Caps each sense to a
 * few definitions so a long entry stays a text-message, not an essay. Exported for tests.
 */
export function parseDefinition(body: string): WordEntry | null {
  let arr: unknown;
  try { arr = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length) return null; // a miss is an object {title,...}, not an array
  const entries = arr as Array<{
    word?: string;
    phonetic?: string;
    phonetics?: Array<{ text?: string }>;
    meanings?: Array<{ partOfSpeech?: string; definitions?: Array<{ definition?: string }>; synonyms?: string[] }>;
  }>;
  const first = entries[0]!;
  const word = String(first.word ?? "").trim();
  if (!word) return null;
  // Phonetic: the top-level one, else the first non-empty phonetics[].text across entries.
  let phonetic = String(first.phonetic ?? "").trim();
  if (!phonetic) {
    for (const e of entries) {
      const p = e.phonetics?.find((x) => x?.text && x.text.trim())?.text;
      if (p) { phonetic = p.trim(); break; }
    }
  }
  const senses: WordSense[] = [];
  const allSyn = new Set<string>();
  for (const e of entries) {
    for (const m of e.meanings ?? []) {
      const pos = String(m.partOfSpeech ?? "").trim();
      const defs = (m.definitions ?? [])
        .map((d) => String(d.definition ?? "").trim())
        .filter(Boolean)
        .slice(0, 3); // cap per sense — keep it a text, not a wall
      if (!defs.length) continue;
      const syn = (m.synonyms ?? []).map((s) => String(s).trim()).filter(Boolean);
      syn.forEach((s) => allSyn.add(s));
      senses.push({ partOfSpeech: pos, definitions: defs, synonyms: syn.slice(0, 8) });
    }
  }
  if (!senses.length) return null;
  return {
    word,
    ...(phonetic ? { phonetic } : {}),
    senses: senses.slice(0, 4), // cap number of parts-of-speech shown
    synonyms: [...allSyn].slice(0, 12),
  };
}

/** Format a WordEntry into a short human message: word + phonetic, then per-sense definitions, then a
 * synonyms line. Kept tight so it reads on a phone. */
export function formatDefinition(e: WordEntry): string {
  const head = e.phonetic ? `${e.word} ${e.phonetic}` : e.word;
  const body = e.senses.map((s) => {
    const label = s.partOfSpeech ? `(${s.partOfSpeech}) ` : "";
    const defs = s.definitions.map((d, i) => `${e.senses.length > 1 || s.definitions.length > 1 ? `${i + 1}. ` : ""}${d}`).join("\n");
    return `${label}\n${defs}`;
  }).join("\n\n");
  const syn = e.synonyms.length ? `\n\nSynonyms: ${e.synonyms.slice(0, 8).join(", ")}` : "";
  return `${head}\n${body}${syn}`;
}

/**
 * Look up a word's definition. `fetchText` is injected (guarded GET in prod, a fake in tests). Returns
 * null on an unknown word / fetch failure — the caller falls back to web_search / model knowledge.
 */
export async function lookupWord(
  word: string,
  fetchText: (url: string) => Promise<string>,
): Promise<WordEntry | null> {
  const w = String(word ?? "").trim();
  if (!w) return null;
  try {
    return parseDefinition(await fetchText(defineUrl(w)));
  } catch { return null; }
}
