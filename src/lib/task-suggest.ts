// Auto-suggest saving a repeated ask as a recipe (product-loop). Recipes/alerts exist but a user
// must know the "save X:" syntax; most never do, so the retention flywheel never starts. When an
// inbound task closely matches one the user already asked in this chat's recent history, we append a
// ONE-LINE nudge to the reply offering to save it. Pure + conservative so it doesn't nag.

import type { LLMMessage } from "../llm.js";

// Marker so we never nudge twice in a row (the prior assistant turn carrying it means we just asked).
export const SAVE_NUDGE_MARKER = "💾";

const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "me", "my", "is", "it", "and", "what", "whats", "s", "please", "can", "you", "get", "show"]);

/** Normalize to a set of salient word tokens (lowercased, punctuation-stripped, stopwords dropped). */
function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/** Jaccard overlap of two token sets (0..1). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * If `current` is a substantive task that closely matches an earlier USER turn in `history` (and we
 * didn't just nudge), return a short "want me to save this?" line; else null. Conservative on purpose:
 *   - needs >=2 salient tokens (skips trivial "hi", "thanks")
 *   - needs a prior user turn with high token overlap (a genuine repeat, not a follow-up)
 *   - suppressed if the most recent assistant turn already carried the nudge marker
 */
export function repeatedTaskNudge(current: string, history: LLMMessage[]): string | null {
  const cur = tokens(current);
  if (cur.size < 2) return null;
  // Don't stack nudges: if we asked last turn, stay quiet.
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  if (lastAssistant && typeof lastAssistant.content === "string" && lastAssistant.content.includes(SAVE_NUDGE_MARKER)) return null;
  const priorUserTurns = history.filter((m) => m.role === "user" && typeof m.content === "string");
  for (const m of priorUserTurns) {
    const prev = tokens(m.content as string);
    if (prev.size < 2) continue;
    if (overlap(cur, prev) >= 0.6) {
      return `\n\n${SAVE_NUDGE_MARKER} You've asked this before — want me to save it? Try "save <name>: ${current.trim()}" (then /run <name>), or "every morning ${current.trim()}" to get it daily.`;
    }
  }
  return null;
}

/**
 * Match a free-text inbound message against saved recipes so a user can REUSE one without recalling
 * the exact /run name (recipe-auto-recall). Returns the best recipe {name} whose task strongly
 * overlaps the message, or null. Conservative — high threshold (0.7) + >=2 salient tokens — so a
 * normal task isn't hijacked into a stored recipe. Ties broken by first (stable). Exported for tests.
 */
export function matchRecipe(text: string, recipes: Array<{ name: string; task: string }>): { name: string } | null {
  const cur = tokens(text);
  if (cur.size < 2) return null;
  let best: { name: string; score: number } | null = null;
  for (const r of recipes) {
    const score = overlap(cur, tokens(r.task));
    if (score >= 0.6 && (!best || score > best.score)) best = { name: r.name, score };
  }
  return best ? { name: best.name } : null;
}
