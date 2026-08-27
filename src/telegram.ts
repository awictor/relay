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
}

export function hasToken(): boolean {
  return TOKEN.length > 0;
}

/** Send a text reply to a chat. Best-effort; logs on failure. */
export async function sendMessage(chatId: number, text: string): Promise<void> {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
  // Telegram hard-caps messages at 4096 chars.
  const body = text.slice(0, 4096);
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
    if (!m || !m.text) continue;
    const from = m.from?.username || m.from?.first_name || String(m.chat.id);
    messages.push({ chatId: m.chat.id, text: m.text, from, messageId: m.message_id });
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
