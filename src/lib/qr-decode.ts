// Read a QR/barcode from an image (read-qr-from-photo): the symmetric complement to make_qr. Uses the
// keyless api.qrserver.com read endpoint (no signup) — the image bytes are POSTed multipart and the
// decoded payload comes back as JSON. Pure response-parse helper exported + unit-tested; the multipart
// POST is injected so it runs offline.

export function readQrUrl(): string { return "https://api.qrserver.com/v1/read-qr-code/"; }

/** Parse an api.qrserver.com read-qr response into the decoded payload, or null when there's no readable
 * code (the API returns data:null + an error in that case). Shape: [{symbol:[{data,error}]}]. Exported. */
export function parseQrRead(body: string): string | null {
  try {
    const arr = JSON.parse(body) as Array<{ symbol?: Array<{ data?: string | null; error?: string | null }> }>;
    const data = arr?.[0]?.symbol?.[0]?.data;
    return typeof data === "string" && data.length ? data : null;
  } catch { return null; }
}

/**
 * Decode a QR/barcode from image bytes. `postImage` is injected (a guarded multipart POST returning the
 * response text in prod, a fake in tests). Returns the decoded payload, or null when no code is readable
 * / the request fails. Never throws. Exported for the backend wiring.
 */
export async function readQrFromBytes(
  bytes: Uint8Array,
  postImage: (url: string, bytes: Uint8Array) => Promise<string>,
): Promise<string | null> {
  if (!bytes || !bytes.length) return null;
  try {
    return parseQrRead(await postImage(readQrUrl(), bytes));
  } catch { return null; }
}
