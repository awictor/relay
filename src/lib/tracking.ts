// Package tracking (package-tracking-watcher): "where's my package 1Z999..." / "track 9400..." was a
// top errand Relay handled poorly — it browsed a carrier site with no idea which carrier, logged-out.
// This detects the carrier from the tracking-number SHAPE and builds the official public tracking URL,
// so the track_package tool drives anvil (real Chrome, past the simple 403s a keyless GET hits) to the
// right page. Pure detect + URL helpers, exported + unit-tested; the scrape itself is injected in agent.

export type Carrier = "ups" | "fedex" | "usps" | "dhl";

export interface TrackingRef { carrier: Carrier; number: string; }

// Normalize: strip spaces/dashes, uppercase. Tracking numbers are printed with spaces; users paste them.
function norm(raw: string): string {
  return String(raw ?? "").replace(/[\s-]/g, "").toUpperCase();
}

/** Detect the carrier from a tracking number's shape, or null if it doesn't look like one. Ordered so
 * the most-specific patterns win (UPS "1Z", USPS/DHL letter-prefixed) before the generic all-digit
 * lengths that FedEx/USPS/DHL share. Deliberately conservative — a non-match returns null so the agent
 * falls back to asking which carrier rather than guessing wrong. Exported for tests. */
export function detectCarrier(raw: string): Carrier | null {
  const s = norm(raw);
  if (!s) return null;
  // UPS: "1Z" + 16 alphanumerics.
  if (/^1Z[0-9A-Z]{16}$/.test(s)) return "ups";
  // USPS: a 13-char SNN NNNN NNNN US form (e.g. LЗ123456789US) or a 20-22 digit IMpb starting 91/92/93/94/95.
  if (/^[A-Z]{2}\d{9}US$/.test(s)) return "usps";
  if (/^9[0-5]\d{18,20}$/.test(s)) return "usps";
  // DHL Express: 10 digits (also "JJD" + digits for some). Keep before the generic FedEx digit lengths.
  if (/^JJD\d{10,}$/.test(s)) return "dhl";
  if (/^\d{10}$/.test(s)) return "dhl";
  // FedEx: 12, 15, or 20 digits.
  if (/^(\d{12}|\d{15}|\d{20})$/.test(s)) return "fedex";
  return null;
}

const TRACK_URL: Record<Carrier, (n: string) => string> = {
  ups: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  fedex: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  usps: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
  dhl: (n) => `https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id=${encodeURIComponent(n)}`,
};

const CARRIER_NAME: Record<Carrier, string> = { ups: "UPS", fedex: "FedEx", usps: "USPS", dhl: "DHL" };

/** The official public tracking URL for a detected carrier + number. Exported for tests. */
export function trackingUrl(carrier: Carrier, number: string): string {
  return TRACK_URL[carrier](norm(number));
}

/** Human carrier label (UPS/FedEx/USPS/DHL). */
export function carrierName(carrier: Carrier): string {
  return CARRIER_NAME[carrier];
}

/** Parse a free-text tracking request into {carrier, number} or null. Pulls the first token that looks
 * like a tracking number (a run of 10+ alnum with the carrier shape) out of the message — so "where's
 * my package 1Z999AA10123456784" or "track 9400111899223817612345" resolves. If the user names a
 * carrier explicitly ("fedex 123456789012") that overrides shape detection. Exported for tests. */
export function parseTrackingRequest(text: string): TrackingRef | null {
  const t = String(text ?? "");
  const upper = t.toUpperCase();
  // Candidate tokens: a single alnum run (>=10), OR a spaced/dashed run of alnum GROUPS collapsed — a
  // tracking number pasted the way carriers PRINT it ("9400 1118 9922 3817 6123 45", "1Z 999 AA1 ...")
  // must resolve, so match multi-group runs and strip the separators before detecting (parse-tracking-
  // spaced-number). The single-run + 1Z patterns still catch the no-space forms.
  const single = upper.match(/\b[0-9A-Z]{10,}\b|\b1Z[0-9A-Z]{16}\b/g) ?? [];
  // Each group must contain a DIGIT so a leading word ("TRACK", "PACKAGE") isn't swallowed into the run.
  const grouped = (upper.match(/\b(?=[0-9A-Z]*\d)[0-9A-Z]{2,}(?:[ -](?=[0-9A-Z]*\d)[0-9A-Z]{2,}){2,}\b/g) ?? []).map((g) => g.replace(/[ -]/g, ""));
  const tokens = [...new Set([...single, ...grouped])].filter((tok) => tok.length >= 10);
  const explicit = /\bups\b/i.test(t) ? "ups" : /\bfedex\b/i.test(t) ? "fedex" : /\busps\b/i.test(t) ? "usps" : /\bdhl\b/i.test(t) ? "dhl" : null;
  for (const tok of tokens) {
    const c = detectCarrier(tok);
    if (c) return { carrier: (explicit as Carrier) ?? c, number: norm(tok) };
    // A carrier was named but the token's shape is ambiguous (e.g. a 9-digit DHL) — accept it under the
    // named carrier if it's a plausible all-alnum id of reasonable length.
    if (explicit && /^[0-9A-Z]{8,}$/.test(tok)) return { carrier: explicit as Carrier, number: norm(tok) };
  }
  return null;
}
