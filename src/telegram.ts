// Telegram transport — long-polling getUpdates (no public URL / webhook needed,
// so zero inbound infra). sendMessage for replies. One process, one bot.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = `https://api.telegram.org/bot${TOKEN}`;

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
 * Long-poll loop. Calls onMessage for each inbound text message. Runs until the
 * returned stop() is called. Uses Telegram's offset mechanism so each update is
 * delivered once. 30s long-poll keeps it near-idle with no external cost.
 */
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
        for (const u of j.result ?? []) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m || !m.text) continue;
          const from = m.from?.username || m.from?.first_name || String(m.chat.id);
          try {
            await onMessage({ chatId: m.chat.id, text: m.text, from, messageId: m.message_id });
          } catch (e) {
            console.error("onMessage handler error:", e instanceof Error ? e.message : String(e));
          }
        }
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
