// Agent loop. An LLM plans over tools to answer the user, driving the self-hosted
// anvil browser. The LLM sits behind LLMClient so Claude can replace Gemini in one
// line. Two modes of browser use:
//   - scrape(url): one-shot fetch of a page's text (own session, auto-released).
//   - browse/click/type/read: a PERSISTENT session held for the task, so the agent
//     can navigate -> click -> read across steps (multi-step browsing).
// Bounded by RELAY_MAX_STEPS. Destructive clicks/typing are gated by the
// dangerous-action guard (safety.ts).

import * as anvil from "./anvil.js";
import { isUrlSafe, safeFetch } from "./lib/url-validator.js";
import { intEnv } from "./lib/env.js";
import { isDangerousAction } from "./safety.js";
import { confirmToActEnabled, formatConfirmPrompt, CONFIRM_TTL_MS } from "./lib/confirm-action.js";
import { fetchYouTubeTranscript } from "./lib/youtube.js";
import { rowsToCsv } from "./lib/to-csv.js";
import { convertCurrency as fxConvert, formatConversion } from "./lib/fx.js";
import { getQuote as quoteFetch, formatQuote } from "./lib/quote.js";
import { getCryptoQuote as cryptoFetch, formatCrypto } from "./lib/crypto.js";
import { lookupWord as dictFetch, formatDefinition } from "./lib/dictionary.js";
import { getFact as factFetch, formatFact } from "./lib/wikifact.js";
import { getNutrition as nutritionFetch, formatNutrition } from "./lib/nutrition.js";
import { parseWatchQuery, formatWatchWhere } from "./lib/watch-where.js";
import { parseWorldClock, runWorldClock } from "./lib/worldclock.js";
import { parseTimeUntil, runTimeUntil } from "./lib/timeuntil.js";
import { runDateCalc, type Ymd } from "./lib/datecalc.js";
import { getScores as scoresFetch, formatScores, getNextGame as nextGameFetch, formatNextGame, wantsNextGame } from "./lib/scores.js";
import { getNews as newsFetch, formatNews } from "./lib/news.js";
import { getFun as funFetch } from "./lib/fun.js";
import { calc, formatResult } from "./lib/calc.js";
import { parseTranslateRequest, translate } from "./lib/translate.js";
import { runConvert } from "./lib/units-convert.js";
import { runUnitPrice } from "./lib/unitprice.js";
import { parseMealRequest, getMeals, formatMealIdeas, formatFullMeal } from "./lib/meals.js";
import { getSunTimes as sunFetch, formatSunTimes, sunPlace } from "./lib/suntimes.js";
import { getAirQuality as airFetch, formatAirQuality, airPlace, isUvRequest, isPollenRequest } from "./lib/airquality.js";
import { renderQr, parseQrRequest } from "./lib/qr.js";
import { parseRandomRequest, runRandom } from "./lib/random.js";
import { parsePasswordRequest, generateSecret, formatSecret } from "./lib/password.js";
import { randomInt as cryptoRandomInt } from "node:crypto";
import { parseEncodingRequest, runEncoding, formatEncoding } from "./lib/encoding.js";
import { detectCarrier, trackingUrl, carrierName } from "./lib/tracking.js";
import { detectFlight, getFlight as fetchFlight, formatFlight } from "./lib/flight.js";
import { relativeAge } from "./lib/answer-log.js";
import { getWeather as fetchWeather, formatWeather, formatWeatherWhen, formatWeatherHourly } from "./lib/weather.js";
import { formatDraft, type Draft } from "./lib/compose.js";
import { findNearby as fetchNearby, formatPlaces } from "./lib/places.js";
import { getDirections as fetchDirections, formatRoute, routeMode, wantsTransit, transitMapsLink } from "./lib/directions.js";
import { resolveUnits } from "./lib/units.js";
import { formatCalendar, type CalEvent } from "./lib/calendar.js";

// Does the user's task ask for a keepable file (csv-export-compare)? A compare/extract then attaches
// a CSV document instead of only pasting a truncated JSON blob in chat.
const CSV_REQUEST_RE = /\b(csv|spreadsheet|excel|\.xlsx?|export|download(?:able)?|as a (?:file|table|sheet)|to a (?:file|sheet))\b/i;
import type { LLMClient, LLMMessage, ToolSpec, ToolCall } from "./llm.js";

/** Resolve RELAY_MAX_STEPS to a valid positive integer, else the default 8. An unclamped
 * Number(env) let a typo ("abc"→NaN), 0, or a negative silently make the step loop never run —
 * the agent would do ZERO steps and reply "ran out of steps" on every message = a dead bot (DEV-0161).
 * Thin wrapper over the shared intEnv primitive (DEV-0166). */
export function resolveMaxSteps(raw: string | undefined, fallback = 8): number {
  return intEnv(raw, { fallback, min: 1 });
}
const MAX_STEPS = resolveMaxSteps(process.env.RELAY_MAX_STEPS);

