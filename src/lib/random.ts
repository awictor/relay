// Random / decision helper (random-decision-helper): "flip a coin", "roll a d20", "pick one: tacos or
// sushi", "random number 1-100" are classic first-errand test messages. Without a tool they spun a slow
// browser run OR the LLM emitted a non-random "random" value that isn't trustworthy. This parses the ask
// + produces a genuinely-random answer. Pure: the RNG is injected (Math.random in prod, seeded in tests)
// so parsing/formatting is deterministic to test; only the number generation varies.

export type RandomRequest =
  | { kind: "coin" }
  | { kind: "dice"; count: number; sides: number }
  | { kind: "number"; min: number; max: number }
  | { kind: "pick"; options: string[] }
  | { kind: "uuid" };

/**
 * Parse a message into a random-decision request, or null if it isn't one. Handles:
 *   coin: "flip a coin", "heads or tails", "coin flip"
 *   dice: "roll a d20", "roll 2d6", "roll a die/dice"
 *   number: "random number 1-100", "pick a number between 1 and 10", "random number up to 50"
 *   pick: "pick one: a, b, c", "choose between tacos and sushi", "a or b or c" (>=2 options)
 * Deliberately anchored so an ordinary message ("a coin costs a dollar") isn't hijacked. Exported for tests.
 */
export function parseRandomRequest(text: string): RandomRequest | null {
  const t = text.trim().toLowerCase();

  // UUID — "generate a uuid", "random uuid", "give me a guid", "uuid v4". A convenience identifier (a
  // v4 from the injected PRNG); not a credential, so it doesn't need crypto RNG like generate_password.
  if (/\b(uuid|guid)\b/.test(t)) return { kind: "uuid" };

  // Coin — "flip a coin", "coin flip", "heads or tails", "toss a coin".
  if (/\b(flip|toss)\s+(a\s+)?coin\b|\bcoin\s+(flip|toss)\b|\bheads\s+or\s+tails\b/.test(t)) return { kind: "coin" };

  // Dice — "roll a d20", "roll 2d6", "roll a die", "roll dice", "roll two dice", "roll 3 dice" (bare count
  // + dice, no dNN, defaults to d6 — random-roll-n-dice).
  const nDice = t.match(/\broll\s+(\d+)\s+(?:dice|die|d6s?)\b/);
  const dice = t.match(/\broll\s+(?:a\s+)?(?:(\d+)\s*)?d\s?(\d+)\b/)
    || (nDice ? ["", nDice[1]!, "6"] as unknown as RegExpMatchArray : null)
    || (/\broll\s+(?:a\s+)?(dice|die)\b/.test(t) ? ["", "1", "6"] as unknown as RegExpMatchArray : null);
  if (dice) {
    const count = Math.min(20, Math.max(1, parseInt(dice[1] || "1", 10) || 1)); // cap 20 dice
    const sides = Math.min(1000, Math.max(2, parseInt(dice[2] || "6", 10) || 6));
    return { kind: "dice", count, sides };
  }

  // Number — "random number 1-100", "between 1 and 10", "a number from 1 to 6", "up to 50".
  const between = t.match(/\bnumber\b.*?\b(\d+)\s*(?:-|to|and|through)\s*(\d+)\b/) || t.match(/\bbetween\s+(\d+)\s+and\s+(\d+)\b/) || t.match(/\bfrom\s+(\d+)\s+to\s+(\d+)\b/)
    // "random 1 to 6" / "random 1-100" — "random" + a bare range, no "number" word (random-bare-range).
    || (/\brandom\b/.test(t) ? t.match(/\brandom\s+(\d+)\s*(?:-|to|and|through)\s*(\d+)\b/) : null);
  if (between && /\b(random|number|pick|choose|roll)\b/.test(t)) {
    let min = parseInt(between[1]!, 10), max = parseInt(between[2]!, 10);
    if (min > max) [min, max] = [max, min];
    return { kind: "number", min, max };
  }
  const upto = t.match(/\brandom\s+number\b.*?\b(?:up\s+to|below|under|max)\s+(\d+)\b/) || t.match(/\brandom\s+number\s+(\d+)\b/);
  if (upto) return { kind: "number", min: 1, max: Math.max(1, parseInt(upto[1]!, 10)) };
  if (/\brandom\s+number\b/.test(t)) return { kind: "number", min: 1, max: 100 }; // bare "random number" -> 1-100

  // Pick — "pick one: a, b, c" / "choose between a and b" / "should I do a or b". Needs >=2 options.
  const pickLead = t.match(/\b(?:pick|choose|decide|select)\b(?:\s+(?:one|for me|between|from|among))?\s*:?\s*(.+)$/)
    || t.match(/\b(?:should i|which)\b[^:]*?:\s*(.+)$/);
  if (pickLead) {
    const opts = splitOptions(pickLead[1]!);
    if (opts.length >= 2) return { kind: "pick", options: opts };
  }
  // Bare "a or b (or c)" with no lead-in verb — only when it's SHORT + clearly a choice (each side <=4 words).
  const orChoice = text.trim().match(/^(.+?\s+or\s+.+)$/i);
  if (orChoice && /\bor\b/i.test(orChoice[1]!)) {
    const opts = splitOptions(orChoice[1]!);
    if (opts.length >= 2 && opts.length <= 6 && opts.every((o) => o.split(/\s+/).length <= 4)) return { kind: "pick", options: opts };
  }
  return null;
}

/** Split a choice tail into options on commas / "or" / "vs". Trims + drops empties. Exported for tests. */
export function splitOptions(s: string): string[] {
  return s
    .split(/\s*,\s*|\s+or\s+|\s+and\s+|\s+vs\.?\s+/i)
    .map((o) => o.replace(/[?.!]+$/, "").trim())
    .filter(Boolean);
}

/**
 * Produce the answer for a random request. `rand` is injected (Math.random in prod, a fake in tests) and
 * returns a float in [0,1). Deterministic given `rand`. Exported for tests.
 */
export function runRandom(req: RandomRequest, rand: () => number = Math.random): string {
  const pick = <T>(arr: T[]): T => arr[Math.min(arr.length - 1, Math.floor(rand() * arr.length))]!;
  switch (req.kind) {
    case "coin":
      return `🪙 ${pick(["Heads", "Tails"])}`;
    case "dice": {
      const rolls = Array.from({ length: req.count }, () => 1 + Math.floor(rand() * req.sides));
      const total = rolls.reduce((a, b) => a + b, 0);
      const die = `d${req.sides}`;
      if (req.count === 1) return `🎲 ${rolls[0]} (${die})`;
      return `🎲 ${rolls.join(" + ")} = ${total} (${req.count}${die})`;
    }
    case "number": {
      const n = req.min + Math.floor(rand() * (req.max - req.min + 1));
      return `🔢 ${n} (${req.min}–${req.max})`;
    }
    case "pick":
      return `👉 ${pick(req.options)}`;
    case "uuid": {
      // RFC-4122 v4: 32 hex digits, version nibble = 4, variant nibble ∈ {8,9,a,b}. Built from the
      // injected rand() so it's deterministic in tests (a convenience id, not a security token).
      const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
      const variant = (8 + Math.floor(rand() * 4)).toString(16); // 8/9/a/b
      return `🆔 ${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
    }
  }
}
