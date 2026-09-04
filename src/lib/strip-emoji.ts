// Emoji stripping (verbosity-emoji-on-proactive): a user who set "no emoji" gets a soft context hint, but a
// free-tier LLM often ignores it and still decorates replies — and proactive sends don't run the inbound
// path at all. This is the deterministic follow-through: remove emoji from a reply when the pref is set.
// Pure + LLM-agnostic. Intentionally conservative — strips pictographic emoji + variation selectors + ZWJ
// sequences + skin-tone modifiers, but LEAVES useful symbols a text answer relies on (°, %, $, €, £, ×, ±,
// arrows in prose, math). A weather/price reply reads the same, minus the decoration.

// Core pictographic ranges + supplements. Deliberately does NOT include U+2600–27BF wholesale (that block
// mixes true emoji with ✓ �this-kind of symbol and ° isn't there but ‰ etc. are) — instead we target the
// emoji-presentation pictographs plus a short allow-through for the handful of dingbats that ARE emoji.
const EMOJI_RE = new RegExp(
  "(?:" +
    // Regional indicator flags (🇺🇸 etc.)
    "[\\u{1F1E6}-\\u{1F1FF}]{1,2}" +
    // Main pictographic planes: emoticons, symbols & pictographs, transport, supplemental & extended-A,
    // enclosed, chess/symbols, misc-symbols-and-pictographs.
    "|[\\u{1F300}-\\u{1FAFF}]" +
    "|[\\u{1F000}-\\u{1F0FF}]" + // mahjong/dominoes/cards
    // Misc-technical emoji: ⌚(231A) ⌛(231B) ⏩–⏳/⏰–⏺(23E9–23FA). Leaves the rest of the block (math/APL) alone.
    "|[\\u{231A}-\\u{231B}]|[\\u{23E9}-\\u{23FA}]" +
    // Misc symbols + dingbats that render as emoji (☀ ☂ ★ ✂ ✅ ✈ ✉ ✊ ❤ ➡ …). Narrow, common-emoji subset.
    "|[\\u{2600}-\\u{26FF}]" +
    "|[\\u{2700}-\\u{27BF}]" +
    "|[\\u{2B00}-\\u{2BFF}]" + // ⭐ ⬆ ⬇ etc. (emoji arrows live here; plain text arrows ← → U+2190–21FF are LEFT alone)
    "|\\u{2764}" + // heavy black heart
    "|[\\u{FE00}-\\u{FE0F}]" + // variation selectors (emoji/text presentation)
    "|\\u{200D}" + // zero-width joiner (glue in 👨‍👩‍👧 sequences)
    "|[\\u{1F3FB}-\\u{1F3FF}]" + // skin-tone modifiers
    "|[\\u{20E0}-\\u{20FF}]" + // combining enclosing marks (keycap ⃣)
    "|[\\u{0023}\\u{002A}\\u{0030}-\\u{0039}]\\u{FE0F}?\\u{20E3}" + // keycap emoji (#️⃣ 1️⃣) — only the keycap form
  ")",
  "gu",
);

/**
 * Remove emoji from `text`. Collapses the extra whitespace an emoji removal leaves behind (a trailing
 * "72°F ☀️" -> "72°F", a leading "☀️ Sunny" -> "Sunny", a mid-line "up 📈 today" -> "up today") so the
 * result reads clean, and trims each line. Leaves ordinary punctuation + non-emoji symbols (°, %, $) intact.
 */
export function stripEmoji(text: string): string {
  if (!text) return text;
  const withoutEmoji = text.replace(EMOJI_RE, "");
  // Collapse runs of spaces/tabs the removal opened up, but preserve newlines (line structure matters for a
  // digest/briefing). Then trim spaces at each line edge + drop any line that became empty only mid-run.
  return withoutEmoji
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/ +([.,;:!?)])/g, "$1").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // don't let removed emoji-only lines pile blank lines
    .trim();
}

/** Does `text` contain any emoji this stripper would remove? Cheap pre-check so callers can skip the
 * rebuild + only note "stripped" when it actually changed something. */
export function hasEmoji(text: string): boolean {
  EMOJI_RE.lastIndex = 0;
  return EMOJI_RE.test(text);
}