export const TOOLS: ToolSpec[] = [
  {
    name: "scrape",
    description: "Fetch the readable text of a single web page by URL. Best for reading one article/listing/docs page. Returns title + text.",
    parameters: { type: "object", properties: { url: { type: "string", description: "Absolute http(s) URL" } }, required: ["url"] },
  },
  {
    name: "browse",
    description: "Open a page in a persistent browser session for MULTI-STEP interaction (then use click/type/read). Use when a task needs clicking or typing, not just reading. Returns the page title.",
    parameters: { type: "object", properties: { url: { type: "string", description: "Absolute http(s) URL to open" } }, required: ["url"] },
  },
  {
    name: "click",
    description: "Click an element on the current browsed page by CSS selector. Requires a prior browse. Destructive/committing actions (pay, delete, submit, logout) are refused.",
    parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector" }, label: { type: "string", description: "Human label of what you're clicking, for the safety check" } }, required: ["selector"] },
  },
  {
    name: "type",
    description: "Type text into an input on the current browsed page by CSS selector. Requires a prior browse.",
    parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector of the input" }, text: { type: "string", description: "Text to type" } }, required: ["selector", "text"] },
  },
  {
    name: "read",
    description: "Read the current browsed page's text after navigating/clicking. Requires a prior browse.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "extract",
    description: "Fetch a page and pull out specific structured fields as clean JSON. Use when the user wants particular data points (e.g. price, title, rating) rather than prose. Returns a JSON object keyed by the requested fields; a field not found is null.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to read" },
        fields: { type: "array", items: { type: "string" }, description: "Field names to extract, e.g. [\"price\",\"title\"]" },
      },
      required: ["url", "fields"],
    },
  },
  {
    name: "compare",
    description: "Fetch SEVERAL pages and extract the same fields from each, returning a JSON array (one object per URL, plus its url). Use for 'compare X across these links' tasks. Capped at a few URLs.",
    parameters: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "Absolute http(s) URLs to compare (max 5)" },
        fields: { type: "array", items: { type: "string" }, description: "Field names to extract from each, e.g. [\"price\",\"title\"]" },
      },
      required: ["urls", "fields"],
    },
  },
  {
    name: "fetch_json",
    description: "GET a JSON HTTP API directly (no browser) and return the JSON. Fastest for public data APIs — weather, prices, sports, etc. Use when you know a JSON endpoint; falls back to scrape/browse for HTML pages. Only http(s), JSON responses, size-capped.",
    parameters: { type: "object", properties: { url: { type: "string", description: "Absolute http(s) URL of a JSON API endpoint" } }, required: ["url"] },
  },
  {
    name: "convert_currency",
    description: "Convert an amount between two currencies at the live exchange rate (no key, instant). Use this — NOT web_search/scrape — for any \"X USD in EUR\", \"how much is £50 in dollars\", \"convert 100 CAD to JPY\" question. Currencies are 3-letter ISO codes (USD, EUR, GBP, JPY, CAD, AUD, INR, ...).",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount to convert (default 1)" },
        from: { type: "string", description: "3-letter source currency code, e.g. USD" },
        to: { type: "string", description: "3-letter target currency code, e.g. EUR" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_quote",
    description: "Get the latest stock/equity price for a ticker symbol (no key, instant). Use this — NOT web_search/scrape — for any \"what's Tesla at\", \"AAPL price\", \"how's NVDA doing\", \"price of Apple stock\" question. Pass the ticker symbol (AAPL, TSLA, NVDA, MSFT); for a non-US listing add a market suffix (VOD.UK, CBA.AU).",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker symbol, e.g. \"AAPL\" or \"TSLA\". Non-US: add a market suffix like \"VOD.UK\"." } },
      required: ["symbol"],
    },
  },
  {
    name: "random",
    description: "Flip a coin, roll dice, pick a random number, choose randomly between options, or generate a random UUID/GUID — use for \"flip a coin\", \"roll a d20\", \"random number 1-100\", \"pick one: tacos or sushi\", \"generate a uuid\". Genuinely random (don't make one up yourself). Pass the user's request verbatim.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The user's random/decision ask, e.g. \"flip a coin\", \"roll 2d6\", \"pick between A and B\"." } },
      required: ["request"],
    },
  },
  {
    name: "generate_password",
    description: "Generate a genuinely-random, cryptographically-strong password or passphrase — use for \"generate a password\", \"make me a strong 24-character password\", \"a passphrase\", \"random PIN\". NEVER invent a password yourself (a made-up one isn't secure). Pass the user's request verbatim (it carries the length + any \"no symbols\"/\"digits only\"/\"passphrase\" preference). Relay never stores it.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The user's password ask, e.g. \"strong 20 char password\", \"passphrase\", \"password no symbols\", \"6 digit pin\"." } },
      required: ["request"],
    },
  },
  {
    name: "encode_decode",
    description: "Encode or decode text: base64 / base64url / URL-encoding / hex / ROT13, hash with sha256/sha1/md5, or read a JWT's payload. Use for \"base64 encode X\", \"decode this base64 ...\", \"url encode ...\", \"hex decode ...\", \"sha256 of X\", \"md5 of X\", \"rot13 ...\", \"decode this jwt ...\". Exact + deterministic (don't compute a hash or encoding yourself — it's error-prone and a wrong hash looks right). Pass the user's request verbatim (it carries the codec + the payload). Hashes are one-way (can't be reversed); for JWT it reads the payload only, never verifies the signature.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The user's encode/decode ask incl. the payload, e.g. \"base64 encode hello\", \"decode this base64: aGk=\", \"decode this jwt eyJ...\"." } },
      required: ["request"],
    },
  },
  {
    name: "get_crypto",
    description: "Get the current price + 24h change of a cryptocurrency (no key, instant). Use this — NOT get_quote (that's stocks) or web_search — for any \"price of bitcoin\", \"what's ETH at\", \"how's dogecoin doing\", \"BTC price\" question. Pass the coin ticker or name (btc, bitcoin, eth, sol, doge).",
    parameters: {
      type: "object",
      properties: { coin: { type: "string", description: "Coin ticker or name, e.g. \"BTC\", \"bitcoin\", \"ethereum\", \"doge\"." } },
      required: ["coin"],
    },
  },
  {
    name: "translate",
    description: "Translate text — or a whole web page — into another language. Use this for \"translate X to Spanish\", \"how do you say X in Japanese\", \"read me this page in English: <url>\". Pass the user's request verbatim; I detect the target language + the text or URL. Adds a pronunciation line for a short phrase into a non-Latin script.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The user's translate request verbatim, e.g. \"translate 'where is the pharmacy' to Portuguese\" or \"translate this page to English: <url>\"." } },
      required: ["request"],
    },
  },
  {
    name: "meal_ideas",
    description: "Get cooking meal ideas or a recipe (no key, instant). Use this — NOT web_search — for \"what can I make with chicken\", \"dinner ideas\", \"random meal\", \"recipe for carbonara\", \"how do I make lasagna\". Returns dish ideas by ingredient, or a full recipe (ingredients + steps) for a named dish or a random pick. NOTE: this is FOOD — not Relay's saved automation 'recipes' (/recipes). Pass the request verbatim.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The food request verbatim, e.g. \"what can I make with chicken and rice\" or \"recipe for pad thai\"." } },
      required: ["request"],
    },
  },
  {
    name: "convert_units",
    description: "Convert between units of measure EXACTLY (no key, instant) — temperature, length, weight/mass, volume, cooking, data size, and SPEED. Use this — NOT mental math or web_search — for \"180C to F\", \"5 foot 11 in cm\", \"2 cups of flour in grams\", \"10 miles in km\", \"3 lb in kg\", \"100 km/h to mph\", \"50 knots to mph\". NOT for currency (use convert_currency). Pass the user's request verbatim.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The conversion verbatim, e.g. \"180C to F\" or \"2 cups in ml\"." } },
      required: ["request"],
    },
  },
  {
    name: "unit_price",
    description: "Compare two+ package sizes/prices and name the better buy by price-per-unit EXACTLY (no key, instant). Use this — NOT mental math — for \"which is cheaper, 500g for $4 or 1.2kg for $9\", \"$3.99 for 12oz vs $5.49 for 20oz\", \"better deal: 12 for $6 or 30 for $13\". Handles weight/volume/length/count; normalizes mixed units. Pass the user's question verbatim.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The compare question verbatim, e.g. \"500g for $4 or 1.2kg for $9\"." } },
      required: ["request"],
    },
  },
  {
    name: "calculate",
    description: "Evaluate an arithmetic/financial expression EXACTLY (no key, instant). Use this — do NOT do the mental math yourself — for anything beyond a trivial one-step sum: chained math, splitting a bill, tips, percentages (\"20% of 47\", \"$127.50 split 3 ways +20% tip\"), or a loan payment (loanpayment(principal, annualRatePct, years)). Supports + - * / % ^, parens, sqrt/round/abs/min/max/pow/loanpayment. Pass the expression; I compute it deterministically.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string", description: "The math to compute, e.g. \"(127.50*1.2)/3\" or \"loanpayment(30000, 6, 5)\"." } },
      required: ["expression"],
    },
  },
  {
    name: "get_news",
    description: "Get today's top news headlines, or headlines about a topic (no key, instant). Use this — NOT web_search/scrape — for \"what's the news\", \"top headlines\", \"news about the election\", \"latest on <topic>\". Pass an optional topic (omit for general top stories).",
    parameters: {
      type: "object",
      properties: { topic: { type: "string", description: "Optional topic to filter headlines, e.g. \"AI\" or \"the election\". Omit for general top headlines." } },
      required: [],
    },
  },
  {
    name: "get_fun",
    description: "Get a joke, a fun fact, or a trivia question (no key, instant). Use this — NOT web_search or your own memory — for \"tell me a joke\", \"fun fact\", \"random fact\", \"trivia question\", \"quiz me\". Pass the user's request verbatim; I pick joke/fact/trivia from it.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The user's request verbatim, e.g. \"tell me a joke\" or \"give me a fun fact\"." } },
      required: ["request"],
    },
  },
  {
    name: "get_scores",
    description: "Get sports scores/schedule for a league or team (no key, instant). Use this — NOT web_search/scrape — for \"did the Lakers win\", \"Man City score\", \"NBA scores\", \"who's playing tonight\", \"is the game on\", AND for upcoming games: \"when do the Lakers play next\", \"next Arsenal game\", \"upcoming NFL games\". Pass the user's request verbatim (a team or league name); include their \"next\"/\"upcoming\"/\"when do they play\" wording so it returns the next fixture. Covers NBA/NFL/MLB/NHL/NCAA + major soccer leagues.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The user's sports question verbatim, e.g. \"did the Lakers win\" or \"Premier League scores\"." } },
      required: ["request"],
    },
  },
  {
    name: "define",
    description: "Look up a word's definition, pronunciation, and synonyms (no key, instant). Use this — NOT web_search/scrape — for any \"what does X mean\", \"define X\", \"meaning of X\", \"synonyms for X\", \"how do you spell/pronounce X\" question. English words only. Pass the single word.",
    parameters: {
      type: "object",
      properties: { word: { type: "string", description: "The single English word to define, e.g. \"obsequious\" or \"escrow\"." } },
      required: ["word"],
    },
  },
  {
    name: "where_to_watch",
    description: "Find where a movie/TV show is streaming, to rent, or to buy (keyless, instant). Use this — NOT web_search/scrape, and NEVER claim a specific service from memory — for \"where can I watch X\", \"is X on Netflix\", \"how do I stream X\". Returns a JustWatch link with accurate per-region availability (it changes constantly + varies by country, so the link is the source, not a guess). Pass the TITLE. For a rating or plot, use get_fact instead.",
    parameters: {
      type: "object",
      properties: { title: { type: "string", description: "The movie/show title, e.g. \"Dune Part Two\", \"Oppenheimer\"." } },
      required: ["title"],
    },
  },
  {
    name: "get_nutrition",
    description: "Look up a food's calories + macros (protein/carbs/fat) from USDA data (no key, instant). Use this — NOT web_search/scrape, and NEVER guess from memory — for \"calories in X\", \"how much protein in X\", \"carbs in a Big Mac\", \"is X healthy\" (get the numbers first). Returns per-100g figures for the closest match + a source note. Pass the food name. If it returns nothing, say you're not sure rather than inventing numbers.",
    parameters: {
      type: "object",
      properties: { food: { type: "string", description: "The food to look up, e.g. \"banana\", \"chicken breast\", \"Big Mac\"." } },
      required: ["food"],
    },
  },
  {
    name: "get_fact",
    description: "Look up a quick factual answer from Wikipedia (no key, instant, cited). Use this — NOT web_search/scrape — for \"who is X\", \"what is X\", \"how tall/big/old is X\", \"when was X\", \"tell me about X\" general-knowledge questions. Returns a one-paragraph summary + a source link. Pass the ENTITY or topic, not the whole sentence (\"CEO of OpenAI\" not \"hey who's the ceo of openai again\"). Falls back — if it can't find or the term is ambiguous, use web_search.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The entity/topic to look up, e.g. \"Mount Everest\", \"Roth IRA\", \"CEO of OpenAI\"." } },
      required: ["query"],
    },
  },
  {
    name: "get_time",
    description: "Get the current time in another city/timezone, convert a time between zones, OR count down to a clock time today (\"how long until 5pm\", \"minutes until midnight\") — no key, instant. Use this — NOT web_search — for \"what time is it in Tokyo\", \"time in London\", \"9am PT in London\", \"convert 3pm EST to Tokyo\", \"how long until 5pm\". Pass the user's request verbatim. (City/region answers are daylight-saving-correct; a typed abbreviation like PST/EST is taken as-is.)",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The user's time question verbatim, e.g. \"what time is it in Tokyo\" or \"9am PT in London\"." } },
      required: ["request"],
    },
  },
  {
    name: "date_math",
    description: "Compute dates and calendar math EXACTLY (no key, instant). Use this — do NOT count in your head or web_search — for \"how many days until Christmas / my birthday / July 4\", \"what day of the week is/was <date>\", \"how old is someone born <date>\", \"how many days between <date> and <date>\", \"what's the date in 10 days\". Knows common US holidays by name (Christmas, Thanksgiving, Halloween, July 4th, New Year's, Valentine's...). Pass the user's question verbatim; I use the user's local date as \"today\".",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The user's date/calendar question verbatim, e.g. \"how many days until Christmas\" or \"what day is July 4 2026\"." } },
      required: ["request"],
    },
  },
  {
    name: "recall",
    description: "Search what I've PREVIOUSLY told this user (my own past answers) — use for \"what was that restaurant you found\", \"the flight price you got me last week\", \"resend the article\", or any reference to something I said earlier that isn't in the current conversation. Returns past answers with how long ago. NOT for facts the user told me about themselves.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Keywords for the thing to recall, e.g. \"sushi restaurant\" or \"Lisbon flights\"." } },
      required: ["query"],
    },
  },
  {
    name: "save_page",
    description: "Save a web page to the user's read-it-later list so they can recall it later (\"what did I save about X\" / \"my reading list\"). Use this when the user asks to SAVE/BOOKMARK/keep a page — including one you JUST found for them (\"find a good pasta recipe and save it\", \"bookmark that\"). Pass the exact URL; optionally a short title + a 1-2 sentence summary of what it is (if you omit them I'll derive them). Only save a real page the user wants kept — never a search-results or junk URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The exact http(s) URL of the page to save." },
        title: { type: "string", description: "Optional short title for the page." },
        summary: { type: "string", description: "Optional 1-2 sentence gist of the page, for later recall." },
      },
      required: ["url"],
    },
  },
  {
    name: "track_package",
    description: "Track a shipment by its tracking number (UPS/FedEx/USPS/DHL) — use this for any \"where's my package\", \"track 1Z...\", \"track my order 9400...\" request. I detect the carrier from the number's shape + read the carrier's official tracking page. Pass the tracking number as given; optionally name the carrier if you know it.",
    parameters: {
      type: "object",
      properties: {
        number: { type: "string", description: "The tracking number, e.g. \"1Z999AA10123456784\" or \"9400111899223817612345\"." },
        carrier: { type: "string", description: "Optional: ups | fedex | usps | dhl, if the user named it (overrides shape detection)." },
      },
      required: ["number"],
    },
  },
  {
    name: "get_flight",
    description: "Look up a flight by its number (keyless, instant). Use this — NOT web_search/scrape — for \"is AA100 on time\", \"where's flight UA83\", \"when does DL215 land\", \"what's the status of BA286\". Returns the airline + route (from → to) and whether it's airborne right now, plus a live-tracker link. It CANNOT get scheduled gate/terminal or an on-time-vs-delayed verdict (no keyless source) — report the route + airborne status honestly and give the tracker link for the rest; don't invent a gate or a delay.",
    parameters: {
      type: "object",
      properties: {
        flight: { type: "string", description: "The flight number, e.g. \"AA100\", \"UA 83\", \"BA286\"." },
      },
      required: ["flight"],
    },
  },
  {
    name: "get_weather",
    description: "Current weather, today's high/low, a per-hour rain-timing view, AND up to a 7-day forecast for a place (keyless, instant). Use this — NOT web_search/scrape — for any \"weather\", \"forecast\", \"will it rain [this afternoon/tonight/at 3pm/tomorrow]\", \"how hot is it\" question. Pass the city name; if the user gave no place but their location is known, omit place (it uses their saved coords). Pass `when` with the user's OWN words for a specific day OR time-of-day (\"tomorrow\", \"this weekend\", \"Saturday\", \"this afternoon\", \"tonight\", \"at 3pm\", \"later today\") so I report the RIGHT window, not just today's max.",
    parameters: {
      type: "object",
      properties: {
        place: { type: "string", description: "City/place name, e.g. \"Austin\" or \"Paris, France\". Omit to use the user's saved location." },
        when: { type: "string", description: "Optional day OR time-of-day phrase from the user's question: \"tomorrow\", \"this weekend\", \"Saturday\", \"this afternoon\", \"tonight\", \"at 3pm\", \"later today\". Omit for current/today's weather." },
      },
      required: [],
    },
  },
  {
    name: "get_suntimes",
    description: "Sunrise, sunset, and daylight length for a place + day (keyless, instant). Use this — NOT web_search — for \"what time is sunset\", \"when's sunrise tomorrow\", \"is it dark by 7\", \"how much daylight today\". Pass the user's request verbatim; omit place to use their saved location. Add \"tomorrow\" for the next day.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The sun/daylight question verbatim, e.g. \"what time is sunset in Denver\" or \"sunrise tomorrow\"." } },
      required: ["request"],
    },
  },
  {
    name: "get_air_quality",
    description: "Air quality (US AQI + PM2.5/smoke), the current UV index, AND pollen (Europe only) for a place (keyless, instant). Use this — NOT web_search/scrape — for \"how's the air\", \"is it smoky\", \"air quality\", \"AQI\", \"is it safe to run outside\", \"what's the UV\", \"do I need sunscreen\", \"pollen today\", \"allergies\". Pass the user's request verbatim; omit place to use their saved location.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The air-quality/UV question verbatim, e.g. \"is the air bad in LA\" or \"do I need sunscreen today\"." } },
      required: ["request"],
    },
  },
  {
    name: "search",
    description: "Open a search or listing page and get back candidate result links (deduped, same-site preferred, capped). Use when the user names WHAT they want but not the exact URLs — then extract/compare across the returned links. Provide a search-results URL (build the site's query URL, e.g. https://news.ycombinator.com/newest or a site search).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL of a search/listing page" },
        limit: { type: "number", description: "Max links to return (default 10, max 20)" },
      },
      required: ["url"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for a plain-language query and get back the top results (title, url, snippet) — NO url needed. Use this FIRST whenever the user asks an open question and hasn't named a site or link (\"who won the game\", \"cheapest flight to X\", \"best sushi near me\", \"what is Y\"). Then scrape/extract the most relevant result URL for details.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain-language search query" },
        limit: { type: "number", description: "Max results (default 6, max 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "find_nearby",
    description: "Find places near the user (or near a named area): coffee, restaurants, pharmacy, ATM, gas, grocery, etc. Use this — NOT web_search/scrape — for any \"X near me\", \"nearest Y\", \"coffee nearby\" question. Returns names + distance (+ hours/phone when known). Needs the user's location (a shared pin) OR a `near` area name.",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", description: "What to find, e.g. \"coffee\", \"nearest pharmacy\", \"gas station\"" },
        near: { type: "string", description: "Area/place to search around, e.g. \"downtown Austin\". Omit to use the user's saved location." },
      },
      required: ["what"],
    },
  },
  {
    name: "directions",
    description: "Distance + travel time between two places. Use this — NOT web_search/scrape — for \"how far is X\", \"directions to Y\", \"how long to drive to Z\", and transit asks (\"how long by subway/bus/train\"). Omit `from` to start from the user's location. Modes: driving (default), walking, cycling. For a public-transit ask it returns a Google Maps transit link (it can't compute transit times itself).",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destination place/address, e.g. \"the airport\", \"Denver\"" },
        from: { type: "string", description: "Start place. Omit to use the user's saved location." },
        mode: { type: "string", description: "driving | walking | cycling (default driving)" },
      },
      required: ["to"],
    },
  },
  {
    name: "compose",
    description: "Draft an email or text message for the user to review and SEND THEMSELVES (you never send it). Use when the user asks you to \"write/draft the email to X\", \"reply to this\", \"text Y that ...\". You write the body (and subject for email); this returns a copy block + a one-tap mailto:/sms: link. This is how Relay helps with correspondence without logging in or sending.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "\"email\" or \"message\" (SMS/text)" },
        to: { type: "string", description: "Recipient — an email address (email) or phone number (message). Optional." },
        subject: { type: "string", description: "Email subject line (email only). Optional." },
        body: { type: "string", description: "The full drafted message text you wrote." },
      },
      required: ["kind", "body"],
    },
  },
  {
    name: "calendar_event",
    description: "Turn an event/deadline/appointment into an add-to-calendar artifact (a Google Calendar link + an .ics file) for the user to import. Use when the user says \"add this to my calendar\", \"remind me on <date>\" as an event, or after you find an event they want to keep. You never touch their calendar — they tap to add.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        startMs: { type: "number", description: "Start as epoch ms for a TIMED event (UTC). Use the current-datetime context to compute it." },
        startDate: { type: "string", description: "OR an all-day date \"YYYY-MM-DD\" (no time)." },
        durationMin: { type: "number", description: "Timed event length in minutes (default 60)." },
        location: { type: "string", description: "Optional location." },
        description: { type: "string", description: "Optional details." },
      },
      required: ["title"],
    },
  },
  {
    name: "transcript",
    description: "Fetch the spoken transcript (captions) of a YouTube video by URL. Use this — NOT scrape — whenever the user gives a YouTube link (youtube.com/watch, youtu.be, /shorts) and wants it summarized, quoted, or answered from (\"summarize this video\", \"what does this video say about X\", \"tldr\"). Returns the plain transcript text; then summarize/answer from it. If captions are unavailable it says so.",
    parameters: { type: "object", properties: { url: { type: "string", description: "A YouTube video URL (watch/youtu.be/shorts)" } }, required: ["url"] },
  },
  {
    name: "make_qr",
    description: "Generate a QR code IMAGE for a link, text, or wifi string and send it to the user (keyless, instant). Use this — NOT a browse — for \"make a QR code for <link>\", \"QR for my wifi\", \"qr code for this text\". Pass the exact payload to encode (a URL, plain text, or a WIFI:...; string). After calling this, still call reply with a short caption.",
    parameters: { type: "object", properties: { payload: { type: "string", description: "The exact text/URL to encode in the QR code, e.g. \"https://mysite.com\" or \"WIFI:S:home;T:WPA;P:pass;;\"." } }, required: ["payload"] },
  },
  {
    name: "screenshot",
    description: "Capture a web page as an IMAGE and send it to the user. Use when the user wants to SEE a page (\"show me\", \"screenshot\", \"what does X look like\") rather than read its text. After calling this, still call reply with a short caption.",
    parameters: { type: "object", properties: { url: { type: "string", description: "Absolute http(s) URL to capture" } }, required: ["url"] },
  },
  {
    name: "pdf",
    description: "Render a web page to a PDF and send it to the user as a document. Use when the user wants to SAVE or KEEP a page (\"save as PDF\", \"send me a PDF of X\"). After calling this, still call reply with a short caption.",
    parameters: { type: "object", properties: { url: { type: "string", description: "Absolute http(s) URL to render" } }, required: ["url"] },
  },
  {
    name: "reply",
    description: "Send the final answer to the user and end the task. Call exactly once when done or when you must report you cannot complete it.",
    parameters: { type: "object", properties: { text: { type: "string", description: "Message to send the user" } }, required: ["text"] },
  },
];

