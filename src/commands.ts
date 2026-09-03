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

Commands: /help  /start  /reset  /status  /sites  /setlocation  /profile  /schedules  /cancel  /recipes  /templates  /run  /forget  /digests  /alerts`;

const HELP = `Relay — what I can do:
• Read a page: send a link, or name a site + what you want. ("top HN story", "weather in Paris")
• Pull out data: "extract the price and rating from <link>" → clean values, not a wall of text.
• Compare across pages: "compare the price of X across these links" → a side-by-side. Add "as a CSV" and I'll send a spreadsheet file you can keep.
• Find then fetch: "find newest listings for <thing>" → I open the search page, grab the results, and read them.
• See a page: "screenshot the top of Hacker News" → I send you an image of it.
• Save a page: "save this as a PDF: <link>" → I send you a PDF document.
• Summarize a video: send a YouTube link + "tldr this" → I read its transcript and sum it up.
• Weather: "weather in Paris" or just "weather" (if you've shared your location) → current + today's high/low, instantly.
• Find places nearby: "coffee near me", "nearest pharmacy" (share your location first) → real nearby spots with distance + hours.
• Convert currency: "how much is 200 USD in EUR" → I use the live rate, instantly.
• Share your location: tap 📎 → Location and I'll use it for "near me", weather, and directions.
• Big errands: "find the 5 cheapest flights to Lisbon and get back to me" → I work on it in the background and text you when it's done.

Draft correspondence: "write an email to my landlord that rent is late" or "text mom I'll be late" → I draft it and give you a copy block + a one-tap send link. You review and send — I never send for you.

Add to your calendar: "add dentist Thursday 2pm to my calendar" → I give you a Google Calendar link + an .ics file to import. You tap to add.

Limits: I won't log in as you, pay, buy, or do anything destructive. If a task needs that, I'll say so.

Schedule me: "remind me to X in 10 min", "every morning tell me Y", "every Monday at 9am ...", "every weekday at 8 ...", or "every 2 hours ..." — I'll text you when it's time. /schedules lists them, /cancel <id> (or /cancel all) removes them.

Quick start: /templates shows ready-made recipes (morning briefing, price watch, top news...) — install one in a tap, then /run it.

Save recipes: "save <name>: <task>" stores a task you can re-run with /run <name>, or just "save that as <name>" right after I answer to keep the last task. /recipes lists them, /forget <name> removes one. Use a {slot} for a reusable recipe — "save track: price of {item}" then "/run track sneakers". Multiple slots take values by name or position — "save trip: {item} at {store}" then "/run trip item=milk store=HEB" (or "/run trip milk, HEB"). Chain steps with ">>" — "save plan: cheapest flight to {city} >> weather + top news there >> summarize" runs each step feeding the last, and "if <word>: <step>" only continues when the previous result contains that word.

Bundle into a briefing: "define digest morning: weather, hn, btc" then /run morning (or schedule morning every morning) for one combined message. /digests lists them, /forget-digest <name> removes one.

Watch for changes: "watch btc: price of bitcoin when it changes by 1000" — I only ping you when it moves. Or set a target: "watch btc: bitcoin below 50000", "watch eth: ethereum above 4000", "watch ps5: the PS5 back in stock" — I ping once when it crosses. /alerts lists them, /forget-alert <name> stops one. Retune one anytime: "change btc to below 45000" or "make ps5 fire under 200".

Watch for NEW items in a list: "watch jobs: remote react roles for new listings" or "watch deals: new deals on OLED TVs" — I ping you only when a NEW entry shows up (not on every check). Great for job boards, listings, restocks, releases.

Watch, then DO: add "then run <recipe>" to any watch — "watch jobs: new remote roles for new listings then run summarize-jobs" — and when it fires I'll also run that saved recipe and include its result.

Watch a whole list at once: separate items with semicolons — "watch markets: btc price; eth price; gold price" — and I track them as one watchlist, sending a single update with only the ones that moved.

See a watch's trend: "how has btc moved this week" or "btc trend" — I chart the value from my logged checks (first→last, high/low), no re-fetch.

Pause without deleting: "snooze btc 3 days", "pause my morning digest" (until you resume it), or "snooze all" quiets an automation through travel or noise — say "resume btc" to turn it back on. The setup stays intact; nothing fires while paused.

Set your location: "/setlocation Austin, TX" (or just "I'm in London") so "weather" and "near me" work without repeating the city. Add "(metric)" or "(imperial)" for units, and "UTC-5" so daily reminders fire at YOUR local time. /profile shows what's stored; "/profile clear" forgets it.

Remember things about you: "remember I'm vegetarian", "remember my wife's birthday is June 3" — I'll factor them into every answer. Ask "what do you know about me" to see them; "forget that I'm vegetarian" or "forget everything you know" to clear.

Recall a past answer: "what was that sushi place you found?" or "resend the flights" — I search what I've told you before, no need to re-run it.

Sites I'm signed in for: /sites lists the hosts you've authorized me for (via cookies you configure) — I only read public pages otherwise.

Start over anytime: /reset clears our conversation history.

After an answer: "more" shows the rest if I trimmed it, "send the link" gives you the source URLs, and "watch that" / "schedule that every morning" turns it into a standing alert or daily check.

Just text me the task in plain English.`;

// A bare greeting or "what can you do" — a new user's natural first message. Onboarding used to
// fire ONLY on the literal /start command (which they don't know to type), so "hi" / "what can you
// do?" got run as a browser task and wasted the highest-leverage first message. Match only when the
// WHOLE message is a greeting/capability question (anchored + short) so a real task like "say hi to
// Sam on the forum" or "what can you tell me about X" still falls through to the agent.
const GREETING_RE = /^(?:hi|hey|hello|yo|hiya|heya|sup|howdy|gm|good morning|good evening|start|get started|help me)(?:\s+(?:there|relay|bot))?[!.?]*$/i;
const CAPABILITY_RE = /^(?:what|who|how)\s+(?:can|do|are|is)\s+(?:you|u|this|relay)(?:\s+(?:can\s+)?do)?[\s\w]*\??$/i;

// Honest answer to a "meta / trust" question — a new user's other common opener ("is this free?",
// "do you save my messages?", "are you a bot?"). These used to fall through to a browser turn (slow,
// or an invented answer). One fixed, truthful reply builds the trust that gates a first real errand.
const META = `A few honest answers:
• Yes, I'm free to use.
• I'm an AI bot, not a person — I drive a real web browser to do tasks and text you back.
• I keep only a short rolling memory of our recent chat (so follow-ups make sense) on the server running me — nothing is shared or sold.
• I'm not logged into any of your accounts unless you set that up yourself, and I won't pay, buy, or do anything irreversible on my own.

Text me a task to try it — or /help for what I can do.`;
// Whole-message trust/meta questions only (short + anchored) so "is this article free to read" (a
// real errand) still reaches the agent.
// "free" only in a trust context ("is this free", "is it free to use", "are you free to use") — NOT
// a bare "are you free (right now)" which is a real availability ask, not a privacy/cost question.
const META_RE = /^(?:(?:are|r)\s+(?:you|u)\s+(?:a\s+)?(?:real|human|person|bot|ai|robot)|is\s+(?:this|it)\s+free|(?:is\s+it|are\s+you)\s+free\s+to\s+use|is\s+this\s+(?:safe|a\s+(?:bot|scam|person))|do\s+(?:you|u)\s+(?:save|store|keep|sell|share|record)\s+(?:my\s+)?(?:messages?|data|chats?|info)|who\s+(?:made|built|created|owns)\s+(?:you|this)|are\s+(?:you|u)\s+safe|is\s+my\s+data\s+safe)[\s\w']*\??$/i;

// A boundary-probe: "can you book a flight / send a text / call them / check my email / buy this?".
// These are things Relay CAN'T do (it doesn't act, pay, place calls, or log into your accounts) —
// they used to fall to a slow floundering agent turn. An honest "can't, but here's what I CAN do +
// try this" converts the probe into a real errand. Only matches the can't-do verbs; "can you find the
// cheapest X" (something it CAN do) is NOT matched and reaches the agent.
const PROBE = `I can't do that one — I don't place calls, send texts/emails, pay/buy, or log into your accounts.

What I CAN do: look things up on the web, pull out + compare data, watch a page and ping you when it changes, and text you reminders/briefings. Want me to try one? e.g. "cheapest flight LAX to NYC next Fri", "watch this product's price", "every morning the weather".`;
// NOTE: comms verbs (send/text/email/message/dm) must NOT match "send/text ME <the answer>" — that's
// Relay's CORE action (deliver the result to this chat), not an outbound message it can't do. The
// negative lookahead (?!\s+(?:me|us|it|that|back)\b) lets "text me the weather" fall through to the
// agent while still refusing "text my mom" / "email John". call/phone/book/buy/pay have no such
// carve-out (Relay genuinely can't do them).
const PROBE_RE = /^(?:can|could|will|would|do)\s+(?:you|u)\s+(?:please\s+)?(?:book|buy|order|purchase|pay|call|phone|ring|reserve|schedule an appointment|log ?in|sign ?in|apply|subscribe|cancel my|make a (?:call|reservation|booking|payment)|(?:text|email|message|dm|send)(?!\s+(?:me|us|it|that|back)\b))\b[\s\w'./-]*\??$/i;

// A site-named capability probe: "do you work with Amazon?", "can you use Gmail?", "does this work
// on Twitter?". These fell to a cold agent turn that browsed the site logged-out + floundered. One
// honest reply: reads public pages on most sites, can't log into your accounts unless you set up
// cookies (/sites). Matches the shape, not a specific site list, so any site name works.
const SITE = `I can read public pages on most sites and pull data from them. I can't log into your accounts on my own — but you can authorize specific sites by configuring cookies (see /sites), and then I'll act signed-in for those. Want me to try reading a page? Just send the link or name the site + what you want.`;
// Only "does it SUPPORT <site>" verbs — NOT read/access/browse, which are the actions Relay actually
// performs ("can you read Reuters" is a real read errand, not a support question) (audit 19 B#4).
const SITE_RE = /^(?:can|could|do|does|will|would)\s+(?:you|u|this|relay|it)\s+(?:please\s+)?(?:work with|work on|support|handle|use)\s+[\w][\w'. -]*\??$/i;

/** Returns a canned reply for /start, /help, a bare greeting/capability question, a meta/trust
 * question, or a can't-do capability probe; else null. */
export function handleCommand(text: string): string | null {
  const t = text.trim().toLowerCase();
  // Telegram commands can carry a bot suffix, e.g. /help@relaybot
  const cmd = t.split(/\s+/)[0]?.split("@")[0];
  if (cmd === "/start") return START;
  if (cmd === "/help" || cmd === "/menu" || cmd === "/commands") return HELP;
  // Bare "help" / "menu" / "commands" / "?" (no slash) — a new user asking for the list without
  // knowing the slash syntax. Whole-message only so "help me plan X" (a real task) still runs.
  if (/^(?:help|menu|commands|\?+)$/i.test(t)) return HELP;
  // Greet a new user who opened with "hi" / "what can you do?" instead of the /start they don't know.
  // Keep it short (<= 6 words) so a longer sentence that merely starts with "how do you" is a real task.
  if (t.split(/\s+/).length <= 6 && (GREETING_RE.test(t) || CAPABILITY_RE.test(t))) return START;
  // Meta/trust question -> honest fixed reply (bounded length so a real errand isn't swallowed).
  if (t.split(/\s+/).length <= 8 && META_RE.test(t)) return META;
  // Can't-do capability probe -> honest reply + pivot to what it CAN do.
  if (t.split(/\s+/).length <= 10 && PROBE_RE.test(t)) return PROBE;
  // Site-named capability probe ("do you work with Amazon?") -> public-pages + cookie-auth answer.
  if (t.split(/\s+/).length <= 8 && SITE_RE.test(t)) return SITE;
  return null;
}
