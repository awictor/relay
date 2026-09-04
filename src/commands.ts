// Slash-command handling. Pure function so it's unit-testable without Telegram.
// Returns a reply string for a recognized command, or null to pass the message
// through to the agent.
import { confirmToActEnabled } from "./lib/confirm-action.js";

// When the operator has opted into confirm-to-act (RELAY_CONFIRM_TO_ACT), /help gains one line so
// users discover it — the ONLY way the read-only bot ever clicks a committing button, and only after
// they tap/type YES. Off by default, so the line is absent unless the operator turned the feature on
// (confirm-to-act-help-doc). We append it to HELP at call time (not baked into the constant) so the
// env flag is read live — matching how the agent/handler gate the feature.
const CONFIRM_HELP_LINE =
  "\n\nApprove-to-act (this instance has it on): if a task needs a committing click (buy, submit, send), " +
  "I'll STOP and show you exactly what I'd click + where, then wait — I only do it after you tap ✅ Yes " +
  "(or reply \"yes\"). Reply \"no\" (or ignore it) and nothing happens. I never click without that.";
const withConfirmHelp = (help: string): string =>
  confirmToActEnabled() ? help + CONFIRM_HELP_LINE : help;

const START = `👋 I'm Relay. Text me like you'd text a helpful friend — plain English, no commands to learn. I'll look things up on the web and text you back.

Just ask:
• "weather this weekend?" · "what does escrow mean?"
• "20% tip on $47" · "what time is it in Tokyo?"
• "price of bitcoin" · "is AAPL up today?"
• "where's my package 1Z999..." · "coffee near me"
• "tell me a joke" · "fun fact" · "quiz me"
• "generate a strong password" · "a passphrase"

Remember & remind:
• "remind me to leave at 5:30" · "every morning: weather + top news"
• "add milk to my grocery list" · "remember I'm vegetarian"
• "follow r/programming" / "follow github.com/rust-lang/rust" — I ping you when there's something new

Bigger stuff (send a link or name a site):
• "compare the price across these 3 links" · "summarize this video: <link>"
• "find the 5 cheapest flights to Lisbon and get back to me"

📍 Tap the paperclip → Location once and "weather", "near me", and directions just work.

Not sure what to try? Text "help" for the full list.

Commands: /help  /start  /reset  /status  /sites  /setlocation  /profile  /dashboard  /schedules  /cancel  /recipes  /templates  /run  /forget  /digests  /alerts  /contacts`;

