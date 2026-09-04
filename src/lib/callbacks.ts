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
  | { kind: "pick"; index: number }
  // Run a canned first-errand example from the onboarding buttons (onboarding-tap-to-try). Carries the
  // 0-based index into the fixed TRY_EXAMPLES list so the payload is tiny + stable.
  | { kind: "try"; index: number }
  // Turn the last answer into a recurring automation with one tap (tap-to-watch-on-answers). No payload
  // beyond the mode — the handler resolves the actual task text from the chat's cached last answer, so
  // the callback_data stays tiny regardless of how long the task was. "daily" = every-morning schedule;
  // "watch" = a value/change watch.
  | { kind: "act"; mode: "daily" | "watch" }
  // Install a starter automation from the /templates gallery with one tap (starter-automation-gallery).
  // Carries the template id (short + stable), which the handler resolves to a recipe + installs.
  | { kind: "install"; id: string };

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
const TRY_OP = "ty";
const ACT_DAILY = "ad";
const ACT_WATCH = "aw";
const INSTALL_OP = "in";

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

// The canned first-errand examples offered as tap-to-try buttons on onboarding (onboarding-tap-to-try).
// A tap runs the text through the normal handler flow, so a brand-new user gets an instant first
// success instead of reading the START wall and hand-typing. Keyless/instant errands only (no anvil
// dependency) so the very first tap can't dead-end on a browser that isn't running.
// EVERY example must land an answer for a COLD user with NO saved location (onboarding-weather-deadend):
// a bare "weather" asks "which city?" — the one dead-end in an otherwise instant onboarding — so the
// weather example NAMES a city, and no example depends on a shared location.
export const TRY_EXAMPLES: Array<{ label: string; text: string }> = [
  { label: "☀️ Weather", text: "weather in New York" },
  { label: "📖 Define a word", text: "what does serendipity mean" },
  { label: "💸 Tip split", text: "20% tip on $47 split 3 ways" },
  { label: "🎲 Flip a coin", text: "flip a coin" },
];

/** Encode an action to callback_data, or null if it wouldn't fit Telegram's 64-byte cap (caller omits
 * the button). The name is passed through verbatim (may contain any char except we never split on it
 * again beyond the FIRST delimiter, so a name containing "|" round-trips fine). A pick carries a
 * 0-based index instead of a name. */
export function encodeCallback(a: CallbackAction): string | null {
  const data = a.kind === "pick"
    ? `${PICK_OP}|${a.index}`
    : a.kind === "try"
    ? `${TRY_OP}|${a.index}`
    // act carries no payload (the task is resolved from the chat's cached last answer) — a bare opcode.
    : a.kind === "act"
    ? (a.mode === "daily" ? ACT_DAILY : ACT_WATCH)
    : a.kind === "install"
    ? `${INSTALL_OP}|${a.id}`
    : (() => { const op = OP_FOR.get(`${a.kind}:${a.action}`); return op ? `${op}|${a.name}` : null; })();
  if (data === null) return null;
  return utf8Len(data) <= CALLBACK_MAX_BYTES ? data : null;
}

/** Decode callback_data back to an action, or null if it's unrecognized/malformed (so a stale button
 * from an old deploy, or a spoofed payload, is ignored rather than mis-routed). Splits on the FIRST
 * "|" only, so a name with a "|" survives. A pick decodes its index (rejects a non-integer/negative). */
export function decodeCallback(data: string | undefined | null): CallbackAction | null {
  if (!data) return null;
  // act ops are bare opcodes (no payload — task comes from the cached last answer).
  if (data === ACT_DAILY) return { kind: "act", mode: "daily" };
  if (data === ACT_WATCH) return { kind: "act", mode: "watch" };
  const i = data.indexOf("|");
  if (i < 0) return null;
  const op = data.slice(0, i);
  const rest = data.slice(i + 1);
  if (op === PICK_OP) {
    if (!/^\d+$/.test(rest)) return null; // index must be a non-negative integer
    return { kind: "pick", index: Number(rest) };
  }
  if (op === TRY_OP) {
    if (!/^\d+$/.test(rest)) return null;
    return { kind: "try", index: Number(rest) };
  }
  if (op === INSTALL_OP) {
    return rest ? { kind: "install", id: rest } : null;
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

/** Buttons for the onboarding tap-to-try row (onboarding-tap-to-try): one button per TRY_EXAMPLES
 * entry, each carrying its index. Two per row so labels stay readable on a phone. */
export function tryButtons(): InlineKeyboard {
  const kb: InlineKeyboard = [];
  for (let i = 0; i < TRY_EXAMPLES.length; i++) {
    const data = encodeCallback({ kind: "try", index: i });
    if (!data) continue;
    const btn = { text: TRY_EXAMPLES[i]!.label, callback_data: data };
    if (kb.length && kb[kb.length - 1]!.length < 2) kb[kb.length - 1]!.push(btn);
    else kb.push([btn]);
  }
  return kb;
}

/** Buttons that turn the last answer into a recurring automation (tap-to-watch-on-answers): "🔁 Every
 * morning" (a daily schedule of the same task) + optionally "🔔 Watch this" when the answer is a
 * price/number worth watching for a change. No payload — the handler resolves the task from the chat's
 * cached last answer. `offerWatch` gates the watch button (a price/stock/number answer). */
export function actButtons(offerWatch: boolean, offerDaily = true): InlineKeyboard | undefined {
  const row: InlineButton[] = [];
  // "🔁 Every morning" only when a daily re-run is MEANINGFUL (tomorrow's answer differs). For a static
  // one-shot answer (a definition, a unit conversion, date math) a daily repeat is nonsense, so the
  // caller passes offerDaily=false and the button is suppressed — a pointless CTA trains users to ignore
  // the buttons (act-daily-noise-on-static-answers).
  if (offerDaily) {
    const daily = encodeCallback({ kind: "act", mode: "daily" });
    if (daily) row.push({ text: "🔁 Every morning", callback_data: daily });
  }
  if (offerWatch) {
    const watch = encodeCallback({ kind: "act", mode: "watch" });
    if (watch) row.push({ text: "🔔 Watch this", callback_data: watch });
  }
  return row.length ? [row] : undefined;
}

/** Buttons for the /templates starter-automation gallery (starter-automation-gallery): one button per
 * template, each carrying its id, so a cold user installs a recurring automation in a tap instead of
 * typing "/templates <id>". Two per row for readable labels. `items` is {id,label}[]; a label that
 * overflows the 64-byte cap is dropped (the text catalog still lists it). */
export function installButtons(items: Array<{ id: string; label: string }>): InlineKeyboard {
  const kb: InlineKeyboard = [];
  for (const it of items) {
    const data = encodeCallback({ kind: "install", id: it.id });
    if (!data) continue;
    const btn = { text: it.label, callback_data: data };
    if (kb.length && kb[kb.length - 1]!.length < 2) kb[kb.length - 1]!.push(btn);
    else kb.push([btn]);
  }
  return kb;
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
