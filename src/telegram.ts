// Telegram transport — long-polling getUpdates (no public URL / webhook needed,
// so zero inbound infra). sendMessage for replies. One process, one bot.

import { mapPool } from "./lib/pool.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = `https://api.telegram.org/bot${TOKEN}`;

// Cap on how many inbound-message handlers run at once (DEV-0141). Each handler may open an anvil
// browser session; the self-hosted anvil has a bounded Chrome pool, so an unbounded fan-out (the old
// Promise.all) could open one session PER concurrent chat in a burst and 429/exhaust it. Default 4,
// env-tunable. Mirrors DEV-0140's digest bound; reuses the same mapPool primitive.
const DISPATCH_CONCURRENCY = Math.max(1, Number(process.env.RELAY_DISPATCH_CONCURRENCY) || 4);

export interface InboundMessage {
  chatId: number;
  text: string;
  from: string; // username or first name, for logs
  messageId: number;
  photoFileId?: string; // set when the message is a photo (product-loop): Telegram file_id of the
                        // largest size; `text` carries the caption (may be empty). Handler downloads it.
  voiceFileId?: string; // set when the message is a voice note (product-loop): file_id of the audio.
                        // Handler downloads + transcribes it, then runs the transcript as a task.
  documentFileId?: string; // set when the message is a document/PDF (product-loop): file_id; `text`
                           // carries the caption. Handler downloads + asks the vision LLM about it.
  documentMime?: string;   // the document's declared mime_type (e.g. application/pdf), if any.
  location?: { latitude: number; longitude: number }; // set when the message is a shared location pin
                                                      // (the natural "near me" move). Handler saves it
                                                      // as the chat's coords + acks, so it's not dropped.
}

export function hasToken(): boolean {
  return TOKEN.length > 0;
}

// The bot's slash commands + one-line descriptions, registered with Telegram so the native "/"
// menu shows them with autocomplete + a hint (setMyCommands). Without this the menu is empty and a
// new user can't discover or correctly type /run, /alerts, /setlocation in the first 10 minutes.
// Descriptions are <=256 chars (Telegram limit); names are lowercase, no leading slash.
export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "start", description: "What Relay can do + examples" },
  { command: "help", description: "Full list of capabilities" },
  { command: "schedules", description: "List your reminders + scheduled tasks" },
  { command: "cancel", description: "Cancel a schedule: /cancel <id> or /cancel all" },
  { command: "recipes", description: "List saved recipes (/run <name> to use one)" },
  { command: "run", description: "Run a saved recipe or digest: /run <name>" },
  { command: "digests", description: "List your briefings (bundled recipes)" },
  { command: "alerts", description: "List your watch-and-notify alerts" },
  { command: "forget", description: "Delete a saved recipe: /forget <name>" },
  { command: "setlocation", description: "Set your city + timezone for weather + reminders" },
  { command: "profile", description: "Show or clear your saved location/units/timezone" },
  { command: "sites", description: "Sites I'm signed in for (via your cookies)" },
  { command: "reset", description: "Clear our conversation history" },
  { command: "status", description: "Relay's health + uptime" },
];

/** Register the slash-command menu with Telegram (setMyCommands). Best-effort: logs on failure and
 * never throws, so a transient API hiccup at boot can't crash the worker. No-op without a token. */
export async function registerCommands(commands = BOT_COMMANDS): Promise<boolean> {
  if (!TOKEN) return false;
  try {
    const r = await fetch(`${API}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { console.error("telegram setMyCommands failed:", r.status, (await r.text().catch(() => "")).slice(0, 200)); return false; }
    return true;
  } catch (e) {
    console.error("telegram setMyCommands error:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Telegram hard-caps a message at 4096 chars. The old code did text.slice(0,4096), so a long
// digest/answer was cut mid-sentence with NO marker and the user read a partial result as complete.
export const TELEGRAM_MAX = 4096;

/**
 * Split text into <=max-char chunks for sequential sends, preferring natural boundaries so a chunk
 * doesn't break mid-sentence: paragraph (\n\n) > line (\n) > space, falling back to a hard cut only
 * when a single token exceeds max. Returns [text] unchanged when it already fits. Pure + exported
 * for testing. A trailing " (1/3)"-style counter is added by the sender, not here.
 */
export function splitMessage(text: string, max: number = TELEGRAM_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // Prefer the last paragraph break, then line break, then space — but only if it's not too early
    // (avoid a tiny chunk when a break sits near the start). Otherwise hard-cut at max.
    let cut = -1;
    for (const sep of ["\n\n", "\n", " "]) {
      const i = window.lastIndexOf(sep);
      if (i >= max * 0.5) { cut = i + (sep === " " ? 1 : sep.length); break; }
    }
    if (cut <= 0) cut = max; // no good boundary (one long token) -> hard cut
    chunks.push(rest.slice(0, cut).replace(/\s+$/, ""));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

/** Send a text reply to a chat. Best-effort; logs on failure. A message over Telegram's 4096-char
 * cap is split into sequential sends (with an "(i/n)" counter) instead of being silently truncated. */
export async function sendMessage(chatId: number, text: string): Promise<void> {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const parts = splitMessage(text, TELEGRAM_MAX - 8); // headroom for the " (i/n)" counter
  for (let i = 0; i < parts.length; i++) {
    const body = parts.length > 1 ? `${parts[i]} (${i + 1}/${parts.length})` : parts[i]!;
    try {
      const r = await fetch(`${API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: body }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) console.error("telegram sendMessage failed:", r.status, (await r.text().catch(() => "")).slice(0, 200));
    } catch (e) {
      console.error("telegram sendMessage error:", e instanceof Error ? e.message : String(e));
    }
  }
}

