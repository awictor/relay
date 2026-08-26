// Slash-command handling. Pure function so it's unit-testable without Telegram.
// Returns a reply string for a recognized command, or null to pass the message
// through to the agent.

const START = `👋 I'm Relay. Text me a task and I'll go do it in a real browser and text you back.

Try:
• "top story on Hacker News"
• "weather in Tokyo"
• send me a link and I'll summarize it

Commands: /help  /start`;

const HELP = `Relay — what I can do:
• Read a page: send a link, or name a site + what you want.
• Look things up: "top HN story", "price of bitcoin", "weather in Paris".
• Multi-step: I can open a site, search, and read results.

Limits: I won't log in as you, pay, buy, or do anything destructive. If a task needs that, I'll say so.

Just text me the task in plain English.`;

/** Returns a canned reply for /start or /help, else null (not a command). */
export function handleCommand(text: string): string | null {
  const t = text.trim().toLowerCase();
  // Telegram commands can carry a bot suffix, e.g. /help@relaybot
  const cmd = t.split(/\s+/)[0]?.split("@")[0];
  if (cmd === "/start") return START;
  if (cmd === "/help") return HELP;
  return null;
}
