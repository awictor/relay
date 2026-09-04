// Translate (translate-tool): "how do you say X in Japanese", "translate this to Spanish", "read me
// this German page in English" is a top everyday/travel assistant ask, but it was only IMPLICIT (the
// prompt's pasted-text carve-out) — no dedicated affordance, no discoverability in /help, and a page
// (foreign article/menu) had no path. This wraps the in-loop LLM (far better than a keyless MT endpoint
// like MyMemory, which transliterates "good morning" -> グッドモーリング) behind a real tool: pasted text
// translates directly; a URL is scraped then translated. Pure parse + prompt helpers exported + tested;
// the LLM + scrape are injected so it runs offline in tests.
import type { LLMClient } from "../llm.js";
import { stripTrailingCourtesy } from "./text-clean.js";

/** Parse a translate request into { target, text?, url? }, or null. Handles:
 *   "translate 'hola' to English"            -> { target: "English", text: "hola" }
 *   "how do you say good morning in Japanese"-> { target: "Japanese", text: "good morning" }
 *   "translate this page to English: <url>"  -> { target: "English", url }
 *   "translate <url> to French"              -> { target: "French", url }
 * The target language defaults to English when a translate verb is present but no "to <lang>" clause
 * ("translate this German text" -> English). Exported for tests. */
export function parseTranslateRequest(text: string): { target: string; text?: string; url?: string } | null {
  // Drop a trailing courtesy first so "translate good morning to french please" targets "french", not
  // "french please" — the 2-word target capture would otherwise swallow the courtesy and the model gets
  // told to translate "into french please" (courtesy-tail bug class). A URL tail is handled separately
  // below, so stripping here only touches a trailing please/thanks on a text request.
  const t = stripTrailingCourtesy(text.trim());
  if (!/\b(translate|translation|how (?:do|would) (?:you|i) say|what(?:'?s| is)\s+.+\s+in\s+[a-z]+)\b/i.test(t)) return null;

  // A URL anywhere -> translate that page. The target is a trailing "to/into/in <lang>" clause; capture
  // it BEFORE stripping the URL so "translate <url> to French" still gets French.
  const url = t.match(/https?:\/\/\S+/i)?.[0];

  // The target language is the FINAL "to/into/in <lang>" clause (anchored to end-of-string), so a
  // sentence full of "in"/"to" ("I want to go to the beach to Spanish") no longer grabs the FIRST one
  // as the language (translate-wrong-target-language). `$` (with an optional URL/punct tail) forces the
  // last clause; the language is 1-2 words of letters only. Absent -> English.
  const tail = t.replace(/https?:\/\/\S+\s*$/i, "").trim(); // drop a trailing URL for the target scan
  const tgtMatch = tail.match(/\b(?:in ?to|into|to|in)\s+([a-z]+(?:\s+[a-z]+)?)\s*[:?.!]*\s*$/i);
  const target = (tgtMatch?.[1] ?? "English").trim().replace(/\s+/g, " ") || "English";

  if (url) return { target, url: url.replace(/[.,)]+$/, "") };

  // The text to translate = the request minus the leading verb and the FINAL target clause only.
  let body = tail
    .replace(/^\s*(?:please\s+)?(?:translate|translation of)\s+/i, "")
    .replace(/^\s*how (?:do|would) (?:you|i) say\s+/i, "")
    .replace(/^\s*what(?:'?s| is)\s+/i, "");
  if (tgtMatch) body = body.slice(0, body.length - tgtMatch[0].length); // strip only the matched end clause
  body = body.replace(/^["']|["']$/g, "").replace(/[?]+\s*$/, "").trim().replace(/^["']|["']$/g, "").trim();
  if (!body) return null;
  return { target, text: body };
}

/** Build the LLM messages for a translation. Asks for ONLY the translation (+ a pronunciation line for a
 * short phrase into a non-Latin-script language, like the define tool gives phonetics). Exported. */
export function buildTranslatePrompt(text: string, target: string): { system: string; user: string } {
  return {
    system: "You are a precise translator. Output ONLY the translation — no preamble, no quotes, no notes. If the input is a short phrase and the target language uses a non-Latin script, add a second line 'Pronunciation: <romanization>'.",
    user: `Translate the following into ${target}:\n\n${text}`,
  };
}

const MAX_PAGE_CHARS = 8000; // cap page text handed to the model (a long article, bounded for cost)

/**
 * Translate pasted text or a page into `target`. `llm` does the translation; `scrape` (optional) fetches
 * a URL's readable text. Returns the translated string, or null when there's nothing to translate / the
 * scrape failed / the model returned nothing (caller then falls back or asks). Exported for the tool.
 */
export async function translate(
  req: { target: string; text?: string; url?: string },
  llm: LLMClient,
  scrape?: (url: string) => Promise<{ content: string } | null>,
): Promise<string | null> {
  let source = req.text;
  if (!source && req.url) {
    if (!scrape) return null;
    try {
      const page = await scrape(req.url);
      source = page?.content?.slice(0, MAX_PAGE_CHARS);
    } catch { return null; }
  }
  source = (source ?? "").trim();
  if (!source) return null;
  const { system, user } = buildTranslatePrompt(source, req.target);
  try {
    const res = await llm.complete([{ role: "system", content: system }, { role: "user", content: user }], []);
    const out = (res.text ?? "").trim();
    return out || null;
  } catch { return null; }
}
