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
import { isDangerousAction } from "./safety.js";
import type { LLMClient, LLMMessage, ToolSpec, ToolCall } from "./llm.js";

const MAX_STEPS = Number(process.env.RELAY_MAX_STEPS ?? 8);

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
    name: "reply",
    description: "Send the final answer to the user and end the task. Call exactly once when done or when you must report you cannot complete it.",
    parameters: { type: "object", properties: { text: { type: "string", description: "Message to send the user" } }, required: ["text"] },
  },
];

const MAX_COMPARE_URLS = 5;
const MAX_SEARCH_LINKS = 20;

const SYSTEM_PROMPT = `You are Relay, an assistant reached over text message. A user texts a task; use tools to accomplish it, then call "reply" with a concise, friendly answer (they're on a phone — keep it short, no markdown tables).

Tools:
- "scrape" (url): read a single page. Use for simple lookups. If the user names a site, infer the URL (Hacker News -> https://news.ycombinator.com).
- "browse" (url) then "click"/"type"/"read": for tasks needing interaction (search a site, fill a form, page through results). "read" returns the current page after your actions.
- "extract" (url, fields): fetch a page and get back clean JSON for specific fields (price, title, rating...). Prefer this over "scrape" when the user wants particular data points, not a summary.
- "compare" (urls, fields): fetch several pages and extract the same fields from each; returns a JSON array. Use when the user wants to compare data points across multiple links.
- "search" (url): open a search/listing page and get candidate result links back. Use when the user knows WHAT they want but not the exact URLs — build the site's search URL, call search, then extract/compare across the returned links.
- "reply" (text): finish.

Rules:
- Prefer "scrape" for read-only lookups; use "browse" only when you must click or type.
- I will REFUSE destructive/committing clicks (pay, buy, delete, submit, logout, transfer). Don't attempt them; tell the user instead.
- Take few steps. When you have enough, call "reply".
- If something needs a login or a paid/irreversible action, call "reply" and say so plainly. Never invent data you didn't retrieve.`;

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
}

const defaultBackend: BrowserBackend = {
  scrape: (url) => anvil.scrape(url, { format: "text" }),
  createSession: () => anvil.createSession().then((s) => ({ id: s.id })),
  navigate: (id, url) => anvil.navigate(id, url),
  click: (id, sel) => anvil.click(id, sel),
  type: (id, sel, text) => anvil.type(id, sel, text),
  readCurrent: (id) => anvil.readCurrent(id),
  releaseSession: (id) => anvil.releaseSession(id),
  discoverLinks: (url, limit) => anvil.discoverLinks(url, limit),
};

export interface AgentDeps {
  llm: LLMClient;
  backend?: BrowserBackend;
  // Back-compat: tests may pass just scrapeFn.
  scrapeFn?: (url: string) => Promise<{ title: string; content: string; url: string }>;
}

export async function runAgent(
  userText: string,
  deps: AgentDeps,
  history: LLMMessage[] = []
): Promise<{ reply: string; steps: number }> {
  const backend: BrowserBackend = deps.backend ?? {
    ...defaultBackend,
    ...(deps.scrapeFn ? { scrape: deps.scrapeFn } : {}),
  };

  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userText },
  ];

  let sessionId: string | null = null; // persistent browse session, if opened
  const push = (name: string, content: string) => messages.push({ role: "tool", name, content });

  try {
    let finalReply: string | null = null;
    let usedSteps = MAX_STEPS;

    for (let step = 1; step <= MAX_STEPS; step++) {
      const res = await deps.llm.complete(messages, TOOLS);

      if (!res.toolCall) {
        finalReply = res.text?.trim() || "Sorry, I couldn't come up with an answer.";
        usedSteps = step;
        break;
      }

      const call: ToolCall = res.toolCall;
      messages.push({ role: "assistant", content: res.text ?? "", toolCall: call });

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
          push("scrape", `TITLE: ${r.title || r.url}\n\n${r.content.slice(0, 6000)}`);
        } catch (e) {
          push("scrape", `ERROR fetching ${url}: ${e instanceof Error ? e.message : String(e)}`);
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
        const label = String(call.args.label ?? "") + " " + selector + " " + String(call.args.text ?? "");
        if (isDangerousAction(label)) {
          push(call.name, `REFUSED: that looks like a destructive/committing action ("${label.trim()}"). I won't do that autonomously — tell the user.`);
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

      if (call.name === "extract") {
        const url = String(call.args.url ?? "");
        const fields = Array.isArray(call.args.fields) ? call.args.fields.map(String).filter(Boolean) : [];
        const safe = isUrlSafe(url);
        if (!safe.safe) { push("extract", `ERROR: refused (${safe.reason}).`); continue; }
        if (fields.length === 0) { push("extract", "ERROR: no fields given. Provide the field names to extract."); continue; }
        try {
          const r = await backend.scrape(url);
          const json = await extractFields(deps.llm, r.content.slice(0, 8000), fields);
          push("extract", `EXTRACTED from ${r.title || url}:\n${json}`);
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
            const r = await backend.scrape(u);
            const json = await extractFields(deps.llm, r.content.slice(0, 8000), fields);
            return { url: u, ...(JSON.parse(json) as Record<string, unknown>) };
          } catch {
            return { url: u, ...Object.fromEntries(fields.map((f) => [f, null])) };
          }
        }));
        const note = skipped.length || rawUrls.length > MAX_COMPARE_URLS
          ? ` (skipped ${skipped.length} unsafe; capped at ${MAX_COMPARE_URLS})` : "";
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
          push("read", `TITLE: ${r.title || r.url}\n\n${r.content.slice(0, 6000)}`);
        } catch (e) {
          push("read", `ERROR: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      push(call.name, `ERROR: unknown tool "${call.name}".`);
    }

    if (finalReply !== null) return { reply: finalReply, steps: usedSteps };

    const finalRes = await deps.llm.complete(
      [...messages, { role: "user", content: "Step budget reached. Reply now with your best answer using what you have." }],
      []
    );
    return { reply: finalRes.text?.trim() || "I ran out of steps before finishing. Try narrowing the request.", steps: MAX_STEPS };
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
  const nullObj = () => JSON.stringify(Object.fromEntries(fields.map((f) => [f, null])), null, 2);
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
  // Tolerate a stray code fence or leading prose: grab the first {...} block.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return nullObj();
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    // Normalize to exactly the requested fields (drop extras, fill missing with null).
    const out = Object.fromEntries(fields.map((f) => [f, f in parsed ? parsed[f] : null]));
    return JSON.stringify(out, null, 2);
  } catch {
    return nullObj();
  }
}
