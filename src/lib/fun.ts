// Fun: joke / fact / trivia (get-fun-tool): "tell me a joke", "fun fact", "trivia question" are among the
// most common FIRST messages to a new bot — a quick delight test before a real errand. They fell to a
// slow browse or a stale from-memory answer. This hits keyless no-signup APIs (official-joke-api for a
// joke, catfact.ninja for a fact, opentdb for a trivia question) for an instant reply. Pure parse/format
// helpers exported + unit-tested; the fetch is injected so it runs offline. Mirrors get_news/get_scores.

export type FunKind = "joke" | "fact" | "trivia";

/** Which fun thing the user asked for (default a joke). Exported for tests. */
export function parseFunKind(request: string): FunKind {
  const t = request.toLowerCase();
  if (/\b(fun\s*fact|random\s*fact|a\s*fact|did\s*you\s*know|tell\s*me\s*(?:a\s*|something\s*)?fact)\b/.test(t)) return "fact";
  if (/\b(trivia|quiz|quiz\s*me|trivia\s*question|test\s*me)\b/.test(t)) return "trivia";
  return "joke";
}

/** The keyless source URL for a fun kind. Exported for tests. */
export function funUrl(kind: FunKind): string {
  switch (kind) {
    case "fact": return "https://catfact.ninja/fact";
    case "trivia": return "https://opentdb.com/api.php?amount=1&type=multiple";
    default: return "https://official-joke-api.appspot.com/random_joke";
  }
}

// Decode the minimal HTML entities opentdb returns in its questions/answers.
function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&eacute;/g, "é").replace(/&ldquo;|&rdquo;/g, '"').replace(/&hellip;/g, "…");
}

/** Parse a fun API response into a ready-to-send string, or null on a bad/empty body. A trivia item
 * includes the answer on a second line (the user asked to be quizzed; they can peek). Exported. */
export function formatFun(kind: FunKind, body: string): string | null {
  try {
    const obj = JSON.parse(body);
    if (kind === "joke") {
      const setup = String(obj.setup ?? "").trim(), punch = String(obj.punchline ?? "").trim();
      if (!setup || !punch) return null;
      return `${setup}\n\n${punch}`;
    }
    if (kind === "fact") {
      const fact = String(obj.fact ?? "").trim();
      return fact ? `Fun fact: ${fact}` : null;
    }
    // trivia: opentdb -> { results: [{ question, correct_answer, category }] }
    const r = obj?.results?.[0];
    if (!r?.question || !r?.correct_answer) return null;
    const q = decodeEntities(String(r.question)), a = decodeEntities(String(r.correct_answer));
    const cat = r.category ? ` (${decodeEntities(String(r.category))})` : "";
    return `Trivia${cat}: ${q}\n\nAnswer: ${a}`;
  } catch { return null; }
}

/**
 * Fetch a joke/fact/trivia. `fetchText` is injected (a guarded GET in prod, a fake in tests). Returns the
 * formatted string, or null on a fetch/parse failure so the caller can fall back. Never throws. Exported.
 */
export async function getFun(
  request: string,
  fetchText: (url: string) => Promise<string>,
): Promise<{ kind: FunKind; text: string } | null> {
  const kind = parseFunKind(request);
  try {
    const text = formatFun(kind, await fetchText(funUrl(kind)));
    return text ? { kind, text } : null;
  } catch { return null; }
}
