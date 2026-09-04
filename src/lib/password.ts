// Password / passphrase generator (password-generator): "generate a strong password", "make me a 20
// character password", "a passphrase" is a classic everyday text-a-bot ask that had no tool — it fell to
// a slow browser run OR (worse) the LLM inventing a "random" string that ISN'T cryptographically random,
// which is dangerous for a credential. This produces a genuinely-random secret with crypto RNG. Pure aside
// from the injected randomness: parsing/assembly is deterministic to test; the byte source is injected
// (Node crypto in prod, a fake in tests). Relay drafts it for the USER to copy — it never stores it.

export interface PasswordRequest {
  kind: "password" | "passphrase";
  length: number;   // password: char count; passphrase: word count
  symbols: boolean;  // password only: include punctuation
  digits: boolean;   // password only: include digits
}

const PW_MIN = 8, PW_MAX = 128, PW_DEFAULT = 20;
const PP_MIN = 3, PP_MAX = 12, PP_DEFAULT = 5;

/**
 * Parse a password/passphrase request, or null if it isn't one. Handles:
 *   "generate a password", "make me a strong password", "new password"
 *   "24 character password", "password with 32 chars", "password, 16 characters"
 *   "password no symbols", "password without special characters", "letters and numbers only"
 *   "passphrase", "a 6 word passphrase", "memorable password" (-> passphrase)
 * Anchored on an explicit password/passphrase noun + a generate-ish intent so "what's my wifi password"
 * (a recall, not a generate) and "reset password" (a task) don't hijack. Exported for tests.
 */