const HELP = `Relay — what I can do:
• Read a page: send a link, or name a site + what you want. ("top HN story", "weather in Paris")
• Pull out data: "extract the price and rating from <link>" → clean values, not a wall of text.
• Compare across pages: "compare the price of X across these links" → a side-by-side. Add "as a CSV" and I'll send a spreadsheet file you can keep.
• Find then fetch: "find newest listings for <thing>" → I open the search page, grab the results, and read them.
• Search inside a site: "search <store/site> for <thing>" → I use the site's own search box and read the results back.
• Go deeper than page one: "the 20 newest listings", "cheapest across a few pages", "what's new on <scrolling feed>" → I follow pagination or scroll a feed to gather more than the first screen, and can hand back a clean list (title + price + link per item) instead of a wall of text — add "as a CSV" and I'll send it as a spreadsheet file.
• See a page: "screenshot the top of Hacker News", or "screenshot the whole page" for the full top-to-bottom capture → I send you an image of it.
• Save a page: "save this as a PDF: <link>" → I send you a PDF document.
• Send me a file: forward a PDF, CSV, spreadsheet, or text file (with a question in the caption) → I read it and answer. "what's my total?", "summarize this statement".
• Summarize a video: send a YouTube link + "tldr this" → I read its transcript and sum it up.
• Weather: "weather in Paris" or just "weather" (if you've shared your location) → current + today's high/low, instantly.
• Find places nearby: "coffee near me", "nearest pharmacy" (share your location first) → real nearby spots with distance + hours.
• Crypto + stock prices: "price of bitcoin", "what's ETH at", "AAPL price" → live price + 24h change, instantly.
• Flip / roll / pick: "flip a coin", "roll a d20", "random number 1-100", "pick one: tacos or sushi", "generate a uuid" → a genuinely random answer.
• Strong passwords: "generate a strong password", "a 24-character password no symbols", "a passphrase", "6-digit PIN" → a cryptographically-random secret you copy into your password manager. I don't store it.
• Encode / decode / hash: "base64 encode X", "decode this base64 ...", "url-encode ...", "hex decode ...", "rot13 ...", "sha256 of X", "md5 of X", "hello in binary", "morse code SOS", "decode this JWT ..." → exact conversion, instantly (hashes are one-way; I read a JWT's payload but don't verify its signature).
• Convert currency: "how much is 200 USD in EUR" → I use the live rate, instantly.
• Convert units: "180C to F", "5 foot 11 in cm", "2 cups of flour in grams", "10 miles in km", "500 MB in GB", "100 km/h to mph", "50 knots to mph" → exact, instantly.
• Better buy: "which is cheaper, 500g for $4 or 1.2kg for $9?" → I compare price-per-unit and name the winner.
• Do the math: "split $127.50 three ways with 20% tip", "monthly payment on a $30k loan at 6% for 5 years" → I compute it exactly, not a guess.
• Translate: "how do you say 'where's the pharmacy' in Spanish", "translate this page to English: <link>" → the translation (with pronunciation for non-Latin scripts).
• Define a word: "what does obsequious mean", "synonyms for happy" → definition, pronunciation, and synonyms, instantly.
• Quick facts: "who is the CEO of OpenAI", "how tall is Everest", "what is a Roth IRA" → a one-paragraph answer from Wikipedia with a source link, instantly.
• Nutrition: "calories in a banana", "how much protein in chicken breast", "carbs in a Big Mac" → calories + protein/carbs/fat from USDA data (per 100g), instantly. I say so if I'm not sure rather than guessing.
• Where to watch: "where can I watch Dune Part Two", "is Oppenheimer streaming" → a JustWatch link showing where it streams/rents/buys in your region. (Availability shifts constantly, so I point you to the live source instead of guessing a service.)
• World clock: "what time is it in Tokyo", "what's 9am PT in London" → the time there or a zone conversion, instantly. Also "how long until 5pm" / "minutes until midnight" → a countdown in your timezone.
• Dates: "how many days until Christmas", "what day is July 4 2026", "how old if born 1990-05-06", "days between two dates" → exact calendar math, instantly.
• Countdowns: "countdown to my flight Dec 20", "countdown to vacation on 2026-07-01" → I save it and ping you as it nears (a week out, the day before, the morning of), not just a one-time answer.
• Sports scores: "did the Lakers win?", "Man City score", "NBA scores tonight" → today's scores + status, instantly (NBA/NFL/MLB/NHL/NCAA + major soccer).
• News: "what's the news?", "top headlines", "news about AI" → today's top headlines, instantly.
• Fun: "tell me a joke", "fun fact", "quiz me" → a joke, a fun fact, or a trivia question, instantly.
• Meal ideas: "what can I make with chicken and rice", "dinner ideas", "recipe for carbonara" → dishes to cook + full recipes.
• Sunrise/sunset: "what time is sunset today", "when's sunrise tomorrow in Denver", "how much daylight" → exact times, instantly.
• Air quality + UV: "how's the air", "is it smoky", "safe to run outside", "do I need sunscreen today" → AQI, smoke/PM2.5, and the UV index, instantly.
• QR codes: "make a QR code for https://mysite.com", "QR for my wifi" → I text you back a scannable QR image. Send me a photo of a QR + "scan this" and I'll read it back.
• Track a package: "where's my package 1Z999..." or "track 9400..." → I spot the carrier (UPS/FedEx/USPS/DHL) + read its tracking page. Add "watch" to get pinged when the status changes.
• Flight status: "is AA100 on time", "where's flight UA83", "when does DL215 land" → I give the airline + route (from → to) and whether it's in the air right now, plus a live-tracker link. (I can't get the exact gate or an on-time verdict — that's on the tracker link.)
• Share your location: tap 📎 → Location and I'll use it for "near me", weather, and directions.
• Big errands: "find the 5 cheapest flights to Lisbon and get back to me" → I work on it in the background and text you when it's done.

Draft correspondence: "write an email to my landlord that rent is late" or "text mom I'll be late" → I draft it and give you a copy block + a one-tap send link. You review and send — I never send for you.

Save contacts so I know who "mom" is: "save mom's number is 555-123-4567", "my boss's email is boss@co.com" → then "text mom I'll be late" / "email my boss the update" drafts straight to them. /contacts lists them; "forget mom's contact" removes one. And "follow up with Sarah in 3 days" / "remind me to reply to my landlord tomorrow" → I'll nudge you when it's time, with their contact + a one-tap draft link.

Add to your calendar: "add dentist Thursday 2pm to my calendar" → I give you a Google Calendar link + an .ics file to import. You tap to add.

Limits: I won't log in as you, pay, buy, or do anything destructive. If a task needs that, I'll say so.

Schedule me: "remind me to X in 10 min", "every morning tell me Y", "every Monday at 9am ...", "every weekday at 8 ...", "every 2 hours ...", "pay rent on the 1st of every month", or "mom's birthday every year on June 3" — I'll text you when it's time. /schedules lists them, /cancel <id> (or /cancel all) removes them.

Nagging reminders: "keep reminding me to take my meds every 15 min until I say done" (or "nag me to stretch every 20 min") → I re-ping until you reply "done" or "stop". Great for meds, water, standup.

Timers: "set a timer for 20 minutes", "timer 10 min", "5 minute timer for the pasta" → I ping you when it's up.

Quick start: /templates shows ready-made automations (morning briefing, price watch, top news...) with one-tap install buttons — tap to add it, then /run it (or "schedule it every morning").

Save recipes: "save <name>: <task>" stores a task you can re-run with /run <name>, or just "save that as <name>" right after I answer to keep the last task. /recipes lists them, /forget <name> removes one. Use a {slot} for a reusable recipe — "save track: price of {item}" then "/run track sneakers". Multiple slots take values by name or position — "save trip: {item} at {store}" then "/run trip item=milk store=HEB" (or "/run trip milk, HEB"). Chain steps with ">>" — "save plan: cheapest flight to {city} >> weather + top news there >> summarize" runs each step feeding the last, and "if <word>: <step>" only continues when the previous result contains that word.

Bundle into a briefing: "define digest morning: weather, hn, btc" then /run morning (or schedule morning every morning) for one combined message. /digests lists them, /forget-digest <name> removes one.

Watch for changes: "watch btc: price of bitcoin when it changes by 1000" — I only ping you when it moves. Or set a target: "watch btc: bitcoin below 50000", "watch eth: ethereum above 4000", "watch ps5: the PS5 back in stock" — I ping once when it crosses. /alerts lists them, /forget-alert <name> stops one. Retune one anytime: "change btc to below 45000" or "make ps5 fire under 200".

Follow a feed: I ping you only when a NEW post/story/video/release shows up. Works with:
• a subreddit ("follow r/programming") or a Reddit user ("follow reddit.com/user/spez")
• Hacker News ("follow HN", "follow HN rust" for a topic)
• a GitHub repo's releases ("follow github.com/rust-lang/rust")
• any blog/RSS link ("follow https://blog.example.com/feed")
• a YouTube channel — paste the channel URL (youtube.com/channel/UC…); an @handle link needs the channel URL, so I'll fetch it the slow way if that's all you have.
/alerts lists your follows, /forget-alert <name> stops one.

Watch for NEW items in a list: "watch jobs: remote react roles for new listings" or "watch deals: new deals on OLED TVs" — I ping you only when a NEW entry shows up (not on every check). Great for job boards, listings, restocks, releases.

Watch the weather: "watch umbrella: if it rains tomorrow", "watch cold: if it's below freezing tonight", "watch heat: if it gets above 95 today" — I check the forecast and ping you once if it's going to happen. Add "in <city>" for somewhere other than your saved location.

Watch, then DO: add "then run <recipe>" to any watch — "watch jobs: new remote roles for new listings then run summarize-jobs" — and when it fires I'll also run that saved recipe and include its result.

Watch a whole list at once: separate items with semicolons — "watch markets: btc price; eth price; gold price" — and I track them as one watchlist, sending a single update with only the ones that moved.

See a watch's trend: "how has btc moved this week" or "btc trend" — I summarize the value from my logged checks (first→last, high/low), no re-fetch. Or "chart btc" / "graph my btc watch" for an actual line-chart image. Once a price watch has some history, each ping also tells you where it sits — "lowest in 30 days" or "near its high" — so you know if it's a good time.

Pause without deleting: "snooze btc 3 days", "pause my morning digest" (until you resume it), or "snooze all" quiets an automation through travel or noise — say "resume btc" to turn it back on. The setup stays intact; nothing fires while paused.

Tap, don't type: when I ping you about a watch, briefing, or scheduled task, I attach one-tap buttons — 🔄 Refresh / 💤 Snooze 1d / 🔕 Stop on a watch, and 🔁 Run again on a briefing or recipe. And when I answer with a numbered list of options (flights, listings, sizes), each gets a 1/2/3 button — tap one to pull it up with its link, no retyping. After a normal answer I also offer 🔁 Every morning (get it daily) and, for a price/number, 🔔 Watch this (ping me when it changes) — one tap, no syntax to learn.

See everything at once: /dashboard rolls up all your reminders, watches, digests, and recipes in one view — what fires next, what each watch last saw, and what's paused.

Set your location: "/setlocation Austin, TX" (or just "I'm in London") so "weather" and "near me" work without repeating the city. I use metric or imperial based on the place (°C for Paris, °F for the US); add "(metric)" or "(imperial)" to force one — or just say "use metric" / "switch to fahrenheit" anytime — and "UTC-5" so daily reminders fire at YOUR local time. /profile shows what's stored; "/profile clear" forgets it.

Save named places: "my work is 500 5th Ave", "save gym: Gold's on Main" — then "weather at the gym", "coffee near work", "directions to work" all resolve without retyping the address. "what places do you have" lists them; "forget my work address" removes one.

Remember things about you: "remember I'm vegetarian", "remember my wife's birthday is June 3" — I'll factor them into every answer. Ask "what do you know about me" to see them; "forget that I'm vegetarian" or "forget everything you know" to clear.

Keep a list: "add eggs to my grocery list", "add milk and bread to groceries" — I'll keep a running list you can read back with "what's on my grocery list", drop from with "remove eggs from my list", or wipe with "clear my list". Handy for groceries, packing, to-dos. Say "export my grocery list as csv" to get it as a spreadsheet file you can keep.

Track anything about yourself: "log weight 182", "spent $14 on lunch", "log mood 7" — then "show my weight this month" (I'll chart it) or "how much did I spend on food this week" (I'll total it). Great for weight, spending, habits, sleep.

Recall a past answer: "what was that sushi place you found?" or "resend the flights" — I search what I've told you before, no need to re-run it.

Save pages to read later: "save this <link>" — I summarize the page + file it, then "what did I save about <topic>" or "my reading list" searches your saved pages anytime. Builds a personal, searchable library from what you send me. Add "reading list" as a digest member ("define digest morning: weather, reading list") to get a recap of recent saves in your briefing. Ask "what haven't I read" to see saved pages you never got back to, or "nudge me about my reading list" and I'll ping you weekly about forgotten saves ("stop reading list nudges" to turn it off).

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
// Widened (product-loop) to catch the phrasings people ACTUALLY open with — the old regex missed
// "what's this", "what does this do", "who are you", "how do you work", wasting the first message on a
// slow browse. Still anchored + gated by the <=6-word cap in handleCommand so a real task like "what can
// you tell me about X" (longer) or "how do I reset my router" (no you/this/it subject) falls through.
// Anchored so the WHOLE message is the question (no greedy noun tail — "what does this error mean" must
// NOT match). Only a small closing filler ("do/for/exactly/then/really") may trail the subject.
const CAP_TAIL = "(?:\\s+(?:do|for|exactly|then|really|actually))?\\s*[!.?]*$";
const CAPABILITY_RE = new RegExp(
  "^(?:" +
    "what(?:'?s| is)\\s+(?:this|it)(?:\\s+bot)?" +                       // what's this / what is this bot
    "|what(?:'?s| does)\\s+(?:this|it|relay)(?:\\s+bot)?\\s+do(?:es)?" + // what does this do / what's this bot do
    "|what\\s+(?:can|do)\\s+(?:you|u|this|it|relay)(?:\\s+bot)?\\s+do" + // what can you do / what do you do
    "|who\\s+(?:are|r)\\s+(?:you|u|this)" +                              // who are you / who r u
    "|how\\s+(?:do|does)\\s+(?:you|this|it|relay)\\s+work" +             // how do you work
  ")" + CAP_TAIL,
  "i",
);

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
const META_RE = /^(?:(?:are|r)\s+(?:you|u)\s+(?:a\s+)?(?:real|human|person|bot|ai|robot|chat\s?gpt|gpt|claude|gemini|an?\s+llm)|is\s+(?:this|it)\s+free|(?:is\s+it|are\s+you)\s+free\s+to\s+use|how\s+much\s+(?:do(?:es)?\s+(?:you|this|it)\s+cost|is\s+(?:this|it))|(?:do\s+(?:you|u)|is\s+there)\s+(?:have\s+)?an?\s+app|is\s+this\s+(?:safe|a\s+(?:bot|scam|person))|do\s+(?:you|u)\s+(?:save|store|keep|sell|share|record)\s+(?:my\s+)?(?:messages?|data|chats?|info)|who\s+(?:made|built|created|owns)\s+(?:you|this)|are\s+(?:you|u)\s+safe|is\s+my\s+data\s+safe)[\s\w']*\??$/i;

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

// An explicit "examples / what else can you do / what should I ask" — a new user who's read the greeting
// and wants concrete things to try. Falling through ran it as a slow browse and wasted the moment; the
// START card already IS a grouped list of real examples, so route these straight to it (onboarding-examples).
const EXAMPLES_RE = /^(?:(?:show|give)\s+(?:me\s+)?(?:some\s+|an?\s+)?examples?|examples?|what\s+else\s+can\s+(?:you|u)\s+do|what\s+should\s+i\s+(?:ask|say|try)(?:\s+you)?|what\s+can\s+i\s+ask(?:\s+you)?|(?:some\s+)?ideas)[!.?]*$/i;

// A bare acknowledgment ("thanks", "cool", "nice", "ok thanks") — the natural close after an answer.
// It has no task in it, so running it as a browser turn is wrong (a slow floundering search of "thanks");
// a short warm ack keeps the conversation human + invites the next errand (onboarding-ack).
const ACK = `Anytime! 🙌 Text me whenever you need something — a lookup, a reminder, a price to watch, whatever comes up.`;
const ACK_RE = /^(?:(?:ok(?:ay)?|alright|great|awesome|perfect|cool|nice|sweet|lovely|amazing|excellent)\s+)?(?:thanks?|thank\s+you|thx|ty|tysm|cheers|much\s+appreciated|appreciate\s+it)(?:\s+(?:so\s+much|a\s+lot|mate|friend|relay|buddy))?[!.]*$|^(?:cool|nice|sweet|awesome|great|perfect|excellent|amazing|that'?s\s+(?:cool|nice|great|awesome|helpful|perfect))[!.]*$/i;

/** Returns a canned reply for /start, /help, a bare greeting/capability question, a meta/trust
 * question, or a can't-do capability probe; else null. */
export function handleCommand(text: string): string | null {
  const t = text.trim().toLowerCase();
  // Telegram commands can carry a bot suffix, e.g. /help@relaybot
  const cmd = t.split(/\s+/)[0]?.split("@")[0];
  if (cmd === "/start") return START;
  if (cmd === "/help" || cmd === "/menu" || cmd === "/commands") return withConfirmHelp(HELP);
  // Bare "help" / "menu" / "commands" / "?" (no slash) — a new user asking for the list without
  // knowing the slash syntax. Whole-message only so "help me plan X" (a real task) still runs.
  if (/^(?:help|menu|commands|\?+)$/i.test(t)) return withConfirmHelp(HELP);
  // Greet a new user who opened with "hi" / "what can you do?" instead of the /start they don't know.
  // Keep it short (<= 6 words) so a longer sentence that merely starts with "how do you" is a real task.
  if (t.split(/\s+/).length <= 6 && (GREETING_RE.test(t) || CAPABILITY_RE.test(t))) return START;
  // "examples" / "what else can you do" / "what should I ask" -> the START card IS the grouped examples
  // list (onboarding-examples). Bounded so "give me examples of Python decorators" (a real ask) runs.
  if (t.split(/\s+/).length <= 7 && EXAMPLES_RE.test(t)) return START;
  // A bare "thanks" / "cool" close -> a warm ack, not a wasted browse turn (onboarding-ack).
  if (t.split(/\s+/).length <= 5 && ACK_RE.test(t)) return ACK;
  // Meta/trust question -> honest fixed reply (bounded length so a real errand isn't swallowed).
  if (t.split(/\s+/).length <= 8 && META_RE.test(t)) return META;
  // Can't-do capability probe -> honest reply + pivot to what it CAN do.
  if (t.split(/\s+/).length <= 10 && PROBE_RE.test(t)) return PROBE;
  // Site-named capability probe ("do you work with Amazon?") -> public-pages + cookie-auth answer.
  if (t.split(/\s+/).length <= 8 && SITE_RE.test(t)) return SITE;
  return null;
}
