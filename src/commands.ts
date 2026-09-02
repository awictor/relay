// Slash-command handling. Pure function so it's unit-testable without Telegram.
// Returns a reply string for a recognized command, or null to pass the message
// through to the agent.

const START = `👋 I'm Relay. Text me a task and I'll do it in a real browser and text you back.

Try:
• "top story on Hacker News"
• "extract the price and title from <link>"
• "compare the price across these 3 links"
• "find the newest HN posts about AI"
• "screenshot the top of Hacker News"
• "save this page as a PDF: <link>"

Or schedule me: "remind me to stretch in 20 min", "every morning text me the weather".

Save a recipe: "save btc: check the price of bitcoin", then /run btc anytime.

Commands: /help  /start  /reset  /status  /sites  /setlocation  /profile  /schedules  /cancel  /recipes  /run  /forget  /digests  /alerts`;

const HELP = `Relay — what I can do:
• Read a page: send a link, or name a site + what you want. ("top HN story", "weather in Paris")
• Pull out data: "extract the price and rating from <link>" → clean values, not a wall of text.
• Compare across pages: "compare the price of X across these links" → a side-by-side.
• Find then fetch: "find newest listings for <thing>" → I open the search page, grab the results, and read them.
• See a page: "screenshot the top of Hacker News" → I send you an image of it.
• Save a page: "save this as a PDF: <link>" → I send you a PDF document.

Limits: I won't log in as you, pay, buy, or do anything destructive. If a task needs that, I'll say so.

Schedule me: "remind me to X in 10 min" or "every morning tell me Y" — I'll text you when it's time. /schedules lists them, /cancel <id> (or /cancel all) removes them.

Save recipes: "save <name>: <task>" stores a task you can re-run with /run <name>. /recipes lists them, /forget <name> removes one. Use a {slot} for a reusable recipe — "save track: price of {item}" then "/run track sneakers".

Bundle into a briefing: "define digest morning: weather, hn, btc" then /run morning (or schedule morning every morning) for one combined message. /digests lists them, /forget-digest <name> removes one.

Watch for changes: "watch btc: price of bitcoin when it changes by 1000" — I only ping you when it moves. Or set a target: "watch btc: bitcoin below 50000", "watch eth: ethereum above 4000", "watch ps5: the PS5 back in stock" — I ping once when it crosses. /alerts lists them, /forget-alert <name> stops one. Retune one anytime: "change btc to below 45000" or "make ps5 fire under 200".

Set your location: "/setlocation Austin, TX" (or just "I'm in London") so "weather" and "near me" work without repeating the city. Add "(metric)" or "(imperial)" for units, and "UTC-5" so daily reminders fire at YOUR local time. /profile shows what's stored; "/profile clear" forgets it.

Sites I'm signed in for: /sites lists the hosts you've authorized me for (via cookies you configure) — I only read public pages otherwise.

Start over anytime: /reset clears our conversation history.

Just text me the task in plain English.`;

// A bare greeting or "what can you do" — a new user's natural first message. Onboarding used to
// fire ONLY on the literal /start command (which they don't know to type), so "hi" / "what can you
// do?" got run as a browser task and wasted the highest-leverage first message. Match only when the
// WHOLE message is a greeting/capability question (anchored + short) so a real task like "say hi to
// Sam on the forum" or "what can you tell me about X" still falls through to the agent.
const GREETING_RE = /^(?:hi|hey|hello|yo|hiya|heya|sup|howdy|gm|good morning|good evening|start|get started|help me)(?:\s+(?:there|relay|bot))?[!.?]*$/i;
const CAPABILITY_RE = /^(?:what|who|how)\s+(?:can|do|are|is)\s+(?:you|u|this|relay)(?:\s+(?:can\s+)?do)?[\s\w]*\??$/i;

/** Returns a canned reply for /start, /help, or a bare greeting/capability question; else null. */
export function handleCommand(text: string): string | null {
  const t = text.trim().toLowerCase();
  // Telegram commands can carry a bot suffix, e.g. /help@relaybot
  const cmd = t.split(/\s+/)[0]?.split("@")[0];
  if (cmd === "/start") return START;
  if (cmd === "/help") return HELP;
  // Greet a new user who opened with "hi" / "what can you do?" instead of the /start they don't know.
  // Keep it short (<= 6 words) so a longer sentence that merely starts with "how do you" is a real task.
  if (t.split(/\s+/).length <= 6 && (GREETING_RE.test(t) || CAPABILITY_RE.test(t))) return START;
  return null;
}
