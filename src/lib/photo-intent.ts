// Photo-to-action (photo-to-action): decide whether a photo's caption asks Relay to DO something with
// the image's content (split a receipt, convert prices, translate a menu, look up an item) — in which
// case the image is transcribed by vision and the caption runs through the AGENT so it chains into
// calculate/convert/translate — versus a plain "what is this?" that the one-shot vision describe handles.
// Pure + unit-tested.

// Verbs/phrases that mean "act on the content", not just "describe it". Deliberately broad on the
// action side (math, money, translation, lookup, extraction) but a plain describe/identify stays false.
const ACTION_RE = /\b(split|divide|add up|sum|total|tally|calculate|compute|how much|what'?s the total|tip|per person|each owe|convert|in (?:usd|eur|gbp|dollars|euros|pounds|celsius|fahrenheit|km|miles|kg|lbs)|translate|in (?:english|spanish|french|german|italian|japanese|chinese|korean)|how do you say|cheapest|most expensive|which .* (?:cheap|health|vegan|vegetarian|gluten)|find|look up|search|price of|is (?:it|this) (?:safe|expired|vegan|gluten|halal|kosher)|calories|carbs|nutrition|reply to|respond to|draft|what should i)\b/i;

// A plain "describe / identify" ask — even if it contains a word the action regex might catch — should
// stay one-shot. Kept narrow so it doesn't swallow genuine action captions.
const DESCRIBE_ONLY_RE = /^\s*(what(?:'?s| is| are)?(?: this| that| these| in (?:this|the) (?:photo|image|picture))?|describe|identify|caption|what do you see|read this|what does (?:this|it) say)\s*[?.!]*\s*$/i;

/** True if a photo caption should route through the agent (chain into tools) rather than a one-shot
 * vision describe. Empty/whitespace captions are NOT actionable (no request to fulfill). Exported. */
export function photoNeedsAgent(caption: string): boolean {
  const c = caption.trim();
  if (!c) return false;
  if (DESCRIBE_ONLY_RE.test(c)) return false;
  return ACTION_RE.test(c);
}

// A caption asking to DECODE a QR/barcode in the photo (read-qr-from-photo) — routed to a keyless QR
// decoder, not the vision describe (which can't reliably read the payload). Also fires on a bare photo
// (empty caption) only via the caller's own heuristic; here we key on explicit scan/QR/barcode words.
const QR_SCAN_RE = /\b(scan|read|decode|what'?s in|open|follow)\b[^.]*\b(qr|qr[\s-]?code|barcode|bar[\s-]?code|code)\b|\b(qr|qr[\s-]?code|barcode|bar[\s-]?code)\b[^.]*\?|^\s*(scan|read|decode)\s+(this|it)\s*[?.!]*\s*$/i;

/** True if a photo caption asks to scan/decode a QR or barcode. Exported. */
export function photoIsQrScan(caption: string): boolean {
  const c = caption.trim();
  if (!c) return false;
  return QR_SCAN_RE.test(c);
}
