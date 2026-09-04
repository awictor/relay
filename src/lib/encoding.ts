// Encode/decode helper (encode-decode-tool): "base64 encode hello", "decode this base64 aGVsbG8=",
// "url-encode my query", "what's this JWT payload" are common developer/utility text-a-bot asks with no
// tool — they fell to a slow browse or the LLM hand-computing an encoding (often WRONG, especially for
// base64 padding / multi-byte UTF-8). This does it exactly + deterministically. Pure (no I/O); the codecs
// are Node Buffer / global encodeURIComponent. Pairs with make_qr / save_page. Exported for tests.

import { createHash } from "node:crypto";

export type EncOp =
  | { op: "encode"; codec: "base64" | "base64url" | "url" | "hex" | "rot13" | "binary" | "morse" }
  | { op: "decode"; codec: "base64" | "base64url" | "url" | "hex" | "jwt" | "rot13" | "binary" | "morse" }
  // Hashing is ONE-WAY (encode-hash-rot13): sha256/sha1/md5 produce a hex digest; there is no decode.
  | { op: "encode"; codec: "sha256" | "sha1" | "md5" };

// The one-way hash codecs — a "decode" request for these is nonsensical (a hash can't be reversed) and
// gets a friendly refusal rather than a wrong answer.
const HASH_CODECS = new Set(["sha256", "sha1", "md5"]);

/**
 * Parse an encode/decode request into {op, codec, text}, or null if it isn't one. Handles:
 *   "base64 encode hello world"      -> encode base64
 *   "decode this base64: aGVsbG8="   -> decode base64
 *   "url encode a b&c"               -> encode url
 *   "hex encode hi" / "decode hex 6869"
 *   "decode this jwt <token>"        -> decode jwt (payload only; never verifies a signature)
 * The verb (encode/decode) + a codec word are required so ordinary chat isn't hijacked. The PAYLOAD is
 * everything after the codec/colon, taken verbatim (an encoding is whitespace/case-sensitive). Exported.
 */
