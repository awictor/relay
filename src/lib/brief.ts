// Brief-mode reply shortening (reply-style-apply-to-agent-length): a user who set "keep it brief" gets a
// soft hint in the agent context, but a free-tier LLM often ignores it and still returns a wall of text.
// This is the deterministic follow-through — cap a PROSE reply to its first few sentences so brief actually
// feels brief. Pure + LLM-agnostic. Only the shown text is trimmed; the caller keeps the full text cached so
// a follow-up "more" still pages the rest (last-result-drilldown), i.e. brief hides the tail, never loses it.

const DEFAULT_MAX_SENTENCES = 3;
const DEFAULT_MAX_CHARS = 400;

/** Would briefening this text change it? A bulleted/structured/JSON-rendered reply (lines starting with
 * "•", numbered lists, tables) is deliberately left alone — sentence-splitting it would mangle the layout,
 * and a list is already scannable. Only free-flowing prose gets shortened. */
function isProse(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Any bullet / numbered-list / pipe-table line -> treat as structured, don't sentence-trim.
  if (/^\s*(?:[•\-*]\s|\d+[.)]\s)/m.test(t)) return false;
  if (/\|.*\|/.test(t)) return false; // a markdown-ish table row
  return true;
}

/** Split prose into sentences, keeping terminal punctuation. Abbreviation-naive but good enough for
 * chat prose; a sentence boundary is .!? followed by whitespace + an uppercase/quote/digit start. */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g);
  return (parts ?? [text]).map((s) => s.trim()).filter(Boolean);
}

/**
 * Shorten a brief-mode reply to at most `maxSentences` sentences AND `maxChars` characters, cutting on a
 * whole-sentence boundary where possible. Returns the input unchanged when it's already short, or when it's
 * structured (bulleted/JSON) rather than prose. Never appends an ellipsis on its own — the caller decides
 * how to signal "there's more" (it already caches the full text for a "more" follow-up).
 */
export function briefenReply(
  text: string,
  opts: { maxSentences?: number; maxChars?: number } = {},
): string {
  const maxSentences = opts.maxSentences ?? DEFAULT_MAX_SENTENCES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const raw = (text ?? "").trim();
  if (!raw || !isProse(raw)) return raw;
  // Multi-paragraph prose: keep only the first paragraph before counting sentences (brief = the gist).
  const firstPara = raw.split(/\n\s*\n/)[0]!.trim();
  const sentences = splitSentences(firstPara);
  let kept = sentences.slice(0, maxSentences).join(" ").trim();
  // Still too long by chars (one giant run-on sentence)? Hard-cut on a word boundary under maxChars.
  if (kept.length > maxChars) {
    const cut = kept.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    kept = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
  }
  // If briefening didn't actually shorten anything (already within budget), return the original raw so we
  // don't drop a trailing paragraph the sentence-join happened to equal.
  return kept.length < raw.length ? kept : raw;
}