export function parsePasswordRequest(text: string): PasswordRequest | null {
  const t = text.trim().toLowerCase();
  // Must mention password/passphrase/passcode/pin. Bail early otherwise.
  if (!/\b(pass(?:word|phrase|code)|pwd|pin)\b/.test(t)) return null;
  // NOT a generate ask: "what's my password", "reset/change/forgot my password", "is the password" —
  // these are recall/tasks, not "make me one". Require a create-ish verb OR a bare noun-led ask.
  if (/\b(what'?s|whats|what\s+is|reset|change|forgot|forgotten|recover|find|remember|my\s+wifi)\b/.test(t)
      && !/\b(generate|create|make|new|need|give|suggest|random|strong|secure)\b/.test(t)) return null;

  const passphrase = /\bpass\s?phrase\b/.test(t) || /\b(memorable|word[- ]based|xkcd|diceware)\b/.test(t);

  if (passphrase) {
    const words = t.match(/\b(\d+)\s*(?:[- ]?word)\b/) || t.match(/\bpassphrase\s+(?:of\s+)?(\d+)\b/);
    const length = clamp(words ? parseInt(words[1]!, 10) : PP_DEFAULT, PP_MIN, PP_MAX);
    return { kind: "passphrase", length, symbols: false, digits: true };
  }

  // char length: "24 character", "32 chars", "of 16", "16-character", "length 20"
  const lenM = t.match(/\b(\d+)\s*[- ]?(?:char(?:acter)?s?|long|digits?)\b/)
    || t.match(/\b(?:of|length|with)\s+(\d+)\b/)
    || t.match(/\bpass(?:word|code)\s+(\d+)\b/);
  const rawLen = lenM ? parseInt(lenM[1]!, 10) : NaN;
  // symbols off when the user says "no symbols / no special / letters and numbers only / alphanumeric".
  const symbols = !(/\bno\s+(?:symbols?|special|punctuation)\b/.test(t)
    || /\b(?:letters?\s+and\s+numbers?|alphanumeric|no\s+special\s+char)\b/.test(t));
  // a PIN or "numbers only / digits only" -> digits-only (no letters, no symbols). A PIN uses its OWN
  // shorter bounds (4-32, default 6) — NOT the password min of 8 (a "6 digit pin" must stay 6).
  const digitsOnly = /\bpin\b/.test(t) || /\b(?:numbers?|digits?)\s+only\b/.test(t) || /\bonly\s+(?:numbers?|digits?)\b/.test(t);
  if (digitsOnly) return { kind: "password", length: clamp(Number.isFinite(rawLen) ? rawLen : 6, 4, 32), symbols: false, digits: true };
  return { kind: "password", length: clamp(Number.isFinite(rawLen) ? rawLen : PW_DEFAULT, PW_MIN, PW_MAX), symbols, digits: true };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

// A short, unambiguous word list for passphrases (no lookalike/offensive words; 3-6 letters). Kept small
// + inline (free, no download); ~140 words -> ~7.1 bits/word, so a 5-word phrase ≈ 35 bits before digits.
// Not a full diceware list — enough entropy for a memorable secret the user can strengthen by adding words.
const WORDS = (
  "able acid aqua arch army atom aunt bake bard barn beam bean bear beat bell belt bird blue boat bold bone book " +
  "boss brave brick broom camp cane cape cart cash cave cedar chef chin claw clay cliff cloud clover coal coin cook " +
  "coral cork corn cove crab crane crow cube cup dawn deer desk dice dock dove drum duck dune dusk east echo edge " +
  "elk ember fern fig fire fish flag flame fox frog gate gem gift glow gold hawk hazel herb hill iris ivory jade " +
  "jazz kelp kite lake lamp leaf lime lion lotus loud lynx maple mint mist moon moss nest oak oat onyx opal owl " +
  "palm peak pear pine plum pond quartz quill rain reed reef ripe river rock rose ruby sage sail salt sand seal " +
  "shell silk snow sock spark stone storm swan tide tiger toad tulip vine wave wheat wolf wren yarn zebra"
).split(/\s+/).filter(Boolean);

/** Number of distinct words in the passphrase list (exported so a test can assert entropy assumptions). */
export const PASSPHRASE_WORDS = WORDS.length;

const LOWER = "abcdefghijkmnpqrstuvwxyz";   // no l/o (lookalikes)
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";   // no I/O
const DIGITS = "23456789";                   // no 0/1 (lookalikes)
const SYMBOLS = "!@#$%^&*-_+=?";

/**
 * Generate the secret for a request. `randByte` is injected — a function returning an unbiased integer in
 * [0, n) (crypto.randomInt in prod, a fake in tests). Deterministic given `randByte`; the ONLY randomness
 * source, so no Math.random leaks into a credential. Guarantees at least one of each enabled class for a
 * password (so a length-20 "with symbols" always actually contains a symbol). Exported for tests.
 */
export function generateSecret(req: PasswordRequest, randInt: (n: number) => number): string {
  if (req.kind === "passphrase") {
    const words = Array.from({ length: req.length }, () => WORDS[randInt(WORDS.length)]!);
    // Append 2 digits so a passphrase satisfies "must contain a number" rules without hurting memorability.
    const tail = req.digits ? String(10 + randInt(90)) : "";
    return words.map(cap).join("-") + (tail ? "-" + tail : "");
  }
  // Build the allowed alphabet, tracking each class so we can guarantee coverage.
  const classes: string[] = [LOWER, UPPER];
  if (req.digits) classes.push(DIGITS);
  if (req.symbols) classes.push(SYMBOLS);
  const all = classes.join("");
  const out: string[] = [];
  // Seed one char from each class first (coverage), then fill the rest from the full alphabet.
  for (const cls of classes) out.push(cls[randInt(cls.length)]!);
  while (out.length < req.length) out.push(all[randInt(all.length)]!);
  // Shuffle so the guaranteed class chars aren't always in front (Fisher–Yates with the injected source).
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.slice(0, req.length).join("");
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/** The user-facing reply for a generated secret: the secret in a copy-friendly code span + a short note.
 * Relay never stores it — this is a draft for the user to copy into their own password manager. Exported. */
export function formatSecret(req: PasswordRequest, secret: string): string {
  const kind = req.kind === "passphrase" ? "passphrase" : "password";
  return `🔐 Here's a random ${kind}:\n\n\`${secret}\`\n\nCopy it into your password manager — I don't store it, and I can't see it again after this message. Ask for another if you'd like a different one.`;
}