export function parseEncodingRequest(text: string): (EncOp & { text: string }) | null {
  const raw = String(text ?? "");
  const t = raw.trim();
  const lower = t.toLowerCase();
  if (!/\b(base64url|base64|b64|url[- ]?encode|url[- ]?decode|urlencode|urldecode|hex|jwt|sha-?256|sha-?1|md5|hash|rot-?13|binary|morse|encode|decode)\b/.test(lower)) return null;

  // Morse: "morse code SOS" / "SOS in morse" / "decode morse ... -.-." — text <-> morse. Payload on
  // either side of the keyword, like binary. Decode inferred when the payload is only dots/dashes/spaces
  // (encode-morse). Handled here so the generic codec path stays untouched.
  if (/\bmorse\b/.test(lower) && !/\b(base64|b64|hex|url|jwt|sha|md5|rot|binary)/.test(lower)) {
    let payload = "";
    const before = raw.match(/^(.*?)\s+(?:in|to|as|into)\s+morse\b/i);
    if (before && before[1]!.trim()) payload = before[1]!.trim();
    else {
      const colon = raw.indexOf(":");
      const after = colon >= 0 ? raw.slice(colon + 1) : raw;
      payload = after.replace(/^\s*(?:please\s+)?(?:can\s+you\s+)?/i, "");
      let prev = "";
      while (prev !== payload) { prev = payload; payload = payload.replace(/^\s*(?:decode|encode|convert|the|this|that|a|of|to|from|in|into|as|text|letters|words|code|morse)\b[\s:]*/i, ""); }
    }
    payload = payload.trim().replace(/^["'`]|["'`]$/g, "").trim();
    if (!payload) return null;
    const looksMorse = /^[.\-/\s]+$/.test(payload) && /[.\-]/.test(payload);
    const wantsDecode = looksMorse || /\bto\s+(?:text|letters|words|english)\b/i.test(lower);
    return { op: wantsDecode ? "decode" : "encode", codec: "morse", text: payload } as EncOp & { text: string };
  }

  // Decode a JWT — "decode this jwt <token>" / "what's in this jwt <token>". Payload only, no verify.
  const jwt = t.match(/\b(?:jwt|token)\b[\s:]*([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)/);
  if (jwt && /\b(decode|read|what'?s|whats|inside|payload)\b/i.test(lower)) return { op: "decode", codec: "jwt", text: jwt[1]! };

  // A hash request ("sha256 of X", "md5 hash of Y", "hash this with sha1"). Hashing is one-way — always
  // an "encode" op; a "decode/reverse a hash" ask is caught in runEncoding with a friendly refusal.
  const hashCodec: "sha256" | "sha1" | "md5" | null =
    /\bsha-?256\b/.test(lower) ? "sha256"
    : /\bsha-?1\b/.test(lower) ? "sha1"
    : /\bmd5\b/.test(lower) ? "md5"
    : null;
  if (hashCodec) {
    const payload = extractPayload(raw, lower);
    if (!payload) return null;
    // "decode/reverse this sha256" is nonsense — mark it decode so runEncoding refuses honestly.
    const wantsReverse = /\b(decode|reverse|crack|unhash)\b/i.test(lower);
    return { op: wantsReverse ? "decode" : "encode", codec: hashCodec, text: payload } as EncOp & { text: string };
  }

  const isDecode = /\bdecode|decrypt|unescape|from\s+(?:base64|hex)\b/i.test(lower) && !/\bencode\b/i.test(lower);
  const op: "encode" | "decode" = isDecode ? "decode" : "encode";

  // codec: base64url before base64; url; hex; rot13. Default base64 when only encode/decode is named.
  // Binary is handled before the generic codec path because its natural phrasing puts the payload on
  // EITHER side of the keyword ("binary of hi", "hi in binary", "decode this binary 0110...") and the
  // op is inferred from the payload shape (all 0/1 -> decode to text) rather than an explicit "decode"
  // word a casual user won't type (encode-binary-text).
  if (/\bbinary\b/.test(lower) && !/\b(base64|b64|hex|url|jwt|sha|md5|rot)/.test(lower)) {
    // Extract the payload from any of binary's natural phrasings:
    //   "hello in binary"        -> text BEFORE "in binary"
    //   "binary of hi" / "binary <payload>" / "decode this binary 0110..." -> text AFTER the last of
    //   the leading keywords (binary/of/decode/this/to/text/a colon).
    let payload = "";
    const before = raw.match(/^(.*?)\s+(?:in|to|as|into)\s+binary\b/i);
    if (before && before[1]!.trim()) {
      payload = before[1]!.trim();
    } else {
      const colon = raw.indexOf(":");
      const afterColon = colon >= 0 ? raw.slice(colon + 1) : raw;
      // drop a leading run of connective keywords ("decode this binary of", "binary to text")
      payload = afterColon.replace(/^\s*(?:please\s+)?(?:can\s+you\s+)?(?:decode|encode|convert|the|this|that|a|of|to|from|in|into|as|text|ascii|letters|words|binary)\b[\s:]*/gi, "");
      // keep stripping stacked keywords until stable
      let prev = "";
      while (prev !== payload) { prev = payload; payload = payload.replace(/^\s*(?:decode|encode|of|to|from|in|into|as|text|ascii|letters|words|binary|this|that|the)\b[\s:]*/i, ""); }
    }
    payload = payload.trim().replace(/^["'`]|["'`]$/g, "").trim();
    if (!payload) return null;
    const looksBinary = /^[01\s]+$/.test(payload) && /[01]{4,}/.test(payload.replace(/\s/g, ""));
    const wantsDecode = looksBinary || /\bto\s+(?:text|ascii|letters|words)\b/i.test(lower);
    return { op: wantsDecode ? "decode" : "encode", codec: "binary", text: payload } as EncOp & { text: string };
  }

  const codec: EncOp["codec"] =
    /\bbase64url\b/.test(lower) ? "base64url"
    : /\b(base64|b64)\b/.test(lower) ? "base64"
    : /\brot-?13\b/.test(lower) ? "rot13"
    : /\burl\b/.test(lower) ? "url"
    : /\bhex\b/.test(lower) ? "hex"
    : "base64";

  // Payload = text after the LAST codec/verb keyword or a colon. An encoding is exact, so we take it
  // verbatim (only trimming surrounding whitespace + a wrapping pair of quotes/backticks).
  const payload = extractPayload(raw, lower);
  if (!payload) return null;
  return { op, codec, text: payload } as EncOp & { text: string };
}

// Everything after a colon, else after the last recognized keyword. Trims surrounding quotes/backticks.
function extractPayload(raw: string, lower: string): string {
  const colon = raw.indexOf(":");
  let body: string;
  if (colon >= 0 && colon < raw.length - 1) {
    body = raw.slice(colon + 1);
  } else {
    // find the last keyword occurrence in the lowercased string, take the rest of the RAW string after it.
    const kw = [...lower.matchAll(/\b(base64url|base64|b64|urlencode|urldecode|url|hex|jwt|sha-?256|sha-?1|md5|hash(?:ed)?|rot-?13|of|with|encode|decode|encoded|decoded)\b/g)];
    const last = kw[kw.length - 1];
    body = last ? raw.slice(last.index! + last[0].length) : "";
  }
  return body.trim().replace(/^["'`]|["'`]$/g, "").trim();
}

/**
 * Run the encode/decode. Deterministic + pure. Returns the result string, or throws a friendly Error the
 * tool surfaces (bad base64/hex/jwt). Uses Node Buffer + global URI codecs. Exported for tests.
 */
export function runEncoding(req: EncOp & { text: string }): string {
  const { op, codec, text } = req;
  // One-way hashes (encode-hash-rot13): no reverse. A "decode/reverse a hash" ask gets a friendly
  // refusal instead of a made-up answer.
  if (HASH_CODECS.has(codec)) {
    if (op === "decode") throw new Error(`${codec} is a one-way hash — it can't be decoded or reversed. I can hash text FOR you, not un-hash it.`);
    return createHash(codec).update(text, "utf8").digest("hex");
  }
  if (op === "encode") {
    switch (codec) {
      case "base64": return Buffer.from(text, "utf8").toString("base64");
      case "base64url": return Buffer.from(text, "utf8").toString("base64url");
      case "url": return encodeURIComponent(text);
      case "hex": return Buffer.from(text, "utf8").toString("hex");
      case "rot13": return rot13(text);
      case "binary": return [...Buffer.from(text, "utf8")].map((b) => b.toString(2).padStart(8, "0")).join(" ");
      case "morse": return toMorse(text);
    }
  }
  // decode
  switch (codec) {
    case "rot13": return rot13(text); // rot13 is its own inverse
    case "morse": return fromMorse(text);
    case "binary": {
      const bits = text.replace(/[^01]/g, "");
      if (!bits || bits.length % 8 !== 0) throw new Error("That isn't valid binary (need 8-bit bytes, e.g. 01001000 01101001).");
      const bytes: number[] = [];
      for (let k = 0; k < bits.length; k += 8) bytes.push(parseInt(bits.slice(k, k + 8), 2));
      return Buffer.from(bytes).toString("utf8");
    }
    case "base64":
    case "base64url": {
      const out = Buffer.from(text, codec === "base64url" ? "base64url" : "base64").toString("utf8");
      // Reject garbage: re-encoding must round-trip (Buffer is lenient + would silently drop bad chars).
      const reenc = Buffer.from(out, "utf8").toString(codec === "base64url" ? "base64url" : "base64");
      if (!roughlyEqualB64(reenc, text)) throw new Error(`That doesn't look like valid ${codec}.`);
      return out;
    }
    case "url":
      try { return decodeURIComponent(text.replace(/\+/g, " ")); }
      catch { throw new Error("That isn't valid URL-encoded text (a stray % or bad %XX)."); }
    case "hex": {
      const clean = text.replace(/\s+/g, "");
      if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) throw new Error("That isn't valid hex (need pairs of 0-9/a-f).");
      return Buffer.from(clean, "hex").toString("utf8");
    }
    case "jwt": {
      const parts = text.split(".");
      if (parts.length < 2) throw new Error("That isn't a JWT (need header.payload.signature).");
      let payload: string;
      try { payload = Buffer.from(parts[1]!, "base64url").toString("utf8"); }
      catch { throw new Error("Couldn't decode the JWT payload."); }
      try { return JSON.stringify(JSON.parse(payload), null, 2); }
      catch { return payload; } // not JSON — return raw
    }
  }
  // Unreachable in practice (hash codecs handled above; every other codec has a case) — satisfies the
  // exhaustiveness check now that the codec union is wider.
  throw new Error(`I can't ${op} with ${codec}.`);
}

// Morse code table (encode-morse): A-Z, 0-9, and a few common punctuation. Letters space-separated,
// words separated by "/" on encode; decode tolerates any whitespace between letters + "/" or multiple
// spaces between words.
const MORSE: Record<string, string> = {
  a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.", h: "....", i: "..", j: ".---",
  k: "-.-", l: ".-..", m: "--", n: "-.", o: "---", p: ".--.", q: "--.-", r: ".-.", s: "...", t: "-",
  u: "..-", v: "...-", w: ".--", x: "-..-", y: "-.--", z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....",
  "6": "-....", "7": "--...", "8": "---..", "9": "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--", "/": "-..-.",
  "(": "-.--.", ")": "-.--.-", "&": ".-...", ":": "---...", ";": "-.-.-.", "=": "-...-",
  "+": ".-.-.", "-": "-....-", "_": "..--.-", '"': ".-..-.", "@": ".--.-.", " ": "/",
};
const MORSE_REV: Record<string, string> = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

function toMorse(s: string): string {
  const out: string[] = [];
  for (const ch of s.toLowerCase()) {
    if (ch === " ") { out.push("/"); continue; }
    const code = MORSE[ch];
    if (code === undefined) throw new Error(`I can't Morse-encode "${ch}" (letters, digits, and basic punctuation only).`);
    out.push(code);
  }
  return out.join(" ");
}
function fromMorse(s: string): string {
  // Words split on "/" (or 3+ spaces); letters split on whitespace.
  const words = s.trim().split(/\s*\/\s*|\s{3,}/);
  const decoded = words.map((w) => w.trim().split(/\s+/).filter(Boolean).map((sym) => {
    const ch = MORSE_REV[sym];
    if (ch === undefined) throw new Error(`"${sym}" isn't valid Morse.`);
    return ch;
  }).join(""));
  return decoded.join(" ");
}

// ROT13: shift each ASCII letter by 13 (its own inverse). Non-letters pass through. Pure.
function rot13(s: string): string {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

// base64 comparison ignoring padding + url/standard alphabet differences (so a decode-validity check
// doesn't false-negative on a caller that dropped "=" padding or used the url alphabet).
function roughlyEqualB64(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  return norm(a) === norm(b);
}

/** The user-facing reply: the result in a copy-friendly code span + a one-line label. Exported. */
export function formatEncoding(req: EncOp & { text: string }, result: string): string {
  const label = HASH_CODECS.has(req.codec) ? `${req.codec} hash`
    : req.op === "encode" ? `${req.codec} encoded`
    : `${req.codec === "jwt" ? "JWT payload" : req.codec + " decoded"}`;
  const note = req.codec === "jwt" ? "\n\n(Payload only — I don't verify the signature, so don't trust it as authentic on my say-so.)" : "";
  return `${label}:\n\n\`${result}\`${note}`;
}
