// Relay entrypoint. Telegram long-poll -> handle -> reply.
// MVP handler is a stub: echoes, and if the message contains a URL it fetches the
// page via anvil (proving the channel -> agent -> self-hosted-browser -> reply pipe
// works end-to-end). The Gemini agent loop (src/agent.ts) replaces this stub.

import { startPolling, sendMessage, hasToken, type InboundMessage } from "./telegram.js";
import { scrape, anvilLive } from "./anvil.js";

const URL_RE = /https?:\/\/[^\s]+/i;

async function handle(msg: InboundMessage): Promise<void> {
  console.log(`[in] ${msg.from}: ${msg.text.slice(0, 120)}`);
  const urlMatch = msg.text.match(URL_RE);

  if (urlMatch) {
    await sendMessage(msg.chatId, "On it — fetching that page…");
    try {
      const res = await scrape(urlMatch[0], { format: "text" });
      const summary = `${res.title || res.url}\n\n${res.content.slice(0, 1500)}`;
      await sendMessage(msg.chatId, summary);
    } catch (e) {
      await sendMessage(msg.chatId, `Couldn't fetch that: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  await sendMessage(
    msg.chatId,
    "Hi — I'm Relay. Send me a link and I'll fetch it. (Full agent coming: tell me an app + task and I'll go do it.)"
  );
}

async function main() {
  if (!hasToken()) {
    console.error("TELEGRAM_BOT_TOKEN not set — copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  const live = await anvilLive();
  console.log(`anvil reachable: ${live} (ANVIL_BASE_URL=${process.env.ANVIL_BASE_URL ?? "http://localhost:3000"})`);
  if (!live) console.warn("WARNING: anvil-engine not reachable — URL fetches will fail until it's running.");

  console.log("Relay polling Telegram…");
  startPolling(handle);
}

main();