/** Download a Telegram file by file_id (product-loop): getFile -> file_path -> the file bytes.
 * Returns { bytes, mimeType } or null on any failure. Used to fetch inbound photos for vision. */
export async function downloadFile(fileId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  if (!TOKEN) return null;
  try {
    const gf = await fetch(`${API}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(15000) });
    if (!gf.ok) return null;
    const j = (await gf.json()) as { ok?: boolean; result?: { file_path?: string } };
    const path = j.result?.file_path;
    if (!path) return null;
    const dl = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${path}`, { signal: AbortSignal.timeout(20000) });
    if (!dl.ok) return null;
    const bytes = new Uint8Array(await dl.arrayBuffer());
    const ext = path.split(".").pop()?.toLowerCase();
    const MIME: Record<string, string> = { png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg",
      oga: "audio/ogg", ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
      pdf: "application/pdf", txt: "text/plain" };
    const mimeType = (ext && MIME[ext]) || "image/jpeg"; // photos are the common case + have no reliable ext
    return { bytes, mimeType };
  } catch {
    return null;
  }
}

/** Send a photo (raw image bytes) to a chat via multipart/form-data. Best-effort; logs on
 * failure. Uses FormData + Blob so we don't hand-roll the multipart boundary. Optional caption. */
export async function sendPhoto(chatId: number, bytes: Uint8Array, caption?: string): Promise<void> {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
  try {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption.slice(0, 1024)); // Telegram caption cap
    form.set("photo", new Blob([bytes], { type: "image/jpeg" }), "screenshot.jpg");
    const r = await fetch(`${API}/sendPhoto`, {
      method: "POST",
      body: form, // fetch sets the multipart Content-Type + boundary itself
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) console.error("telegram sendPhoto failed:", r.status, (await r.text().catch(() => "")).slice(0, 200));
  } catch (e) {
    console.error("telegram sendPhoto error:", e instanceof Error ? e.message : String(e));
  }
}

/** Send a document (raw bytes, e.g. a PDF) to a chat via multipart/form-data. Best-effort;
 * logs on failure. Same FormData+Blob pattern as sendPhoto. Optional caption + filename. */
export async function sendDocument(chatId: number, bytes: Uint8Array, filename = "document.pdf", caption?: string): Promise<void> {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
  try {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption.slice(0, 1024));
    form.set("document", new Blob([bytes], { type: "application/pdf" }), filename);
    const r = await fetch(`${API}/sendDocument`, {
      method: "POST",
      body: form, // fetch sets the multipart Content-Type + boundary itself
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) console.error("telegram sendDocument failed:", r.status, (await r.text().catch(() => "")).slice(0, 200));
  } catch (e) {
    console.error("telegram sendDocument error:", e instanceof Error ? e.message : String(e));
  }
}