const MAX_COMPARE_URLS = 5;
const MAX_SEARCH_LINKS = 20;

export const SYSTEM_PROMPT = `You are Relay, an assistant reached over text message. A user texts a task; use tools to accomplish it, then call "reply" with a concise, friendly answer (they're on a phone — keep it short, no markdown tables).

Tools:
- "scrape" (url): read a single page. Use for simple lookups. If the user names a site, infer the URL (Hacker News -> https://news.ycombinator.com).
- "browse" (url) then "click"/"type"/"read": for tasks needing interaction (search a site, fill a form, page through results). "read" returns the current page after your actions.
- "fetch_json" (url): hit a JSON HTTP API directly, no browser — fastest for public data APIs (weather, prices, sports). Use when you know a JSON endpoint; use scrape/browse for HTML pages.
- "extract" (url, fields): fetch a page and get back clean JSON for specific fields (price, title, rating...). Prefer this over "scrape" when the user wants particular data points, not a summary.
- "compare" (urls, fields): fetch several pages and extract the same fields from each; returns a JSON array. Use when the user wants to compare data points across multiple links.
- "web_search" (query): plain-language web search, NO url needed — use this FIRST for any open question where the user hasn't named a site or link ("who won...", "cheapest...", "best... near me", "what is..."). Returns top {title,url,snippet}; then scrape/extract the most relevant url.
- "search" (url): open a specific search/listing page and get candidate result links back. Use when you already know the site — build its search URL, call search, then extract/compare across the returned links.
- "make_qr" (payload): generate a QR code IMAGE for a link/text/wifi string + send it. Use for "make a QR for <link>", "QR for my wifi", "qr code for this text". Pass the exact payload to encode. Then call reply with a short caption.
- "screenshot" (url): capture a page as an IMAGE and send it. Use when the user wants to SEE a page ("show me", "screenshot", "what does X look like"), not read its text. Then call reply with a short caption.
- "pdf" (url): render a page to a PDF and send it as a document. Use when the user wants to SAVE or KEEP a page ("save as PDF", "send me a PDF of X"). Then call reply with a short caption.
- "transcript" (url): get a YouTube video's spoken transcript. Use this — NOT scrape — for any YouTube link the user wants summarized or answered from; scrape only sees YouTube's empty JS shell.
- "convert_currency" (amount, from, to): live currency conversion. Use this — NOT web_search — for any "X USD in EUR" / "convert 100 CAD to JPY" question; it's instant and exact.
- "get_time" (request): current time in another city/timezone, convert a time between zones, or count down to a clock time today ("how long until 5pm", "minutes until midnight"). Use this — NOT web_search — for "what time is it in Tokyo"/"time in London"/"9am PT in London"/"convert 3pm EST to Tokyo"/"how long until 5pm". Pass the request verbatim. City/region answers are daylight-saving-correct; a typed abbreviation (PST/EST) is taken as-is.
- "date_math" (request): date/calendar math EXACTLY. Use this — NOT mental counting or web_search — for "how many days until Christmas/my birthday/July 4", "what day of the week is/was <date>", "how old if born <date>", "days between two dates", "date in 10 days". Knows common US holidays by name. Reckons from the user's local today.
- "meal_ideas" (request): cooking meal ideas or a recipe. Use this — NOT web_search — for "what can I make with chicken"/"dinner ideas"/"random meal"/"recipe for X". FOOD, not Relay's saved automation recipes.
- "convert_units" (request): convert units of measure EXACTLY (temperature/length/weight/volume/cooking). Use for "180C to F"/"5 foot 11 in cm"/"2 cups in grams"/"10 miles in km". NOT currency (use convert_currency).
- "unit_price" (request): compare package sizes + name the better buy by price-per-unit EXACTLY. Use for "which is cheaper, 500g for $4 or 1.2kg for $9"/"$3.99 for 12oz vs $5.49 for 20oz"/"12 for $6 or 30 for $13". NOT mental math.
- "translate" (request): translate text or a whole page into another language. Use for "translate X to Spanish"/"how do you say X in Japanese"/"read me this page in English: <url>". Pass the request verbatim.
- "calculate" (expression): compute arithmetic/financial math EXACTLY. Use for chained math, bill-splits, tips, percentages, loan payments — anything past a trivial one-step sum (don't do it in your head, that's silently wrong). loanpayment(principal, annualRatePct, years) for a monthly payment.
- "get_news" (topic?): today's top news headlines, or about a topic. Use this — NOT web_search — for "what's the news"/"top headlines"/"news about X"/"latest on Y". Omit topic for general top stories.
- "get_fun" (request): a joke, fun fact, or trivia question. Use this — NOT web_search or your own memory — for "tell me a joke"/"fun fact"/"trivia"/"quiz me". Pass the request verbatim; I pick joke/fact/trivia.
- "get_scores" (request): sports scores/schedule for a league or team. Use this — NOT web_search — for "did the Lakers win"/"Man City score"/"NBA scores"/"who's playing tonight" AND upcoming games "when do the Lakers play next"/"next Arsenal game"/"upcoming NFL". Pass the request verbatim (keep their "next"/"when do they play" wording). Covers NBA/NFL/MLB/NHL/NCAA + major soccer.
- "define" (word): a word's definition, pronunciation, and synonyms. Use this — NOT web_search/scrape — for "what does X mean"/"define X"/"synonyms for X"/"how do you spell X". English words only; pass the single word.
- "get_fact" (query): a quick cited Wikipedia summary. Use this — NOT web_search — for "who is X"/"what is X"/"how tall/old/big is X"/"tell me about X" general-knowledge asks. Pass the ENTITY (not the whole sentence). Falls back to web_search on a miss/ambiguous term.
- "get_nutrition" (food): calories + macros from USDA. Use this — NOT web_search, NEVER guess — for "calories in X"/"protein in X"/"carbs in X"/"is X healthy". Per-100g for the closest match; say "not sure" on a miss instead of inventing numbers.
- "where_to_watch" (title): where a movie/show streams/rents/buys. Use this — NOT web_search, NEVER claim a service from memory — for "where can I watch X"/"is X on Netflix". Returns a JustWatch per-region link (the source of truth). For a rating/plot use get_fact.
- "recall" (query): search what I told this user BEFORE (my past answers) — use for "that restaurant you found", "the flights from last week", "resend the X"; returns past answers + how long ago. NOT for facts the user told me about themselves.
- "save_page" (url, title?, summary?): save a page to the user's read-it-later list. Use when they ask to save/bookmark/keep a page — including one I JUST found ("find a good X and save it", "bookmark that"). Pass the exact URL (+ optional title/summary). Never save a search-results or junk URL.
- "track_package" (number, carrier?): track a shipment. Use this — NOT web_search/scrape — for "where's my package"/"track 1Z..."/"track my order <number>". I detect UPS/FedEx/USPS/DHL from the number + read the official tracking page.
- "get_flight" (flight): flight route + live position by number. Use this — NOT web_search — for "is AA100 on time"/"where's UA83"/"when does DL215 land". Returns airline + from→to + airborne-now + a tracker link; it CAN'T get scheduled gate/on-time — report honestly, don't invent a gate/delay.
- "random" (request): flip a coin / roll dice / random number / pick from options / generate a uuid. Use this — NEVER invent a "random" value yourself — for "flip a coin", "roll a d20", "random number 1-100", "pick one: X or Y", "generate a uuid".
- "generate_password" (request): a cryptographically-strong random password/passphrase/PIN. Use this — NEVER make up a password yourself — for "generate a password", "strong 24-char password", "a passphrase", "6-digit pin". Relay never stores it.
- "encode_decode" (request): base64/base64url/URL/hex encode-or-decode, or read a JWT payload. Use this — NEVER compute an encoding yourself — for "base64 encode X", "decode this base64 ...", "url encode ...", "decode this jwt ...".
- "get_crypto" (coin): current crypto price + 24h change. Use this — NOT get_quote/web_search — for "price of bitcoin"/"what's ETH at"/"BTC price"/"how's doge doing". Pass the ticker or name (btc, eth, sol, doge).
- "get_quote" (symbol): latest stock/equity price. Use this — NOT web_search/scrape — for any "what's Tesla at"/"AAPL price"/"how's NVDA doing" question; it's instant. Pass the ticker (AAPL, TSLA); non-US add a market suffix (VOD.UK).
- "get_weather" (place?, when?): current weather, today's high/low, per-hour rain timing, + up to a 7-day forecast. Use this — NOT web_search/scrape — for any weather/forecast/"will it rain" question. Omit place to use the user's saved location. Pass "when" with the user's words for a day OR time-of-day ("tomorrow", "this weekend", "Saturday", "this afternoon", "tonight", "at 3pm", "later today") so the RIGHT window is reported, not just today's max.
- "get_suntimes" (request): sunrise/sunset/daylight for a place + day. Use this — NOT web_search — for "what time is sunset"/"when's sunrise tomorrow"/"is it dark by 7"/"how much daylight". Omit place to use the saved location; add "tomorrow" for the next day.
- "get_air_quality" (request): air quality (US AQI + smoke/PM2.5) + current UV index + pollen (Europe only). Use this — NOT web_search/scrape — for "how's the air"/"is it smoky"/"AQI"/"safe to run outside"/"what's the UV"/"do I need sunscreen"/"pollen today"/"allergies". Omit place to use the saved location.
- "find_nearby" (what, near?): find places near the user (coffee, pharmacy, ATM, gas...). Use this — NOT web_search — for "X near me"/"nearest Y". Omit near to use the user's location.
- "directions" (to, from?, mode?): distance + travel time between places. Use this — NOT web_search — for "how far is X"/"directions to Y"/"how long to drive to Z". Omit from to start from the user's location.
- "calendar_event" (title, startMs|startDate, ...): turn an event/deadline into an add-to-calendar link + .ics for the user to import ("add this to my calendar"). You never add it — pass the artifact verbatim.
- "compose" (kind, to?, subject?, body): draft an email/text for the user to SEND THEMSELVES (you write the body; it returns a copy block + a mailto:/sms: link). Use for "write/draft/reply to..." asks. You never send — pass the returned draft to the user verbatim in reply.
- "reply" (text): finish.

Rules:
- Prefer "scrape" for read-only lookups; use "browse" only when you must click or type.
- I will REFUSE destructive/committing clicks (pay, buy, delete, submit, logout, transfer). Don't attempt them; tell the user instead.
- Take few steps. When you have enough, call "reply".
- The user is on a phone. In "reply", write a short plain-text answer — never paste raw JSON. If you extracted/compared data, summarize it in a line or two (e.g. "A is $10, B is $20"). No markdown tables.
- If something needs a login or a paid/irreversible action, call "reply" and say so plainly. Never invent data you didn't retrieve.
- ANSWER DIRECTLY (call "reply" with NO tool first) when the answer is deterministic and needs no live data: a TRIVIAL one-step sum ("20% tip on $47" = $9.40), date/time math, and stable common knowledge ("capital of France"). Don't open a browser or search for these — it just adds 10-30s.
- Use "convert_units" (NOT mental math) for any unit/measure conversion — temperature, length, weight, volume, cooking, data size, speed ("180C to F", "5 foot 11 in cm", "2 cups in grams", "10 miles in km", "100 km/h to mph", "50 knots to mph"). Guessing these from memory is silently wrong.
- Use "calculate" (NOT mental math) for anything BEYOND a trivial one-step sum: chained math, splitting a bill, multi-step tips/percentages, or a loan payment — mental math on those is silently wrong. e.g. "$127.50 split 3 ways after 20% tip" -> calculate "(127.50*1.2)/3"; "monthly payment on a $30k loan at 6% for 5 years" -> calculate "loanpayment(30000, 6, 5)".
- Use OTHER tools when the answer is time-sensitive or uncertain: live prices, exchange rates that move (use "convert_currency" for FX), news, weather, anything "current"/"today"/"now". When unsure whether a fact is stable, verify with a tool rather than guess.
- OPERATE ON PASTED TEXT DIRECTLY (call "reply" with NO tool): when the user's message CONTAINS the text to work on — "summarize this: <text>", "make this shorter", "proofread/fix the grammar", "tl;dr", "rewrite this as …", "translate this to Spanish" — just do it on the text they gave you. Never web_search or scrape for text that's already in the message; that only adds delay and risks answering about a different thing.
- If the task is genuinely UNDERSPECIFIED — a real answer depends on details the user didn't give and you'd otherwise have to guess (e.g. "find me a good laptop" with no budget/use, "cheap flights to Lisbon" with no dates/origin, "book a table" with no time/size) — do NOT burn steps on a guess. Call "reply" with ONE short question naming the 1-2 things you need, then stop. Ask at most once, only when a sensible default truly doesn't exist; if the request is clear or a reasonable default works ("weather" -> their location, "top HN story"), just do it.
- CITE YOUR SOURCE: when the answer came from a page you fetched (scrape/extract/browse/search result), end "reply" with a final line "Source: <url>" — the single primary URL you got the fact from, exactly as fetched (never invent or guess a link). One source is enough. Skip it for direct calc/conversion/known-fact answers, and skip it if you genuinely didn't fetch a page. This lets the user verify the answer.`;

