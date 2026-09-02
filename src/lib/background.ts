// Background errands (async-background-errands): a big, open-ended task ("find the 5 cheapest Lisbon
// flights next month and get back to me") needs many browse steps and minutes of wall-clock — running
// it synchronously blocks the reply and truncates at the normal step cap. Detect such a task so the
// handler can ACK immediately ("on it — I'll text you when it's done"), run it detached with a raised
// step budget, and deliver the result unprompted. Pure detector; the handler owns the dispatch.

// Explicit dispatch phrasing: the user literally asks to be pinged later.
const DISPATCH_RE = /\b(get back to me|report back|let me know when (?:you'?re|its?|it'?s) done|(?:text|ping|message|dm) me when (?:you'?re|its?|it'?s) done|(?:text|ping|message|dm) me when done|(?:text|ping|message|dm) me (?:the results?|back)|when you'?re done|take your time|in the background|no rush)\b/i;
// Scale cues: a task that ranks/compares/compiles MANY things across sources — long by nature.
const SCALE_RE = /\b(cheapest|best|top \d+|compare (?:the )?\d+|(?:find|list) (?:me )?\d+|all the|every |as many|round\s?up|shortlist|deep dive|thorough(?:ly)?|research)\b/i;

/** Should this task run as a background errand (ack now, run detached, deliver later)? True when the
 * user explicitly asked to be pinged later, OR the task is clearly large-scale AND long enough to be a
 * real errand (not a one-line lookup). Deliberately conservative — a normal quick task must stay
 * synchronous so the user isn't told "I'll get back to you" for something that takes 5 seconds. */
export function isBackgroundErrand(text: string): boolean {
  const t = text.trim();
  if (DISPATCH_RE.test(t)) return true;
  // Scale cue alone only counts for a longer request (a terse "best pizza" is a quick lookup).
  return SCALE_RE.test(t) && t.split(/\s+/).length >= 6;
}

// Step budget for a background errand — well above the synchronous default, under the agent's ceiling.
export const BACKGROUND_MAX_STEPS = 20;

/** Strip the dispatch phrasing from a task before handing it to the agent, so the model doesn't try to
 * "text you later" itself (it can't) — it just does the work. Whitespace re-collapsed. */
export function stripDispatchPhrasing(text: string): string {
  return text.replace(DISPATCH_RE, " ").replace(/\s+/g, " ").replace(/\s+([.,;!?])/g, "$1").trim();
}
