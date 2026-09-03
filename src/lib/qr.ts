// QR codes (qr-code-tool): "make a QR code for this link / my wifi / this text" was a floundering browse
// or a refusal, though the sendPhoto image channel is already wired. This builds a QR PNG from the keyless
// api.qrserver.com renderer (no signup) and returns the bytes for the existing photo-send path — instant,
// high-delight proof the bot does real work. Pure payload+URL helpers exported + unit-tested; the PNG
// fetch is injected so it runs offline.

const MAX_QR_LEN = 900; // api.qrserver.com caps ~900 chars; keep payloads phone-scannable anyway

/** Extract the QR payload from a free-text request, or null if there's nothing to encode.
 *   "make a QR code for https://x.com"      -> "https://x.com"
 *   "qr code for the text hello world"      -> "hello world"
 *   "generate a qr for WIFI:S:home;T:WPA;P:pw;;"  -> passthrough
 * Strips the leading "make/generate a QR (code) for/of" scaffold + surrounding quotes. Exported. */
export function parseQrRequest(text: string): string | null {
  const t = text.trim();
  if (!/\bqr\b/i.test(t) && !/\bqr[\s-]?code\b/i.test(t)) return null;
  // Take everything after the LAST "qr[ code]" token, then peel a leading connective (for/of/:/with).
  const m = t.match(/\bqr(?:[\s-]?code)?\b(.*)$/i);
  if (!m) return null;
  let payload = m[1] ?? "";
  payload = payload.replace(/^\s*(?:for|of|with|is|:|=|,|-)\s*/i, ""); // strip a single lead-in connective
  // Drop a trailing "please" + surrounding quotes/whitespace. Keep the payload otherwise verbatim
  // (URLs, WIFI: strings, arbitrary text all encode as-is).
  payload = payload.replace(/\s+please\s*$/i, "").trim().replace(/^["'`]|["'`]$/g, "").trim();
  // A payload that's only a leftover connective/filler word is not real content -> null.
  if (!payload || /^(?:for|of|with|please|code|it|this|that)$/i.test(payload)) return null;
  if (payload.length > MAX_QR_LEN) return null; // too big to encode cleanly
  return payload;
}

/** Build a keyless QR PNG URL for a payload (api.qrserver.com, no signup). `size` px square. Exported. */
export function qrUrl(payload: string, size = 300): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=8&data=${encodeURIComponent(payload)}`;
}

/**
 * Render a QR payload to a PNG. `fetchBytes` is injected (a guarded GET returning bytes in prod, a fake in
 * tests). Returns the PNG bytes, or null when the payload is empty/too long or the fetch fails / returns a
 * non-PNG (caller falls back). Never throws. Exported for the backend wiring.
 */
export async function renderQr(
  payload: string,
  fetchBytes: (url: string) => Promise<Uint8Array>,
): Promise<Uint8Array | null> {
  if (!payload || payload.length > MAX_QR_LEN) return null;
  try {
    const bytes = await fetchBytes(qrUrl(payload));
    // A valid PNG starts with the 8-byte signature; anything else (an error page) -> null.
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return bytes;
    return null;
  } catch { return null; }
}
