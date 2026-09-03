// Inline-button callbacks (inline-tap-buttons): proactive pings (alerts/digests/scheduled recipes)
// used to be text dead-ends — the user had to compose a reply to act. This encodes the one-tap
// actions carried in a Telegram inline keyboard's callback_data, and builds the keyboards. Pure +
// offline-testable; the transport (telegram.ts) and routing (handler.ts) consume it.
//
// callback_data is capped by Telegram at 1..64 BYTES. We encode "<op>|<name>" where op is a 2-char
// opcode. If the payload would exceed the cap (a very long watch name), the button is OMITTED rather
// than truncated to a wrong name — a missing button is honest; a button that stops the WRONG watch is not.

export const CALLBACK_MAX_BYTES = 64;

// One inline button (a subset of Telegram's InlineKeyboardButton — text + callback_data only).
export interface InlineButton {
  text: string;
  callback_data: string;
}
// A keyboard is rows of buttons.
export type InlineKeyboard = InlineButton[][];

// The actions a tapped button can carry. `kind` groups by what the payload names.
export type CallbackAction =
  | { kind: "alert"; action: "refresh" | "snooze" | "stop"; name: string }
  | { kind: "digest"; action: "run"; name: string }
  | { kind: "recipe"; action: "run"; name: string }
  // Pick one result from a numbered list the bot just sent (inline-result-picker). Carries the 0-based
  // index into the cached list, not a name — so the payload stays tiny regardless of the item's text.
  | { kind: "pick"; index: number };

// Opcode <-> action for the NAME-carrying actions. 2-char ops keep the payload short so long-ish
// names still fit the 64-byte cap. The pick action (index-carrying) uses opcode "pk" handled separately.
const OP: Record<string, { kind: CallbackAction["kind"]; action: string }> = {
  ar: { kind: "alert", action: "refresh" },
  az: { kind: "alert", action: "snooze" },
  ax: { kind: "alert", action: "stop" },
  dr: { kind: "digest", action: "run" },
  rr: { kind: "recipe", action: "run" },
};
const OP_FOR = new Map<string, string>(
  Object.entries(OP).map(([op, v]) => [`${v.kind}:${v.action}`, op]),
);
const PICK_OP = "pk";

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

/** Encode an action to callback_data, or null if it wouldn't fit Telegram's 64-byte cap (caller omits
 * the button). The name is passed through verbatim (may contain any char except we never split on it
 * again beyond the FIRST delimiter, so a name containing "|" round-trips fine). A pick carries a
 * 0-based index instead of a name. */
export function encodeCallback(a: CallbackAction): string | null {
  const data = a.kind === "pick"
    ? `${PICK_OP}|${a.index}`
    : (() => { const op = OP_FOR.get(`${a.kind}:${a.action}`); return op ? `${op}|${a.name}` : null; })();
  if (data === null) return null;
  return utf8Len(data) <= CALLBACK_MAX_BYTES ? data : null;
}

/** Decode callback_data back to an action, or null if it's unrecognized/malformed (so a stale button
 * from an old deploy, or a spoofed payload, is ignored rather than mis-routed). Splits on the FIRST
 * "|" only, so a name with a "|" survives. A pick decodes its index (rejects a non-integer/negative). */
export function decodeCallback(data: string | undefined | null): CallbackAction | null {
  if (!data) return null;
  const i = data.indexOf("|");
  if (i < 0) return null;
  const op = data.slice(0, i);
  const rest = data.slice(i + 1);
  if (op === PICK_OP) {
    if (!/^\d+$/.test(rest)) return null; // index must be a non-negative integer
    return { kind: "pick", index: Number(rest) };
  }
  const spec = OP[op];
  if (!spec || !rest) return null;
  return { kind: spec.kind, action: spec.action, name: rest } as CallbackAction;
}

/** Buttons for a numbered result list (inline-result-picker): a compact row of "1" "2" "3"… pick
 * buttons, one per result, each carrying its index. Telegram wraps a long row across lines, but cap
 * the count so we don't build an unusable 40-button grid; extra results stay text-only (the message
 * still lists them). Returns undefined for an empty/1-item list (nothing to disambiguate with a tap). */
export function pickButtons(count: number, max = 8): InlineKeyboard | undefined {
  const n = Math.min(count, max);
  if (n < 2) return undefined;
  const row: InlineButton[] = [];
  for (let i = 0; i < n; i++) {
    const data = encodeCallback({ kind: "pick", index: i });
    if (data) row.push({ text: String(i + 1), callback_data: data });
  }
  return row.length ? [row] : undefined;
}

/** Buttons for an ALERT/watch ping: Refresh (re-check now), Snooze 1 day, Stop watching. Any button
 * whose payload overflows the cap is dropped; returns undefined if none fit (so the ping just sends
 * plain). Snooze uses a fixed 1-day step to keep the keyboard one-tap (retune via text as before). */
export function alertButtons(name: string): InlineKeyboard | undefined {
  const row: InlineButton[] = [];
  const refresh = encodeCallback({ kind: "alert", action: "refresh", name });
  const snooze = encodeCallback({ kind: "alert", action: "snooze", name });
  const stop = encodeCallback({ kind: "alert", action: "stop", name });
  if (refresh) row.push({ text: "🔄 Refresh", callback_data: refresh });
  if (snooze) row.push({ text: "💤 Snooze 1d", callback_data: snooze });
  if (stop) row.push({ text: "🔕 Stop", callback_data: stop });
  return row.length ? [row] : undefined;
}

/** Buttons for a DIGEST briefing ping: Run again (re-compose now). Undefined if the name overflows. */
export function digestButtons(name: string): InlineKeyboard | undefined {
  const run = encodeCallback({ kind: "digest", action: "run", name });
  return run ? [[{ text: "🔁 Run again", callback_data: run }]] : undefined;
}

/** Buttons for a scheduled RECIPE ping: Run again (re-run the recipe now). Undefined if name overflows. */
export function recipeButtons(name: string): InlineKeyboard | undefined {
  const run = encodeCallback({ kind: "recipe", action: "run", name });
  return run ? [[{ text: "🔁 Run again", callback_data: run }]] : undefined;
}

/** Given a proactive schedule's task marker ("alert:<name>" / "digest:<name>" / "recipe:<name>"),
 * return the inline keyboard to attach to its ping, or undefined for a plain reminder / unknown marker.
 * Centralizes the marker->keyboard mapping so the runner stays agnostic to the encoding. */
export function buttonsForTask(task: string): InlineKeyboard | undefined {
  const m = task.match(/^(alert|digest|recipe):(.+)$/i);
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase();
  const name = m[2]!.trim();
  if (kind === "alert") return alertButtons(name);
  if (kind === "digest") return digestButtons(name);
  if (kind === "recipe") return recipeButtons(name);
  return undefined;
}