// Injectable browser backend so tests run offline without anvil.
export interface BrowserBackend {
  scrape(url: string): Promise<{ title: string; content: string; url: string }>;
  createSession(): Promise<{ id: string }>;
  navigate(sessionId: string, url: string): Promise<{ url: string; title: string }>;
  click(sessionId: string, selector: string): Promise<void>;
  type(sessionId: string, selector: string, text: string): Promise<void>;
  readCurrent(sessionId: string): Promise<{ title: string; content: string; url: string }>;
  releaseSession(sessionId: string): Promise<void>;
  discoverLinks(url: string, limit?: number): Promise<string[]>;
  // General web search (no URL). Optional: when absent, the web_search tool reports it's unavailable.
  webSearch?(query: string, limit?: number): Promise<Array<{ title: string; url: string; snippet: string }>>;
  fetchJson(url: string): Promise<{ status: number; contentType: string; text: string }>;
  // Optional: JSON-LD + meta tags a text scrape misses (SPAs/product pages). When
  // absent, extract just uses the text pass.
  extractStructured?(url: string): Promise<string>;
  // Optional: capture a URL as image bytes (DEV-0027). When absent, the screenshot tool
  // reports it can't take pictures rather than failing hard.
  screenshot?(url: string): Promise<Uint8Array>;
  // Optional: render a URL to PDF bytes (DEV-0032). Absent -> pdf tool reports unavailable.
  pdf?(url: string): Promise<Uint8Array>;
  // Optional: render a QR code for a payload to PNG bytes (qr-code-tool). Absent -> make_qr reports
  // unavailable. Returns null when the payload is empty/too long or the render fails.
  makeQr?(payload: string): Promise<Uint8Array | null>;
  // Optional: fetch a YouTube video's caption transcript as plain text (video-transcript-summary).
  // Absent -> the transcript tool reports it's unavailable. Returns null when the video has no
  // captions / isn't a YouTube URL.
  videoTranscript?(url: string): Promise<{ videoId: string; text: string } | null>;
  // Optional: convert an amount between currencies at the live rate (fx-conversion-tool). Absent ->
  // the convert_currency tool reports it's unavailable. Returns null on a bad code / fetch failure.
  convertCurrency?(amount: number, from: string, to: string): Promise<import("./lib/fx.js").Conversion | null>;
  // Optional: latest stock/equity quote for a ticker (stock-quote-tool). Absent -> the get_quote tool
  // reports it's unavailable. Returns null on a bad symbol / fetch failure.
  getQuote?(symbol: string): Promise<import("./lib/quote.js").Quote | null>;
  // Optional: current crypto price for a coin ticker/name (crypto-quote-tool). Absent -> the get_crypto
  // tool reports it's unavailable. Returns null on an unknown coin / fetch failure.
  getCrypto?(coin: string): Promise<import("./lib/crypto.js").CryptoQuote | null>;
  // Optional: define a word (dictionary-tool). Absent -> the define tool reports it's unavailable.
  // Returns null on an unknown word / fetch failure.
  defineWord?(word: string): Promise<import("./lib/dictionary.js").WordEntry | null>;
  // Optional: a quick Wikipedia fact (wikipedia-fast-fact). Absent -> the get_fact tool reports it's
  // unavailable. Returns {fact:null} on a miss, or {fact:null,disambiguation:true} for an ambiguous term.
  getFact?(query: string): Promise<{ fact: import("./lib/wikifact.js").WikiFact | null; disambiguation?: boolean }>;
  // Optional: a food's per-100g calories + macros (nutrition-lookup). Absent -> the get_nutrition tool
  // reports it's unavailable. Returns null on no match / fetch failure (caller says "not sure").
  getNutrition?(food: string): Promise<import("./lib/nutrition.js").Nutrition | null>;
  // Optional: today's sports scores for a league/team (sports-scores-tool). Absent -> the get_scores
  // tool reports it's unavailable. Returns null on an unknown league / fetch failure.
  getScores?(query: string): Promise<{ leagueName: string; games: import("./lib/scores.js").GameScore[]; teamNotPlaying?: boolean } | null>;
  // Optional: the NEXT scheduled game for a league/team (sports-next-game). `nowMs` anchors the forward
  // date range. Absent -> the get_scores tool answers today-only. Returns null on unknown league / fetch
  // failure; { game: null } when nothing is scheduled in the horizon.
  getNextGame?(query: string, nowMs: number): Promise<{ leagueName: string; game: import("./lib/scores.js").GameScore | null } | null>;
  // Optional: today's top news headlines, or about a topic (get-news-tool). Absent -> the get_news tool
  // reports it's unavailable. Returns null on a fetch failure / empty parse.
  getNews?(topic?: string): Promise<{ topic?: string; headlines: string[] } | null>;
  // Optional: a joke / fun fact / trivia (get-fun-tool). Absent -> the get_fun tool reports it's
  // unavailable. Returns null on a fetch failure / empty parse.
  getFun?(request: string): Promise<{ kind: "joke" | "fact" | "trivia"; text: string } | null>;
  // Optional: cooking meal ideas / a recipe (meal-ideas-tool). Absent -> the meal_ideas tool reports
  // it's unavailable. Returns ideas-by-ingredient, a full recipe, or null on a miss.
  getMeals?(request: string): Promise<{ ideas: import("./lib/meals.js").MealIdea[]; ingredient?: string } | { meal: import("./lib/meals.js").FullMeal } | null>;
  // Optional: current weather for a place or coords (geo-tool-cluster). Absent -> the get_weather tool
  // reports it's unavailable. Returns null on a bad place / fetch failure.
  getWeather?(opts: { place?: string; lat?: number; lng?: number; near?: { lat: number; lng: number } }): Promise<import("./lib/weather.js").WeatherResult | null>;
  // Optional: sunrise/sunset/daylight for a place+day (sunrise-sunset-tool). Absent -> the get_suntimes
  // tool reports it's unavailable. Returns null on no place/coords, unknown place, or fetch failure.
  getSunTimes?(opts: { text: string; lat?: number; lng?: number; near?: { lat: number; lng: number } }): Promise<import("./lib/suntimes.js").SunTimes | null>;
  // Optional: air quality + UV for a place (air-quality-uv). Absent -> the get_air_quality tool reports
  // it's unavailable. Returns null on no place/coords, unknown place, or fetch failure.
  getAirQuality?(opts: { text?: string; place?: string; lat?: number; lng?: number; near?: { lat: number; lng: number } }): Promise<import("./lib/airquality.js").AirQuality | null>;
  // Optional: find nearby places (near-me-poi). Absent -> the find_nearby tool reports it's
  // unavailable. Returns [] on a bad area / fetch failure.
  findNearby?(opts: { what: string; lat?: number; lng?: number; near?: string; bias?: { lat: number; lng: number }; units?: "metric" | "imperial" }): Promise<import("./lib/places.js").NearbyOutcome>;
  // Optional: distance + travel time between two places (directions-eta). Absent -> the directions tool
  // reports it's unavailable. Returns null on a bad place / no route / fetch failure.
  getDirections?(opts: { to: string; from?: string; fromLat?: number; fromLng?: number; bias?: { lat: number; lng: number }; mode?: "driving" | "walking" | "cycling"; units?: "metric" | "imperial" }): Promise<import("./lib/directions.js").Route | null>;
  // Optional: flight route + live position by flight number (flight-status). Absent -> the get_flight
  // tool reports it's unavailable. Returns null on an unknown flight / both fetches failing.
  getFlight?(ref: import("./lib/flight.js").FlightRef): Promise<{ ref: import("./lib/flight.js").FlightRef; route: import("./lib/flight.js").FlightRoute | null; live: import("./lib/flight.js").LivePosition } | null>;
}

const FETCH_JSON_MAX_BYTES = 200_000;
// A watch page is ~1MB of HTML; the caption track is far smaller. Cap generously so the
// ytInitialPlayerResponse captionTracks blob (usually within the first few hundred KB) is captured.
const TRANSCRIPT_MAX_BYTES = 2_000_000;

/** Cap text handed to the model, but APPEND A VISIBLE MARKER when we cut — otherwise the agent
 * summarizes the top slice and states it as the whole truth, so a price/score/answer further down is
 * silently missed. The marker tells the model the data is partial so it can hedge, or re-fetch a
 * narrower target, instead of confidently answering from a fragment. Exported for tests. */
export function truncateForModel(text: string, max = 6000): string {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const dropped = s.length - max;
  return `${s.slice(0, max)}\n\n[…truncated ${dropped} more characters — this is only the first ${max}. If the answer isn't above, say the page was long and you saw only the top, or fetch a more specific URL/section.]`;
}

/** Cap PAGE CONTENT for the model, but keep a HEAD **and a TAIL** and drop the middle — the head-only
 * truncateForModel silently loses the END of a page, which is exactly where a listing's total, an
 * article's conclusion, a scoreboard's final, or a product's stock/price status live (long-page-
 * truncation-answered-as-fact). Splitting the budget top+bottom means those end-of-page facts survive,
 * and a LOUD marker at the cut tells the model the MIDDLE is gone so it can't pass off a partial read as
 * complete. Head-only tools (JSON/transcript/extract, where structure is front-loaded) keep
 * truncateForModel — splitting them would corrupt parsing. Exported for tests. */
export function truncateWindow(text: string, max = 6000): string {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  // Bias toward the head (context/lede) but keep a real tail (~35%) for end-of-page facts.
  const tailLen = Math.floor(max * 0.35);
  const headLen = max - tailLen;
  const dropped = s.length - max;
  const head = s.slice(0, headLen);
  const tail = s.slice(s.length - tailLen);
  return `${head}\n\n[⚠️ …${dropped} characters from the MIDDLE of this page were cut — you are seeing the TOP and the BOTTOM only, not the middle. Do NOT state this as the complete page. If the specific answer (a total, price, score, date, or status) isn't in either section shown, tell the user the page was long and you saw only its start and end, or fetch a more specific URL/section.…]\n\n${tail}`;
}

// Format a scrape/read page result for the model, OR — when the page came back nearly empty (a login
// wall, a JS-only shell that didn't render, or a block) — return an explicit marker so the agent
// retries (screenshot / different source / search) or says so honestly instead of answering from
// nothing (empty-read-escalation). Threshold on non-whitespace chars. Exported for tests.
export function formatPageForModel(title: string, url: string, content: string): string {
  const nonWs = String(content ?? "").replace(/\s+/g, "").length;
  if (nonWs < 200) {
    return `[The page at ${url} came back nearly empty (${nonWs} chars) — it likely needs a login, is JavaScript-only, or blocked me. Don't answer from this; try a screenshot, a different source, or web_search, and tell the user if you can't read it.]`;
  }
  // Paywall / metered-content wall (paywall-detection): the page rendered SOME text (so it's not the
  // empty-shell case) but it's a subscribe/register stub, not the article. Summarizing that stub would
  // pass off "subscribe to continue" as the content — mark it so the agent says it's paywalled + offers
  // a free source instead. Only when the article body is short (a real long article that merely mentions
  // "subscribe" in a footer is fine).
  if (nonWs < 1500 && looksPaywalled(content)) {
    return `[The page at ${url} looks paywalled / subscriber-only — I can see a subscribe/register prompt but not the full article. Don't summarize this stub as the article; tell the user it's behind a paywall and offer to find a free source or the gist from elsewhere (web_search the headline).]`;
  }
  // Head+tail window (not head-only): a long article/listing/scoreboard's key fact often sits at the
  // END (total, conclusion, final score, stock status), which head-only truncation dropped silently
  // (long-page-truncation-answered-as-fact).
  return `TITLE: ${title || url}\n\n${truncateWindow(content)}`;
}

// Paywall / metered-access language. Matches the common subscribe-wall stubs (NYT/WSJ/Economist/
// Medium/Bloomberg/FT etc.). Exported for tests.
const PAYWALL_RE = /\b(subscribe to (?:continue|read)|subscribers? only|create (?:a\s+)?(?:free\s+)?account to (?:continue|read)|already a subscriber|to continue reading|this (?:article|content|story) is (?:for subscribers|reserved)|register to (?:continue|read)|sign in to (?:continue|read)|become a member to|unlock this (?:article|story)|start your (?:free )?(?:trial|subscription)|metered|paywall)\b/i;
export function looksPaywalled(content: string): boolean {
  return PAYWALL_RE.test(String(content ?? ""));
}

// Default fetchJson: a guarded GET via safeFetch so each redirect hop is SSRF-re-validated (the caller
// checks the initial URL; a 3xx to an internal host would otherwise slip past). Caps size, reads the
// content-type, never forwards credentials/cookies.
async function defaultFetchJson(url: string): Promise<{ status: number; contentType: string; text: string }> {
  const res = await safeFetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf.slice(0, FETCH_JSON_MAX_BYTES));
  return { status: res.status, contentType, text };
}

// Plain guarded GET returning the body text (for the transcript fetch — YouTube watch page + caption
// track, + the geo APIs). Uses safeFetch so every redirect hop is SSRF-re-validated (geo-ssrf-redirect),
// matching scrape/fetch_json's discipline instead of a raw redirect:"follow". Size-capped, no creds.
export async function defaultFetchText(url: string): Promise<string> {
  const res = await safeFetch(url, {
    method: "GET",
    headers: { accept: "text/html,application/xml,application/json,*/*", "accept-language": "en", "user-agent": "relay-bot" },
    signal: AbortSignal.timeout(10000),
  });
  const buf = await res.arrayBuffer();
  return new TextDecoder().decode(buf.slice(0, TRANSCRIPT_MAX_BYTES));
}