/** Show the "typing…" indicator in a chat (best-effort, ~5s or until next message). */
export async function sendTyping(chatId: number): Promise<void> {
  if (!TOKEN) return;
  try {
    await fetch(`${API}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* best-effort */
  }
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    caption?: string;                                  // photo/media caption
    photo?: Array<{ file_id: string; width?: number; height?: number }>; // size variants, ascending
    voice?: { file_id: string; duration?: number; mime_type?: string };  // voice note
    document?: { file_id: string; mime_type?: string; file_name?: string }; // forwarded file/PDF
    location?: { latitude: number; longitude: number };                     // a shared location pin
    from?: { username?: string; first_name?: string };
  };
}

/**
 * PURE: map a batch of Telegram updates to InboundMessages + the next poll offset.
 * Extracted from the poll loop so the delivery contract is unit-testable offline (DEV-0005):
 *   - offset always advances to max(update_id)+1 across ALL updates — even ones we skip — so a
 *     non-text/non-message update can't wedge the poll into redelivering it forever.
 *   - only updates with a `message.text` become InboundMessages; edited messages, channel posts,
 *     and text-less messages (stickers/photos) are dropped (offset still advances past them).
 *   - `from` falls back username -> first_name -> the chat id as a string, for logs.
 */
export function parseUpdates(updates: TgUpdate[], offset: number): { messages: InboundMessage[]; nextOffset: number } {
  const messages: InboundMessage[] = [];
  let nextOffset = offset;
  for (const u of updates ?? []) {
    if (u.update_id + 1 > nextOffset) nextOffset = u.update_id + 1;
    const m = u.message;
    if (!m) continue;
    const from = m.from?.username || m.from?.first_name || String(m.chat.id);
    // A photo message (product-loop): take the LARGEST size variant (last in the array) + its caption
    // as the text. A text message: as before. Everything else (stickers/etc) is still dropped.
    if (m.photo && m.photo.length) {
      const largest = m.photo[m.photo.length - 1]!;
      messages.push({ chatId: m.chat.id, text: (m.caption ?? "").trim(), from, messageId: m.message_id, photoFileId: largest.file_id });
    } else if (m.voice?.file_id) {
      // Voice note: transcribed + run by the handler (product-loop). No text of its own.
      messages.push({ chatId: m.chat.id, text: "", from, messageId: m.message_id, voiceFileId: m.voice.file_id });
    } else if (m.document?.file_id) {
      // Forwarded document/PDF (product-loop): handler downloads + asks the vision LLM. Caption = the question.
      messages.push({ chatId: m.chat.id, text: (m.caption ?? "").trim(), from, messageId: m.message_id, documentFileId: m.document.file_id, documentMime: m.document.mime_type });
    } else if (m.location && typeof m.location.latitude === "number" && typeof m.location.longitude === "number") {
      // A shared location pin (telegram-location-pin): text-less, so it was silently dropped. Carry the
      // coords + any caption so the handler can save them + acknowledge (the natural "near me" move).
      messages.push({ chatId: m.chat.id, text: (m.caption ?? "").trim(), from, messageId: m.message_id, location: { latitude: m.location.latitude, longitude: m.location.longitude } });
    } else if (m.text) {
      messages.push({ chatId: m.chat.id, text: m.text, from, messageId: m.message_id });
    }
  }
  return { messages, nextOffset };
}

/**
 * Long-poll loop. Calls onMessage for each inbound text message. Runs until the
 * returned stop() is called. Uses Telegram's offset mechanism so each update is
 * delivered once. 30s long-poll keeps it near-idle with no external cost.
 */
/**
 * Dispatch a batch of inbound messages CONCURRENTLY (DEV-0037). The old code awaited each
 * onMessage in sequence, so one chat's slow browse task head-of-line-blocked every other chat's
 * reply. Firing them together isolates latency per chat; per-chat rate-limit still guards abuse.
 * Each handler's error is caught individually (one throw never sinks the batch). Returns a promise
 * that settles when ALL handlers finish — the caller awaits it before the next getUpdates so a
 * genuinely stuck handler can't let the loop lap itself. BOUNDED (DEV-0141): at most
 * DISPATCH_CONCURRENCY handlers run at once, so a burst of chats each starting an anvil browse can't
 * open one session per chat simultaneously and exhaust the self-hosted Chrome pool. mapPool preserves
 * the settle-all contract (it awaits every worker before resolving).
 */
export async function dispatchBatch(
  messages: InboundMessage[],
  onMessage: (msg: InboundMessage) => Promise<void>,
  onError: (e: unknown) => void = (e) => console.error("onMessage handler error:", e instanceof Error ? e.message : String(e)),
): Promise<void> {
  await mapPool(messages, DISPATCH_CONCURRENCY, (msg) => onMessage(msg).catch(onError));
}

export function startPolling(onMessage: (msg: InboundMessage) => Promise<void>): { stop: () => void } {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
  let offset = 0;
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        const r = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`, {
          signal: AbortSignal.timeout(40000),
        });
        if (!r.ok) {
          await sleep(2000);
          continue;
        }
        const j = (await r.json()) as { ok: boolean; result: TgUpdate[] };
        const { messages, nextOffset } = parseUpdates(j.result ?? [], offset);
        offset = nextOffset; // advance past ALL updates (incl. skipped) so none redeliver
        // Concurrent dispatch (DEV-0037): independent chats don't head-of-line-block each other.
        await dispatchBatch(messages, onMessage);
      } catch {
        await sleep(2000); // transient network/timeout — back off and retry
      }
    }
  };

  loop();
  return { stop: () => { running = false; } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
