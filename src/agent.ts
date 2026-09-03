// Agent loop. An LLM plans over tools to answer the user, driving the self-hosted
// anvil browser. The LLM sits behind LLMClient so Claude can replace Gemini in one
// line. Two modes of browser use:
//   - scrape(url): one-shot fetch of a page's text (own session, auto-released).
//   - browse/click/type/read: a PERSISTENT session held for the task, so the agent
//     can navigate -> click -> read across steps (multi-step browsing).
// Bounded by RELAY_MAX_STEPS. Destructive clicks/typing are gated by the
// dangerous-action guard (safety.ts).

import * as anvil from "./anvil.js";
import { isUrlSafe } from "./lib/url-validator.js";
import { intEnv } from "./lib/env.js";
import { isDangerousAction } from "./safety.js";
import { fetchYouTubeTranscript } from "./lib/youtube.js";
import { rowsToCsv } from "./lib/to-csv.js";

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
    name: "transcript",
    description: "Fetch the spoken transcript (captions) of a YouTube video by URL. Use this — NOT scrape — whenever the user gives a YouTube link (youtube.com/watch, youtu.be, /shorts) and wants it summarized, quoted, or answered from (\"summarize this video\", \"what does this video say about X\", \"tldr\"). Returns the plain transcript text; then summarize/answer from it. If captions are unavailable it says so.",
    parameters: { type: "object", properties: { url: { type: "string", description: "A YouTube video URL (watch/youtu.be/shorts)" } }, required: ["url"] },
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
- "screenshot" (url): capture a page as an IMAGE and send it. Use when the user wants to SEE a page ("show me", "screenshot", "what does X look like"), not read its text. Then call reply with a short caption.
- "pdf" (url): render a page to a PDF and send it as a document. Use when the user wants to SAVE or KEEP a page ("save as PDF", "send me a PDF of X"). Then call reply with a short caption.
- "transcript" (url): get a YouTube video's spoken transcript. Use this — NOT scrape — for any YouTube link the user wants summarized or answered from; scrape only sees YouTube's empty JS shell.
- "reply" (text): finish.

Rules:
- Prefer "scrape" for read-only lookups; use "browse" only when you must click or type.
- I will REFUSE destructive/committing clicks (pay, buy, delete, submit, logout, transfer). Don't attempt them; tell the user instead.
- Take few steps. When you have enough, call "reply".
- The user is on a phone. In "reply", write a short plain-text answer — never paste raw JSON. If you extracted/compared data, summarize it in a line or two (e.g. "A is $10, B is $20"). No markdown tables.
- If something needs a login or a paid/irreversible action, call "reply" and say so plainly. Never invent data you didn't retrieve.
- ANSWER DIRECTLY (call "reply" with NO tool first) when the answer is deterministic and needs no live data: arithmetic + tips + percentages ("20% tip on $47" = $9.40), unit/measure conversions ("how many oz in a cup" = 8), date/time math, and stable common knowledge ("capital of France"). Don't open a browser or search for these — it just adds 10-30s. Use tools ONLY when the answer is time-sensitive or uncertain: live prices, exchange rates that move (currency conversion needs a live rate — fetch it), news, weather, anything "current"/"today"/"now". When unsure whether a fact is stable, verify with a tool rather than guess.
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
  // Optional: fetch a YouTube video's caption transcript as plain text (video-transcript-summary).
  // Absent -> the transcript tool reports it's unavailable. Returns null when the video has no
  // captions / isn't a YouTube URL.
  videoTranscript?(url: string): Promise<{ videoId: string; text: string } | null>;
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
  return `TITLE: ${title || url}\n\n${truncateForModel(content)}`;
}

// Paywall / metered-access language. Matches the common subscribe-wall stubs (NYT/WSJ/Economist/
// Medium/Bloomberg/FT etc.). Exported for tests.
const PAYWALL_RE = /\b(subscribe to (?:continue|read)|subscribers? only|create (?:a\s+)?(?:free\s+)?account to (?:continue|read)|already a subscriber|to continue reading|this (?:article|content|story) is (?:for subscribers|reserved)|register to (?:continue|read)|sign in to (?:continue|read)|become a member to|unlock this (?:article|story)|start your (?:free )?(?:trial|subscription)|metered|paywall)\b/i;
export function looksPaywalled(content: string): boolean {
  return PAYWALL_RE.test(String(content ?? ""));
}

// Default fetchJson: a plain guarded GET. SSRF is checked by the caller; here we cap
// size, require a JSON content-type, and never forward credentials/cookies.
async function defaultFetchJson(url: string): Promise<{ status: number; contentType: string; text: string }> {
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf.slice(0, FETCH_JSON_MAX_BYTES));
  return { status: res.status, contentType, text };
}

// Plain guarded GET returning the body text (for the transcript fetch — YouTube watch page + caption
// track). Size-capped, no credentials. SSRF is checked by the caller before this runs.
async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "text/html,application/xml,*/*", "accept-language": "en" },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  const buf = await res.arrayBuffer();
  return new TextDecoder().decode(buf.slice(0, TRANSCRIPT_MAX_BYTES));
}

const defaultBackend: BrowserBackend = {
  scrape: (url) => anvil.scrape(url, { format: "text" }),
  videoTranscript: (url) => fetchYouTubeTranscript(url, defaultFetchText),
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
): Promise<{ reply: string; steps: number; tools: string[]; photo?: Uint8Array; doc?: Uint8Array; docName?: string; degraded?: boolean }> {
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
          if (!results.length) { push("web_search", `No results for "${query}".`); continue; }
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

    if (finalReply !== null) return { reply: finalReply, steps: usedSteps, tools: toolsUsed, photo, doc, docName, degraded };

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
