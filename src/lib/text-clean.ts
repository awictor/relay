// Shared free-text cleanup helpers. Small + pure so every command parser reuses the same rules instead
// of re-deriving them (and drifting). Currently: stripping a trailing courtesy word that a user tacks
// onto a request but doesn't mean as part of the stored value.

// Strip a TRAILING politeness word ("... please" / "... pls" / "... thanks") from a parsed value so it
// isn't baked into a stored fact/place/feed/task + echoed back forever (courtesy-tail bug class).
// Deliberately conservative:
//   - only at the very END, after optional whitespace/comma;
//   - only when other text precedes it (a bare "please"/"thanks" as the whole value is kept — nothing
//     else was said);
//   - "please/pls/plz" always strip (rarely a real value word). "thanks/thank you/thx" strip too HERE
//     because callers use this on values where "thanks" as content is unlikely — EXCEPT the schedule
//     task path, which keeps "thanks" (a reminder "say thanks" is real) and passes onlyPlease=true.
export function stripTrailingCourtesy(s: string, opts: { onlyPlease?: boolean } = {}): string {
  const re = opts.onlyPlease
    ? /[\s,]*\b(?:please|pls|plz)\b[\s.!?]*$/i
    : /[\s,]*\b(?:please|pls|plz|thanks|thank\s+you|thx|ty)\b[\s.!?]*$/i;
  const stripped = s.replace(re, "").trim();
  return stripped ? stripped : s; // keep the word if it was the whole value
}