// Guarded GET returning raw bytes (for an image render — the chart-it quickchart.io PNG). Same SSRF
// discipline as defaultFetchText; size-capped so a hostile URL can't stream unbounded data.
export async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const res = await safeFetch(url, {
    method: "GET",
    headers: { accept: "image/png,image/*,*/*", "user-agent": "relay-bot" },
    signal: AbortSignal.timeout(15000),
  });
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf.slice(0, FETCH_JSON_MAX_BYTES));
}

// GET when no body, POST (form-encoded) when a body is given — Overpass wants the QL query POSTed.
// safeFetch re-validates each redirect hop (geo-ssrf-redirect). Size-capped, no credentials.
async function defaultFetchTextPost(url: string, body?: string): Promise<string> {
  const res = await safeFetch(url, {
    method: body ? "POST" : "GET",
    headers: body
      ? { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "relay-bot" }
      : { accept: "application/json", "user-agent": "relay-bot" }, // Nominatim requires a UA
    body: body ? `data=${encodeURIComponent(body)}` : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const buf = await res.arrayBuffer();
  return new TextDecoder().decode(buf.slice(0, FETCH_JSON_MAX_BYTES));
}

const defaultBackend: BrowserBackend = {
  scrape: (url) => anvil.scrape(url, { format: "text" }),
  videoTranscript: (url) => fetchYouTubeTranscript(url, defaultFetchText),
  convertCurrency: (amount, from, to) => fxConvert(amount, from, to, defaultFetchText),
  getQuote: (symbol) => quoteFetch(symbol, defaultFetchText),
  getCrypto: (coin) => cryptoFetch(coin, defaultFetchText),
  defineWord: (word) => dictFetch(word, defaultFetchText),
  getFact: (query) => factFetch(query, defaultFetchText),
  getNutrition: (food) => nutritionFetch(food, defaultFetchText),
  getScores: (query) => scoresFetch(query, defaultFetchText),
  getNextGame: (query, nowMs) => nextGameFetch(query, nowMs, defaultFetchText),
  getNews: (topic) => newsFetch(topic, defaultFetchText),
  getFun: (request) => funFetch(request, defaultFetchText),
  getMeals: (request) => { const req = parseMealRequest(request); return req ? getMeals(req, defaultFetchText) : Promise.resolve(null); },
  getWeather: (opts) => fetchWeather(opts, defaultFetchText),
  getSunTimes: (opts) => sunFetch(opts, defaultFetchText),
  getAirQuality: (opts) => airFetch(opts, defaultFetchText),
  makeQr: (payload) => renderQr(payload, defaultFetchBytes),
  findNearby: (opts) => fetchNearby(opts, defaultFetchTextPost),
  getDirections: (opts) => fetchDirections(opts, defaultFetchText),
  getFlight: (ref) => fetchFlight(ref, defaultFetchText),
  createSession: () => anvil.createSession().then((s) => ({ id: s.id })),
  navigate: (id, url) => anvil.navigate(id, url),
  click: (id, sel) => anvil.click(id, sel),
  type: (id, sel, text) => anvil.type(id, sel, text),
  readCurrent: (id) => anvil.readCurrent(id),
  releaseSession: (id) => anvil.releaseSession(id),
  discoverLinks: (url, limit) => anvil.discoverLinks(url, limit),
  webSearch: (query, limit) => anvil.webSearch(query, limit),
  fetchJson: (url) => defaultFetchJson(url),
  extractStructured: (url) => anvil.extractStructured(url),
  screenshot: (url) => anvil.screenshot(url),
  pdf: (url) => anvil.pdf(url),
};

export interface AgentDeps {
  llm: LLMClient;
  backend?: BrowserBackend;
  // Back-compat: tests may pass just scrapeFn.
  scrapeFn?: (url: string) => Promise<{ title: string; content: string; url: string }>;
  // Per-user context (product-loop): a short profile line — home location, units — injected as a
  // system message so "weather" / "sushi near me" resolve without asking the city every time.
  // Optional + trimmed; absent = no change.
  context?: string;
  // Current wall-clock for the agent (inject-current-datetime): so "news today", "open right now",
  // "days until X", "latest"/"this week" reason from the real date, not the model's training cutoff.
  // nowMs = epoch (default Date.now()); tzOffsetMin = the chat's minutes-east-of-UTC (default 0=UTC).
  // Optional; absent -> no datetime line. Both together let the agent render + reason in the user's zone.
  nowMs?: number;
  tzOffsetMin?: number;
  // Weather (geo-tool-cluster): the user's saved coords + unit preference, so get_weather with no place
  // uses their location and renders in their units. Optional; absent -> place is required + F default.
  weatherCoords?: { lat: number; lng: number };
  weatherUnits?: "metric" | "imperial";
  // Recall past answers (recall-answer-log-tool): search THIS chat's answer-log so the agent can pull up
  // "that restaurant you found" / "the flight price last week" mid-reasoning instead of re-fetching or
  // shrugging. Bound to the chatId by the caller. Optional; absent -> the recall tool reports it's
  // unavailable. Returns most-relevant past {task, reply, at(epoch ms)} entries.
  recall?: (query: string) => Array<{ task: string; reply: string; at: number }>;
  // Contacts book (contacts-book-compose): resolve a saved contact NAME ("mom", "my boss") to its
  // email/phone so compose can draft to the right recipient instead of dead-ending. Bound to the chatId
  // by the caller. Optional; absent -> compose uses whatever `to` the model passed (prior behavior).
  resolveContact?: (name: string) => { name: string; email?: string; phone?: string } | null;
  // Read-it-later (read-it-later-capture): let the agent file a page it just found into the user's saved
  // list, so "find X and save it" works in ONE turn instead of the user re-issuing a save command. Bound
  // to the chatId by the caller; returns the stored title + whether it persisted. Optional; absent -> the
  // save_page tool reports it's unavailable.
  savePage?: (url: string, title?: string, summary?: string) => { title: string; saved: boolean; dup?: boolean } | null;
  // Background errands (async-background-errands): a raised per-run step budget for a long,
  // dispatch-and-ping task ("find the 5 cheapest flights and get back to me") that a normal ~8-step
  // synchronous run would truncate. Optional; absent/<=0 -> the RELAY_MAX_STEPS default. Clamped to a
  // ceiling in runAgent so a runaway task can't loop forever.
  maxSteps?: number;
}

// Hard ceiling on a single run's steps regardless of override — a runaway agent can't loop forever.
const MAX_STEPS_CEILING = 30;

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A system line telling the model the current wall-clock in the user's zone (inject-current-datetime).
 * Pure; exported for tests. offsetMin = minutes east of UTC. */
export function buildNowLine(nowMs: number, offsetMin: number): string {
  const d = new Date(nowMs + offsetMin * 60_000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const sign = offsetMin < 0 ? "-" : "+";
  const oh = Math.floor(Math.abs(offsetMin) / 60);
  const om = Math.abs(offsetMin) % 60;
  const tz = `UTC${sign}${oh}${om ? ":" + String(om).padStart(2, "0") : ""}`;
  return `Right now it is ${DOW[d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hh}:${mm} (${tz}, the user's timezone). Use this for anything time-relative ("today", "now", "latest", "this week", "days until", "open now"); don't rely on your training date.`;
}

export async function runAgent(
  userText: string,
  deps: AgentDeps,
  history: LLMMessage[] = []
): Promise<{ reply: string; steps: number; tools: string[]; photo?: Uint8Array; doc?: Uint8Array; docName?: string; degraded?: boolean; pendingAction?: { selector: string; label: string; url: string } }> {
  const backend: BrowserBackend = deps.backend ?? {
    ...defaultBackend,
    ...(deps.scrapeFn ? { scrape: deps.scrapeFn } : {}),
  };
  const toolsUsed: string[] = []; // tool names invoked this turn (for observability)
  let photo: Uint8Array | undefined; // last screenshot captured this turn, sent by the handler
  let doc: Uint8Array | undefined; // last PDF rendered this turn, sent by the handler
  let docName: string | undefined; // filename for the doc (csv-export vs the default page.pdf)

  const ctx = deps.context?.trim();
  // Current date/time in the user's zone, so "today"/"now"/"latest"/"days until X" reason from the
  // real date rather than the model's training cutoff (inject-current-datetime). Rendered from nowMs
  // when provided; a plain UTC-shifted ISO-ish stamp + a human day/date so the model can filter recency.
  const nowLine = deps.nowMs !== undefined ? buildNowLine(deps.nowMs, deps.tzOffsetMin ?? 0) : null;
  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(nowLine ? [{ role: "system" as const, content: nowLine }] : []),
    ...(ctx ? [{ role: "system" as const, content: `About this user: ${ctx}. Use this for location/units when they don't specify (e.g. "weather", "near me").` }] : []),
    ...history,
    { role: "user", content: userText },
  ];

  let sessionId: string | null = null; // persistent browse session, if opened
  let lastUrl = ""; // the most recently navigated page — the target a confirm-to-act click acts on
  let pendingAction: { selector: string; label: string; url: string } | null = null; // confirm-to-act stash
  const push = (name: string, content: string) => messages.push({ role: "tool", name, content });

  try {
    let finalReply: string | null = null;
    // Per-run step budget: a background errand can raise it (async-background-errands), clamped to a
    // ceiling so it can't loop forever; a normal run uses the RELAY_MAX_STEPS default.
    const stepLimit = deps.maxSteps && deps.maxSteps > 0 ? Math.min(deps.maxSteps, MAX_STEPS_CEILING) : MAX_STEPS;
    let usedSteps = stepLimit;
    let degraded = false; // true when the reply is a soft-failure fallback, not a real answer (DEV-0176)

    for (let step = 1; step <= stepLimit; step++) {
      const res = await deps.llm.complete(messages, TOOLS);

      if (!res.toolCall) {
        const answered = res.text?.trim();
        finalReply = answered || "Sorry, I couldn't come up with an answer.";
        degraded = !answered; // empty model reply → soft failure, not a real answer
        usedSteps = step;
        break;
      }

      const call: ToolCall = res.toolCall;
      messages.push({ role: "assistant", content: res.text ?? "", toolCall: call });
      if (call.name !== "reply") toolsUsed.push(call.name);

      if (call.name === "reply") {
        finalReply = String(call.args.text ?? "").trim() || "Done.";
        usedSteps = step;
        break;
      }

      if (call.name === "scrape") {
        const url = String(call.args.url ?? "");
        const safe = isUrlSafe(url);
        if (!safe.safe) { push("scrape", `ERROR: refused (${safe.reason}).`); continue; }
        try {
          const r = await backend.scrape(url);
          push("scrape", formatPageForModel(r.title, r.url, r.content));
        } catch (e) {
          push("scrape", `ERROR fetching ${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "transcript") {
        const url = String(call.args.url ?? "");
        const safe = isUrlSafe(url);
        if (!safe.safe) { push("transcript", `ERROR: refused (${safe.reason}).`); continue; }
        if (!backend.videoTranscript) { push("transcript", "ERROR: video transcripts aren't available."); continue; }
        try {
          const r = await backend.videoTranscript(url);
          if (!r) { push("transcript", `No transcript available for ${url} (captions may be disabled, or it isn't a YouTube video). Tell the user you can't read this video's transcript.`); continue; }
          push("transcript", `TRANSCRIPT of ${url}:\n${truncateForModel(r.text)}\n\nSummarize/answer from this; it's what was said in the video.`);
        } catch (e) {
          push("transcript", `ERROR fetching transcript for ${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "make_qr") {
        if (!backend.makeQr) { push("make_qr", "ERROR: QR generation isn't available."); continue; }
        const payload = String(call.args.payload ?? "").trim();
        if (!payload) { push("make_qr", "ERROR: no payload to encode — ask the user what the QR should contain (a link, text, or wifi string)."); continue; }
        try {
          const png = await backend.makeQr(payload);
          if (!png) { push("make_qr", `Couldn't generate a QR for that (empty, too long, or the renderer failed). Payloads must be under ~900 chars.`); continue; }
          photo = png;
          push("make_qr", `Generated a QR code for "${payload.slice(0, 60)}" (${png.length} bytes). It will be sent to the user; now call reply with a short caption.`);
        } catch (e) {
          push("make_qr", `ERROR generating QR: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "screenshot") {
        const url = String(call.args.url ?? "");
        const safe = isUrlSafe(url);
        if (!safe.safe) { push("screenshot", `ERROR: refused (${safe.reason}).`); continue; }
        if (!backend.screenshot) { push("screenshot", "ERROR: screenshots aren't available."); continue; }
        try {
          photo = await backend.screenshot(url);
          push("screenshot", `Captured a screenshot of ${url} (${photo.length} bytes). It will be sent to the user; now call reply with a short caption.`);
        } catch (e) {
          push("screenshot", `ERROR capturing ${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "pdf") {
        const url = String(call.args.url ?? "");
        const safe = isUrlSafe(url);
        if (!safe.safe) { push("pdf", `ERROR: refused (${safe.reason}).`); continue; }
        if (!backend.pdf) { push("pdf", "ERROR: PDF rendering isn't available."); continue; }
        try {
          doc = await backend.pdf(url);
          push("pdf", `Rendered ${url} to a PDF (${doc.length} bytes). It will be sent to the user; now call reply with a short caption.`);
        } catch (e) {
          push("pdf", `ERROR rendering ${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "browse") {
        const url = String(call.args.url ?? "");
        const safe = isUrlSafe(url);
        if (!safe.safe) { push("browse", `ERROR: refused (${safe.reason}).`); continue; }
        try {
          if (!sessionId) sessionId = (await backend.createSession()).id;
          const r = await backend.navigate(sessionId, url);
          lastUrl = r.url || url; // track for a confirm-to-act preview ("click Buy on <host>")
          push("browse", `Opened. TITLE: ${r.title || r.url}. Use read to see its text, or click/type to interact.`);
        } catch (e) {
          push("browse", `ERROR opening ${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "click" || call.name === "type") {
        if (!sessionId) { push(call.name, "ERROR: no page open. Call browse first."); continue; }
        const selector = String(call.args.selector ?? "");
        // Guard the click TARGET (label + selector) only — NOT the typed text. Typing into a field
        // isn't the committing act (the submit/click is), and matching the payload made benign tasks
        // false-refuse: "search Goodreads for this book", a "cancel culture" query, "order status".
        // The committing verb still gets caught on the click/submit whose label or selector says so.
        const target = String(call.args.label ?? "") + " " + selector;
        if (isDangerousAction(target)) {
          // Confirm-to-act (opt-in, default OFF): instead of the flat refusal, stash the exact click +
          // preview it, and end this run asking the user for a one-shot YES. The handler resumes on YES to
          // run exactly this click. Only a click on a live page qualifies (a session + url must exist).
          if (confirmToActEnabled() && call.name === "click" && sessionId && lastUrl) {
            const label = String(call.args.label ?? "").trim();
            pendingAction = { selector, label, url: lastUrl };
            finalReply = formatConfirmPrompt({ label, url: lastUrl }, CONFIRM_TTL_MS);
            usedSteps = step;
            break;
          }
          push(call.name, `REFUSED: that looks like a destructive/committing action ("${target.trim()}"). I won't do that autonomously — tell the user.`);
          continue;
        }
        try {
          if (call.name === "click") await backend.click(sessionId, selector);
          else await backend.type(sessionId, selector, String(call.args.text ?? ""));
          push(call.name, `Done: ${call.name} ${selector}. Call read to see the updated page.`);
        } catch (e) {
          push(call.name, `ERROR: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "web_search") {
        const query = String(call.args.query ?? "").trim();
        if (!query) { push("web_search", "ERROR: no query given."); continue; }
        if (!backend.webSearch) { push("web_search", "ERROR: web search isn't available."); continue; }
        try {
          const limit = Math.max(1, Math.min(20, Number(call.args.limit) || 6));
          const results = await backend.webSearch(query, limit);
          if (!results.length) { push("web_search", `No results for "${query}". Try broader or different keywords (drop quotes/qualifiers, use the plain topic), or tell the user you couldn't find anything on it — don't invent an answer.`); continue; }
          const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
          push("web_search", `RESULTS for "${query}":\n${lines.join("\n")}\nScrape/extract the most relevant url for details.`);
        } catch (e) {
          push("web_search", `ERROR searching: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "fetch_json") {
        const url = String(call.args.url ?? "");
        const safe = isUrlSafe(url);
        if (!safe.safe) { push("fetch_json", `ERROR: refused (${safe.reason}).`); continue; }
        try {
          const r = await backend.fetchJson(url);
          if (!/json/i.test(r.contentType)) {
            push("fetch_json", `Not a JSON response (content-type: ${r.contentType || "unknown"}). Use scrape for HTML pages.`);
            continue;
          }
          // Validate it parses, then hand back a trimmed body for the model to read.
          try { JSON.parse(r.text); } catch { push("fetch_json", `Response was not valid JSON (status ${r.status}).`); continue; }
          push("fetch_json", `JSON from ${url} (status ${r.status}):\n${truncateForModel(r.text)}`);
        } catch (e) {
          push("fetch_json", `ERROR fetching ${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "convert_currency") {
        if (!backend.convertCurrency) { push("convert_currency", "ERROR: currency conversion isn't available."); continue; }
        const amount = Number(call.args.amount);
        const from = String(call.args.from ?? "");
        const to = String(call.args.to ?? "");
        // A non-finite amount (model passed a word like "twenty", or nothing) must NOT silently become 1 —
        // that returns a per-unit rate as if the user asked for it, a wrong answer with no signal. Ask.
        if (call.args.amount != null && !Number.isFinite(amount)) {
          push("convert_currency", `ERROR: "${String(call.args.amount)}" isn't a numeric amount. Re-call with amount as a number (e.g. 20), or ask the user for the figure.`);
          continue;
        }
        try {
          const c = await backend.convertCurrency(Number.isFinite(amount) ? amount : 1, from, to);
          if (!c) { push("convert_currency", `Couldn't convert ${from} -> ${to} (check the currency codes, or try web_search for an unusual pair).`); continue; }
          push("convert_currency", `${formatConversion(c)}. Report this to the user, including the "as of" date if shown (the rate refreshes about daily, not to the second).`);
        } catch (e) {
          push("convert_currency", `ERROR converting: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "get_quote") {
        if (!backend.getQuote) { push("get_quote", "ERROR: stock quotes aren't available."); continue; }
        const symbol = String(call.args.symbol ?? "");
        try {
          const q = await backend.getQuote(symbol);
          if (!q) { push("get_quote", `Couldn't get a quote for "${symbol}" (unknown ticker or fetch failed). Check the symbol, or try web_search for an index/crypto/unusual listing.`); continue; }
          push("get_quote", `${formatQuote(q)}. Report this to the user, including the "as of" time if shown (it's the last close/trade, not a to-the-second live tick).`);
        } catch (e) {
          push("get_quote", `ERROR getting quote: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "random") {
        const req = parseRandomRequest(String(call.args.request ?? ""));
        if (!req) { push("random", "Couldn't tell what to randomize — ask the user to clarify (coin / dice / a number range / a list to pick from / a uuid)."); continue; }
        // App-side RNG (Math.random) — genuinely random, no network. The LLM must NOT invent the value.
        push("random", `${runRandom(req)}. Report this EXACT result to the user; do not change or re-roll it.`);
        continue;
      }

      if (call.name === "generate_password") {
        const req = parsePasswordRequest(String(call.args.request ?? "")) ?? { kind: "password" as const, length: 20, symbols: true, digits: true };
        // crypto RNG (not Math.random) — this is a credential; a predictable "random" password is unsafe.
        const secret = generateSecret(req, (n) => cryptoRandomInt(n));
        // Return the FORMATTED reply verbatim: the model must relay this exact secret, not invent its own.
        push("generate_password", `${formatSecret(req, secret)}\n\n[Send this EXACT text to the user — do NOT alter, regenerate, or paraphrase the secret.]`);
        continue;
      }

      if (call.name === "encode_decode") {
        const req = parseEncodingRequest(String(call.args.request ?? ""));
        if (!req) { push("encode_decode", "Couldn't tell what to encode/decode — ask for a codec + the text (e.g. \"base64 encode hello\", \"decode this base64: ...\", \"url encode ...\", \"decode this jwt ...\")."); continue; }
        try {
          push("encode_decode", `${formatEncoding(req, runEncoding(req))}\n\n[Relay the EXACT result to the user.]`);
        } catch (e) {
          push("encode_decode", `ERROR: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "get_crypto") {
        if (!backend.getCrypto) { push("get_crypto", "ERROR: crypto prices aren't available."); continue; }
        const coin = String(call.args.coin ?? "").trim();
        try {
          const q = await backend.getCrypto(coin);
          if (!q) { push("get_crypto", `Couldn't get a price for "${coin}" (unknown coin or fetch failed). Check the ticker/name, or try web_search for an obscure token.`); continue; }
          push("get_crypto", `${formatCrypto(q)}. Report this to the user (the price + 24h change; note it's live/spot).`);
        } catch (e) {
          push("get_crypto", `ERROR getting crypto price: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "define") {
        if (!backend.defineWord) { push("define", "ERROR: word definitions aren't available."); continue; }
        const word = String(call.args.word ?? "").trim();
        try {
          const e = await backend.defineWord(word);
          if (!e) { push("define", `No dictionary entry for "${word}" (unknown word, misspelling, or non-English). Check the spelling, or answer from your own knowledge if you're confident, or try web_search.`); continue; }
          push("define", `${formatDefinition(e)}\n\nReport this definition to the user (include the pronunciation + a synonym or two if present).`);
        } catch (e) {
          push("define", `ERROR looking up definition: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "where_to_watch") {
        // Pure tool (no backend): a title arg -> a JustWatch availability link. Accept the raw arg, or
        // parse it out of a sentence the model passed verbatim. Honest link-bridge (no keyless streaming
        // API exists), so it never claims a specific service.
        const raw = String(call.args.title ?? "").trim();
        const title = raw && !/\b(watch|stream)\b/i.test(raw) ? raw : (parseWatchQuery(raw) ?? raw);
        if (!title) { push("where_to_watch", "No title given — ask the user which movie/show."); continue; }
        push("where_to_watch", `${formatWatchWhere(title)}\n\nGive the user this JustWatch link + the honest note; don't name a specific streaming service yourself.`);
        continue;
      }

      if (call.name === "get_nutrition") {
        if (!backend.getNutrition) { push("get_nutrition", "ERROR: nutrition lookup isn't available."); continue; }
        const food = String(call.args.food ?? "").trim();
        if (!food) { push("get_nutrition", "No food given — ask the user which food."); continue; }
        try {
          const n = await backend.getNutrition(food);
          if (!n) { push("get_nutrition", `No nutrition data for "${food}". Tell the user you're not sure — do NOT invent calorie/macro numbers; offer web_search.`); continue; }
          push("get_nutrition", `${formatNutrition(n)}\n\nReport this to the user. Note the matched food name (so a mismatch is visible) + that figures are per 100g; if they asked about a specific portion, scale it + say you did.`);
        } catch (e) {
          push("get_nutrition", `ERROR looking up nutrition: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "get_fact") {
        if (!backend.getFact) { push("get_fact", "ERROR: fact lookup isn't available."); continue; }
        const query = String(call.args.query ?? "").trim();
        if (!query) { push("get_fact", "No topic given — ask the user what they want to know."); continue; }
        try {
          const r = await backend.getFact(query);
          if (r.fact) { push("get_fact", `${formatFact(r.fact)}\n\nReport this to the user in a sentence or two + keep the source link. If it doesn't actually answer their question, say so + try web_search.`); continue; }
          if (r.disambiguation) { push("get_fact", `"${query}" is ambiguous on Wikipedia (multiple meanings). Ask the user which they mean, or web_search with more context.`); continue; }
          push("get_fact", `No Wikipedia summary for "${query}". Answer from your own knowledge if you're confident, or use web_search.`);
        } catch (e) {
          push("get_fact", `ERROR looking up fact: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "get_time") {
        const request = String(call.args.request ?? "").trim();
        // "how long until 5pm / midnight" — a duration-to-a-clock-time, computed in the user's tz. Checked
        // before worldclock (it's not a zone lookup). Rolls to tomorrow when the time already passed today.
        const until = parseTimeUntil(request);
        if (until) {
          push("get_time", `${runTimeUntil(until, deps.nowMs ?? Date.now(), deps.tzOffsetMin ?? 0)}\n\nReport this EXACT duration to the user.`);
          continue;
        }
        const parsed = parseWorldClock(request);
        const nowForTz = deps.nowMs ?? Date.now();
        const answer = parsed ? runWorldClock(parsed, nowForTz) : null;
        if (!answer) { push("get_time", `Couldn't resolve a timezone in "${request}" (unknown city/abbreviation). Report that you couldn't place that zone + ask which city/UTC offset, or try web_search for an unusual place.`); continue; }
        push("get_time", `${answer}\n\nReport this to the user (include the daylight-saving caveat only if it's relevant / they're near a DST change).`);
        continue;
      }

      if (call.name === "date_math") {
        const request = String(call.args.request ?? "").trim();
        // "today" in the user's LOCAL calendar (nowMs + their tz offset), so "days until Christmas"
        // and "what day is it" reckon from the user's date, not the server's UTC day.
        const local = new Date((deps.nowMs ?? Date.now()) + (deps.tzOffsetMin ?? 0) * 60_000);
        const today: Ymd = { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
        const answer = runDateCalc(request, today);
        if (!answer) { push("date_math", `Couldn't parse a date question from "${request}". If it's a date I can't compute (a moving holiday like Easter, or a fuzzy phrase), say so + try web_search; otherwise ask the user for an explicit date.`); continue; }
        push("date_math", `${answer} Report this exact result to the user.`);
        continue;
      }

      if (call.name === "translate") {
        const request = String(call.args.request ?? "").trim();
        const parsed = parseTranslateRequest(request);
        if (!parsed) { push("translate", `That doesn't look like a translate request. If the user pasted text to translate, translate it directly in your reply.`); continue; }
        try {
          const out = await translate(parsed, deps.llm, (url) => backend.scrape(url).then((r) => ({ content: r.content })).catch(() => null));
          if (!out) { push("translate", `Couldn't translate that${parsed.url ? ` page (${parsed.url})` : ""}. Ask the user to paste the text, or check the link.`); continue; }
          push("translate", `${out}\n\nReport this translation to the user verbatim (into ${parsed.target}).`);
        } catch (e) {
          push("translate", `ERROR translating: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "meal_ideas") {
        if (!backend.getMeals) { push("meal_ideas", "ERROR: meal ideas aren't available."); continue; }
        const request = String(call.args.request ?? "").trim();
        try {
          const r = await backend.getMeals(request);
          if (!r) { push("meal_ideas", `Couldn't find a meal for "${request}". Try a single main ingredient ("with chicken") or a dish name ("recipe for lasagna").`); continue; }
          const text = "meal" in r ? formatFullMeal(r.meal) : formatMealIdeas(r.ideas, r.ingredient);
          push("meal_ideas", `${text}\n\nReport this to the user.`);
        } catch (e) {
          push("meal_ideas", `ERROR getting meal ideas: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "convert_units") {
        const request = String(call.args.request ?? "").trim();
        const out = runConvert(request);
        if (!out) { push("convert_units", `Couldn't convert "${request}" (unknown units, or a cross-type conversion like kg->miles). For money use convert_currency; else check the units.`); continue; }
        push("convert_units", `${out}. Report this exact result to the user.`);
        continue;
      }

      if (call.name === "unit_price") {
        const request = String(call.args.request ?? "").trim();
        const out = runUnitPrice(request);
        if (!out) { push("unit_price", `Couldn't compare "${request}" — I need 2+ options each with a quantity, unit, and price (e.g. "500g for $4 or 1.2kg for $9"), and the units must be the same kind (can't compare weight to volume).`); continue; }
        push("unit_price", `${out}\n\nReport this to the user.`);
        continue;
      }

      if (call.name === "calculate") {
        const expr = String(call.args.expression ?? "").trim();
        try {
          const result = calc(expr);
          push("calculate", `${expr} = ${formatResult(result)}. Report this exact result to the user.`);
        } catch (e) {
          push("calculate", `Couldn't compute "${expr}": ${e instanceof Error ? e.message : String(e)}. Ask the user to restate it, or answer a trivial one yourself.`);
        }
        continue;
      }

      if (call.name === "get_news") {
        if (!backend.getNews) { push("get_news", "ERROR: news headlines aren't available."); continue; }
        const topic = String(call.args.topic ?? "").trim() || undefined;
        try {
          const r = await backend.getNews(topic);
          if (!r) { push("get_news", `Couldn't pull headlines${topic ? ` about "${topic}"` : ""} right now. Try web_search.`); continue; }
          push("get_news", `${formatNews(r.headlines, r.topic)}\n\nReport these to the user (today's headlines; offer to open one if they want more).`);
        } catch (e) {
          push("get_news", `ERROR getting news: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "get_fun") {
        if (!backend.getFun) { push("get_fun", "ERROR: jokes/facts aren't available."); continue; }
        const request = String(call.args.request ?? "").trim();
        try {
          const r = await backend.getFun(request);
          if (!r) { push("get_fun", `Couldn't fetch a ${/(fact)/i.test(request) ? "fact" : /(trivia|quiz)/i.test(request) ? "trivia question" : "joke"} right now. Try again in a moment.`); continue; }
          push("get_fun", `${r.text}\n\nReport this to the user verbatim.`);
        } catch (e) {
          push("get_fun", `ERROR getting a ${"joke/fact"}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "get_scores") {
        if (!backend.getScores) { push("get_scores", "ERROR: sports scores aren't available."); continue; }
        const request = String(call.args.request ?? "").trim();
        const nowForScores = deps.nowMs ?? Date.now();
        try {
          // "when do the Lakers play next" / "next Arsenal game" / "upcoming NFL" -> the NEXT scheduled
          // game, not today's slate (sports-next-game). Today's scoreboard only covers today, so a
          // forward date range is needed. Falls back to today's scores if the next-game tool is absent.
          if (wantsNextGame(request) && backend.getNextGame) {
            const n = await backend.getNextGame(request, nowForScores);
            if (!n) { push("get_scores", `I don't cover that league/team with my scores tool (I do NBA/NFL/MLB/NHL/NCAA + major soccer). Try web_search for "${request}", or name the league.`); continue; }
            push("get_scores", `${formatNextGame(n.leagueName, n.game)}\n\nReport this to the user (the upcoming game + its date/time).`);
            continue;
          }
          const r = await backend.getScores(request);
          if (!r) { push("get_scores", `I don't cover that league/team with my scores tool (I do NBA/NFL/MLB/NHL/NCAA + major soccer). Try web_search for "${request}", or name the league.`); continue; }
          if (r.teamNotPlaying) {
            // No game today — proactively look up their NEXT game so the user gets a useful answer
            // instead of a dead-end (sports-next-game), rather than only offering to check.
            if (backend.getNextGame) {
              const n = await backend.getNextGame(request, nowForScores);
              if (n && n.game) { push("get_scores", `No ${r.leagueName} game today for that team. ${formatNextGame(n.leagueName, n.game)}\n\nTell the user they're not playing today, then give their next game.`); continue; }
            }
            push("get_scores", `That team has no ${r.leagueName} game today. Tell the user they're not playing today (do NOT list other teams' games), and offer to check their next game or another team.`); continue;
          }
          push("get_scores", `${formatScores(r.leagueName, r.games)}\n\nReport this to the user (scores + status; note it's live/today).`);
        } catch (e) {
          push("get_scores", `ERROR getting scores: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "recall") {
        if (!deps.recall) { push("recall", "ERROR: I can't search past answers here."); continue; }
        const query = String(call.args.query ?? "").trim();
        const hits = deps.recall(query);
        if (!hits.length) { push("recall", `No past answer of mine matches "${query}". Tell the user you don't have a record of that + offer to look it up fresh.`); continue; }
        const now = deps.nowMs ?? Date.now();
        const body = hits.map((h) => {
          const age = relativeAge(now - h.at); // so a recalled price/story reads as past, not current
          return `• They asked "${h.task}"${age ? ` (${age})` : ""} — I said:\n${h.reply}`;
        }).join("\n\n");
        push("recall", `Past answers I gave this user:\n${body}\n\nUse these to answer; mention how long ago if it might be stale (a price/score/story), and offer to refresh it.`);
        continue;
      }

      if (call.name === "save_page") {
        if (!deps.savePage) { push("save_page", "ERROR: I can't save pages here."); continue; }
        const url = String(call.args.url ?? "").trim();
        if (!/^https?:\/\/\S+$/i.test(url)) { push("save_page", "ERROR: save_page needs a real http(s) URL. Don't save a non-URL."); continue; }
        const title = call.args.title ? String(call.args.title).trim() : undefined;
        const summary = call.args.summary ? String(call.args.summary).trim() : undefined;
        const r = deps.savePage(url, title, summary);
        if (!r) { push("save_page", "ERROR: couldn't save that page."); continue; }
        push("save_page", `${r.dup ? "Updated" : "Saved"} "${r.title}" ${r.dup ? "(already in the reading list — refreshed it)" : "to the user's reading list"}.${r.saved ? "" : " (Warning: it may not have persisted to disk — tell the user to try again if it doesn't stick.)"} Confirm to the user they can recall it with "what did I save about …" or "my reading list".`);
        continue;
      }

      if (call.name === "track_package") {
        const rawNum = String(call.args.number ?? "").trim();
        const named = String(call.args.carrier ?? "").trim().toLowerCase();
        const carrier = (["ups", "fedex", "usps", "dhl"].includes(named) ? named : detectCarrier(rawNum)) as import("./lib/tracking.js").Carrier | null;
        if (!rawNum) { push("track_package", "No tracking number given — ask the user for it."); continue; }
        if (!carrier) { push("track_package", `Couldn't tell which carrier "${rawNum}" is from. Ask the user which carrier (UPS/FedEx/USPS/DHL).`); continue; }
        try {
          // Drive the real browser (anvil) to the carrier's official page — a keyless GET 403s, but the
          // page renders the status; scrape returns its text for the model to read out the latest event.
          const url = trackingUrl(carrier, rawNum);
          const r = await backend.scrape(url);
          // Use formatPageForModel (not raw truncate) so a JS-only shell / cookie-wall — the COMMON case
          // on carrier pages — returns an honest "couldn't read it" marker instead of being summarized as
          // a confident-but-bogus status (tracking-page-shell-guard). It also handles truncation + paywall.
          const page = formatPageForModel(`${carrierName(carrier)} tracking ${rawNum}`, url, r.content || "");
          push("track_package", `${page}\n\nIf the text above is a real tracking page, summarize the LATEST status + expected delivery in one line (say so if the number shows no match); if it's the "nearly empty / needs a login / blocked" marker, tell the user you couldn't read the ${carrierName(carrier)} page and suggest re-checking the number or the carrier site directly.`);
        } catch (e) {
          push("track_package", `ERROR reading the ${carrierName(carrier)} tracking page: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "get_flight") {
        if (!backend.getFlight) { push("get_flight", "ERROR: flight lookup isn't available."); continue; }
        const raw = String(call.args.flight ?? "").trim();
        const ref = detectFlight(raw);
        if (!ref) { push("get_flight", `"${raw}" doesn't look like a flight number (e.g. AA100, UA83). Ask the user for the flight number.`); continue; }
        try {
          const r = await backend.getFlight(ref);
          if (!r) { push("get_flight", `Couldn't find flight ${ref.iata} in my keyless sources. Suggest they check the airline's site or a live tracker (flightaware.com/live/flight/${ref.iata}).`); continue; }
          push("get_flight", `${formatFlight(r.ref, r.route, r.live)}\n\nReport this to the user. Be honest about what's known (route + whether it's airborne now) vs not (scheduled gate/terminal + on-time/delayed need the tracker link — do NOT state a gate or a delay you weren't given).`);
        } catch (e) {
          push("get_flight", `ERROR looking up flight ${ref.iata}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "get_weather") {
        if (!backend.getWeather) { push("get_weather", "ERROR: weather isn't available."); continue; }
        const place = String(call.args.place ?? "").trim();
        // No place given but the user's coords are known -> use them (near-me weather). A named place
        // + known coords -> pass coords as `near` so an ambiguous city resolves to the user's region
        // (weather-ambiguous-city).
        const opts = place
          ? { place, ...(deps.weatherCoords ? { near: deps.weatherCoords } : {}) }
          : (deps.weatherCoords ? { lat: deps.weatherCoords.lat, lng: deps.weatherCoords.lng } : {});
        if (!place && !deps.weatherCoords) { push("get_weather", "No place given and no saved location — ask the user which city."); continue; }
        const when = String(call.args.when ?? "").trim();
        try {
          const w = await backend.getWeather(opts);
          if (!w) { push("get_weather", `Couldn't get weather for ${place || "your location"} (unknown place or fetch failed). Try a more specific city.`); continue; }
          // No explicit user pref -> infer °C/°F from the RESOLVED place's country (metric-imperial-infer)
          // instead of defaulting the whole world to °F. w.place carries the country tail from geocoding.
          const units = resolveUnits(deps.weatherUnits, w.place);
          // Resolution order for the user's phrasing (weather is one answer, most-specific wins):
          //  1) a TIME-OF-DAY question ("rain this afternoon / tonight / at 3pm") -> the hourly window,
          //     so the answer says WHEN, not a whole-day max (hourly-rain-weather);
          //  2) a FUTURE-DAY question ("tomorrow", "this weekend", "Saturday") -> those days (weather-
          //     multi-day); 3) else the current-weather line.
          // The location's local hour (for "later today") comes from nowMs + the chat's tz offset.
          const q = when || String(call.args.place ?? ""); // "when" carries the phrasing; fall back to place text
          const local = new Date((deps.nowMs ?? Date.now()) + (deps.tzOffsetMin ?? 0) * 60_000);
          const nowHour = local.getUTCHours();
          const hourly = formatWeatherHourly(w, q, nowHour, units);
          const forecast = hourly ?? (when ? formatWeatherWhen(w, when, units) : null);
          push("get_weather", `${forecast ?? formatWeather(w, units)} Report this to the user.`);
        } catch (e) {
          push("get_weather", `ERROR getting weather: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "get_suntimes") {
        if (!backend.getSunTimes) { push("get_suntimes", "ERROR: sunrise/sunset isn't available."); continue; }
        const request = String(call.args.request ?? "").trim();
        // Thread coords like get_weather. Use sunPlace (the SAME extractor getSunTimes uses) — NOT a
        // broad /\bin\s+/ — to decide "named place": otherwise "is it dark in the evening" / "in winter"
        // matched, dropped the saved coords, then sunPlace rejected the tail -> no place + no coords ->
        // a located user was wrongly told "which city?" (suntimes-located-user-refused). A real place
        // ("in Denver") passes coords as `near` to disambiguate; no real place uses coords directly.
        const hasPlace = sunPlace(request) !== null;
        const opts = deps.weatherCoords
          ? (hasPlace ? { text: request, near: deps.weatherCoords } : { text: request, lat: deps.weatherCoords.lat, lng: deps.weatherCoords.lng })
          : { text: request };
        try {
          const s = await backend.getSunTimes(opts);
          if (!s) { push("get_suntimes", `Couldn't get sun times${hasPlace ? "" : " (no place given + no saved location — ask the user which city)"}. Try naming a city.`); continue; }
          push("get_suntimes", `${formatSunTimes(s)} Report this to the user.`);
        } catch (e) {
          push("get_suntimes", `ERROR getting sun times: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "get_air_quality") {
        if (!backend.getAirQuality) { push("get_air_quality", "ERROR: air quality isn't available."); continue; }
        const request = String(call.args.request ?? "").trim();
        // Thread coords like get_suntimes: a real "in <place>" passes coords as `near` to disambiguate;
        // otherwise use the saved coords directly (so "is the air bad" from a located user works).
        const hasPlace = airPlace(request) !== null;
        const opts = deps.weatherCoords
          ? (hasPlace ? { text: request, near: deps.weatherCoords } : { text: request, lat: deps.weatherCoords.lat, lng: deps.weatherCoords.lng })
          : { text: request };
        try {
          const a = await backend.getAirQuality(opts);
          if (!a) { push("get_air_quality", `Couldn't get air quality${hasPlace ? "" : " (no place given + no saved location — ask the user which city)"}. Try naming a city.`); continue; }
          // Lead with what was asked: a UV/sunscreen ask -> UV; a pollen/allergy ask -> pollen; else AQI.
          const lead = isPollenRequest(request) ? "pollen" : isUvRequest(request) ? "uv" : "aqi";
          push("get_air_quality", `${formatAirQuality(a, lead)} Report this to the user.`);
        } catch (e) {
          push("get_air_quality", `ERROR getting air quality: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "find_nearby") {
        if (!backend.findNearby) { push("find_nearby", "ERROR: nearby search isn't available."); continue; }
        const what = String(call.args.what ?? "").trim();
        const near = String(call.args.near ?? "").trim();
        if (!what) { push("find_nearby", "ERROR: say what to find (e.g. \"coffee\")."); continue; }
        if (!near && !deps.weatherCoords) { push("find_nearby", "No area given and no saved location — ask the user where, or have them share their location."); continue; }
        try {
          // Infer from the named area's country when the user gave one (metric-imperial-infer); a bare
          // "near me" (coords, no place text) has no country signal, so it keeps the user pref/default.
          const units = resolveUnits(deps.weatherUnits, near);
          const opts = near
            ? { what, near, units, ...(deps.weatherCoords ? { bias: deps.weatherCoords } : {}) }
            : { what, lat: deps.weatherCoords!.lat, lng: deps.weatherCoords!.lng, units };
          const r = await backend.findNearby(opts);
          if ("error" in r) {
            push("find_nearby", r.error === "area_not_found"
              ? `I couldn't find the area "${near}" — ask the user for a more specific place.`
              : "No location to search around — ask the user where, or have them share their location.");
          } else if (!r.places.length) {
            push("find_nearby", `No ${what} found within ${Math.round(r.radiusKm)}km. Tell the user none turned up nearby.`);
          } else {
            // Note the radius when it widened past the default 3km so the user knows how far out these are.
            const widened = r.radiusKm > 3 ? ` (nearest within ${Math.round(r.radiusKm)}km)` : "";
            // Compute the user's LOCAL day + minute from the injected clock + tz so formatPlaces can tag
            // open/closed-now + list open places first (nearby-open-now). Omitted if no clock is wired.
            let now: { dow: number; mins: number } | undefined;
            if (deps.nowMs !== undefined) {
              const d = new Date(deps.nowMs + (deps.tzOffsetMin ?? 0) * 60_000);
              now = { dow: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
            }
            push("find_nearby", `${formatPlaces(r.places, what, units, now)}${widened} Report this to the user.`);
          }
        } catch (e) {
          push("find_nearby", `ERROR finding places: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "directions") {
        if (!backend.getDirections) { push("directions", "ERROR: directions aren't available."); continue; }
        const to = String(call.args.to ?? "").trim();
        const from = String(call.args.from ?? "").trim();
        if (!to) { push("directions", "ERROR: no destination given."); continue; }
        // Public-transit ask (transit-honest-not-driving): OSRM has no transit profile, so returning its
        // CAR ETA labeled "drive" is a confidently-wrong answer. Instead hand back a Google Maps transit
        // link (Maps owns schedule/route data) + an honest note that we can't compute transit time. Uses
        // the user's coords as the origin when no `from` is named. Checked BEFORE the OSRM route below.
        if (wantsTransit(userText) && !["driving", "walking", "cycling"].includes(String(call.args.mode))) {
          const link = transitMapsLink({ to, ...(from ? { from } : deps.weatherCoords ? { fromLat: deps.weatherCoords.lat, fromLng: deps.weatherCoords.lng } : {}) });
          push("directions", `I can't compute public-transit times myself (my routing is driving/walking/cycling only), but here's a live transit route on Google Maps:\n${link}\n\nGive the user this link + tell them honestly you can't do transit ETAs, and offer a driving/walking estimate instead if useful.`);
          continue;
        }
        if (!from && !deps.weatherCoords) { push("directions", "No start given and no saved location — ask where they're starting from."); continue; }
        // Infer from the destination (or origin) place name's country (metric-imperial-infer); no
        // recognizable country -> user pref / imperial default.
        const units = resolveUnits(deps.weatherUnits, to || from);
        const mode = (["driving", "walking", "cycling"].includes(String(call.args.mode)) ? String(call.args.mode) : routeMode(userText)) as "driving" | "walking" | "cycling";
        try {
          // A named `from` + known user coords: pass coords as `bias` (a hint) so the origin+destination
          // geocode toward the user's region (geo-tools-disambiguate-coords) without overriding `from`.
          // No `from`: start AT the user's coords.
          const opts = from
            ? { to, from, mode, units, ...(deps.weatherCoords ? { bias: deps.weatherCoords } : {}) }
            : { to, fromLat: deps.weatherCoords!.lat, fromLng: deps.weatherCoords!.lng, mode, units };
          const r = await backend.getDirections(opts);
          if (!r) { push("directions", `Couldn't route to "${to}" (unknown place or no route). Try a more specific address.`); continue; }
          push("directions", `${formatRoute(r, units)} Report this to the user.`);
        } catch (e) {
          push("directions", `ERROR getting directions: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "calendar_event") {
        const title = String(call.args.title ?? "").trim();
        if (!title) { push("calendar_event", "ERROR: no event title given."); continue; }
        const ev: CalEvent = { title,
          ...(Number.isFinite(Number(call.args.startMs)) ? { startMs: Number(call.args.startMs) } : {}),
          ...(call.args.startDate ? { startDate: String(call.args.startDate) } : {}),
          ...(Number.isFinite(Number(call.args.durationMin)) ? { durationMin: Number(call.args.durationMin) } : {}),
          ...(call.args.location ? { location: String(call.args.location) } : {}),
          ...(call.args.description ? { description: String(call.args.description) } : {}),
        };
        try {
          push("calendar_event", `${formatCalendar(ev, deps.nowMs ?? Date.now())}\n\n(Give this to the user verbatim — the title/when line + both links. You are NOT adding it to their calendar; they tap to add.)`);
        } catch (e) {
          push("calendar_event", `ERROR building the calendar event: ${e instanceof Error ? e.message : String(e)}. Ask the user to restate the date/time.`);
        }
        continue;
      }

      if (call.name === "compose") {
        const body = String(call.args.body ?? "").trim();
        if (!body) { push("compose", "ERROR: no draft body given."); continue; }
        const kind = String(call.args.kind ?? "email").toLowerCase() === "message" ? "message" : "email";
        // Contacts book (contacts-book-compose): if `to` isn't already a valid handle (it's a NAME like
        // "mom"/"my boss"), resolve it from the saved contacts so the draft addresses the right person
        // instead of dead-ending on an unaddressed link. Prefer email for an email draft, phone for a
        // message; fall back to the other handle if only one is saved.
        let to = call.args.to ? String(call.args.to) : "";
        const looksLikeHandle = /@/.test(to) || /^\+?[0-9][0-9\s().-]{5,}/.test(to);
        if (to && !looksLikeHandle && deps.resolveContact) {
          const c = deps.resolveContact(to);
          if (c) {
            const resolved = kind === "email" ? (c.email || c.phone) : (c.phone || c.email);
            if (resolved) to = resolved;
          }
        }
        const draft: Draft = { kind, body, ...(to ? { to } : {}), ...(call.args.subject ? { subject: String(call.args.subject) } : {}) };
        // The formatted draft + deep link IS the user-facing deliverable — hand it straight back so the
        // model relays it verbatim in reply (never re-summarize a draft the user is about to send).
        push("compose", `${formatDraft(draft)}\n\n(Give this to the user verbatim — the copy block + the "Tap to send" link. You are NOT sending it; they review and send.)`);
        continue;
      }

      if (call.name === "extract") {
        const url = String(call.args.url ?? "");
        const fields = Array.isArray(call.args.fields) ? call.args.fields.map(String).filter(Boolean) : [];
        const safe = isUrlSafe(url);
        if (!safe.safe) { push("extract", `ERROR: refused (${safe.reason}).`); continue; }
        if (fields.length === 0) { push("extract", "ERROR: no fields given. Provide the field names to extract."); continue; }
        try {
          const { json, title } = await extractOne(deps.llm, backend, url, fields);
          push("extract", `EXTRACTED from ${title || url}:\n${json}`);
        } catch (e) {
          push("extract", `ERROR extracting from ${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "compare") {
        const rawUrls = Array.isArray(call.args.urls) ? call.args.urls.map(String).filter(Boolean) : [];
        const fields = Array.isArray(call.args.fields) ? call.args.fields.map(String).filter(Boolean) : [];
        if (rawUrls.length === 0) { push("compare", "ERROR: no urls given."); continue; }
        if (fields.length === 0) { push("compare", "ERROR: no fields given."); continue; }
        // Dedup, cap, and drop unsafe targets up front (report which were skipped).
        const seenU = new Set<string>();
        const urls: string[] = [];
        const skipped: string[] = [];
        for (const u of rawUrls) {
          if (seenU.has(u)) continue;
          seenU.add(u);
          if (!isUrlSafe(u).safe) { skipped.push(u); continue; }
          if (urls.length < MAX_COMPARE_URLS) urls.push(u);
        }
        if (urls.length === 0) { push("compare", `ERROR: no safe urls to compare (skipped ${skipped.length}).`); continue; }
        // Fetch + extract each page in parallel; a per-URL failure becomes all-null for that row
        // rather than failing the whole compare.
        const rows = await Promise.all(urls.map(async (u) => {
          try {
            // Same text -> JSON-LD/meta fallback as the extract tool, per row.
            const { json } = await extractOne(deps.llm, backend, u, fields);
            return { url: u, ...(JSON.parse(json) as Record<string, unknown>) };
          } catch {
            return { url: u, ...Object.fromEntries(fields.map((f) => [f, null])) };
          }
        }));
        const note = skipped.length || rawUrls.length > MAX_COMPARE_URLS
          ? ` (skipped ${skipped.length} unsafe; capped at ${MAX_COMPARE_URLS})` : "";
        // csv-export-compare: if the user asked for a file/CSV/spreadsheet, attach the rows as a CSV
        // document (keepable + sortable) — the chat text still summarizes. Only when a doc isn't already
        // pending (a screenshot/pdf this turn takes precedence).
        if (!doc && CSV_REQUEST_RE.test(userText)) {
          const csv = rowsToCsv(rows);
          if (csv) {
            doc = new TextEncoder().encode(csv);
            docName = "comparison.csv";
            push("compare", `COMPARED ${rows.length} pages${note} and attached a CSV (${rows.length} rows). It will be sent to the user; call reply with a short summary of the comparison.`);
            continue;
          }
        }
        push("compare", `COMPARED ${rows.length} pages${note}:\n${JSON.stringify(rows, null, 2)}`);
        continue;
      }

      if (call.name === "search") {
        const url = String(call.args.url ?? "");
        const limit = Math.max(1, Math.min(MAX_SEARCH_LINKS, Number(call.args.limit) || 10));
        const safe = isUrlSafe(url);
        if (!safe.safe) { push("search", `ERROR: refused (${safe.reason}).`); continue; }
        try {
          const found = await backend.discoverLinks(url, MAX_SEARCH_LINKS * 2);
          // Prefer same-host result links (drop nav/offsite noise); SSRF-filter; dedup; cap.
          let host = "";
          try { host = new URL(url).hostname; } catch {}
          const sameHost = found.filter((h) => { try { return new URL(h).hostname === host; } catch { return false; } });
          const pool = sameHost.length >= 3 ? sameHost : found; // fall back to all if same-host too thin
          const seenL = new Set<string>();
          const links: string[] = [];
          for (const h of pool) {
            if (h.split("?")[0] === url.split("?")[0]) continue; // skip the search page itself
            if (seenL.has(h)) continue;
            seenL.add(h);
            if (!isUrlSafe(h).safe) continue;
            links.push(h);
            if (links.length >= limit) break;
          }
          if (links.length === 0) { push("search", `No candidate links found on ${url}.`); continue; }
          push("search", `FOUND ${links.length} links on ${url}:\n${JSON.stringify(links, null, 2)}\nUse extract/compare on these.`);
        } catch (e) {
          push("search", `ERROR searching ${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      if (call.name === "read") {
        if (!sessionId) { push("read", "ERROR: no page open. Call browse first."); continue; }
        try {
          const r = await backend.readCurrent(sessionId);
          push("read", formatPageForModel(r.title, r.url, r.content));
        } catch (e) {
          push("read", `ERROR: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      push(call.name, `ERROR: unknown tool "${call.name}".`);
    }

    if (finalReply !== null) return { reply: finalReply, steps: usedSteps, tools: toolsUsed, photo, doc, docName, degraded, ...(pendingAction ? { pendingAction } : {}) };

    // Ran out of the step budget without a final answer — a soft failure. Ask for a best-effort reply;
    // whether or not the model produces text, this path is degraded (never a clean value for an alert).
    const finalRes = await deps.llm.complete(
      [...messages, { role: "user", content: "Step budget reached. Reply now with your best answer using what you have." }],
      []
    );
    return { reply: finalRes.text?.trim() || "I ran out of steps before finishing. Try narrowing the request.", steps: stepLimit, tools: toolsUsed, photo, doc, docName, degraded: true };
  } finally {
    if (sessionId) await backend.releaseSession(sessionId).catch(() => {});
  }
}

// Structured extraction: a focused LLM sub-call over page text that returns ONLY a
// JSON object keyed by the requested fields (missing field -> null). Kept behind the
// same LLMClient so Claude/Gemini swap is unaffected. Returns a pretty JSON string;
// on any parse failure returns a JSON object with all fields null so the caller still
// gets valid, shaped output rather than prose.
export async function extractFields(llm: LLMClient, pageText: string, fields: string[]): Promise<string> {
  return (await extractFieldsResult(llm, pageText, fields)).json;
}

/** Extract fields from one URL: scrape text, and if that yields all-null, retry over
 * the page's JSON-LD/meta (when the backend supports it). Shared by the extract and
 * compare tools so both are SPA-robust. Returns the normalized JSON + the page title. */
export async function extractOne(
  llm: LLMClient,
  backend: BrowserBackend,
  url: string,
  fields: string[]
): Promise<{ json: string; title: string }> {
  const r = await backend.scrape(url);
  // Mark the cut (product-loop) so the extractor LLM knows the page was longer than 8000 chars —
  // otherwise a price/rating below the slice is silently missed and returned as if complete.
  let { json, allNull } = await extractFieldsResult(llm, truncateForModel(r.content, 8000), fields);
  if (allNull && backend.extractStructured) {
    const structured = await backend.extractStructured(url).catch(() => "");
    if (structured.trim()) {
      const retry = await extractFieldsResult(llm, truncateForModel(structured, 8000), fields);
      if (!retry.allNull) json = retry.json;
    }
  }
  return { json, title: r.title };
}

/** Like extractFields but also reports whether every field came back null — lets the
 * caller decide to retry with richer input (e.g. JSON-LD/meta) before giving up. */
export async function extractFieldsResult(
  llm: LLMClient,
  pageText: string,
  fields: string[]
): Promise<{ json: string; allNull: boolean }> {
  const nullOut = { json: JSON.stringify(Object.fromEntries(fields.map((f) => [f, null])), null, 2), allNull: true };
  const prompt = `From the page content below, extract these fields: ${fields.join(", ")}.
Respond with ONLY a JSON object whose keys are exactly those field names. If a field is not present, use null. No prose, no code fence.

PAGE CONTENT:
${pageText}`;
  const res = await llm.complete(
    [
      { role: "system", content: "You extract structured data from web page text and output only JSON." },
      { role: "user", content: prompt },
    ],
    []
  );
  const raw = (res.text ?? "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return nullOut;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const out = Object.fromEntries(fields.map((f) => [f, f in parsed ? parsed[f] : null]));
    const allNull = fields.every((f) => out[f] === null);
    return { json: JSON.stringify(out, null, 2), allNull };
  } catch {
    return nullOut;
  }
}
