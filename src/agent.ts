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
    name: "reply",
    description: "Send the final answer to the user and end the task. Call exactly once when done or when you must report you cannot complete it.",
    parameters: { type: "object", properties: { text: { type: "string", description: "Message to send the user" } }, required: ["text"] },
  },
];

const SYSTEM_PROMPT = `You are Relay, an assistant reached over text message. A user texts a task; use tools to accomplish it, then call "reply" with a concise, friendly answer (they're on a phone — keep it short, no markdown tables).

Tools:
- "scrape" (url): read a single page. Use for simple lookups. If the user names a site, infer the URL (Hacker News -> https://news.ycombinator.com).
- "browse" (url) then "click"/"type"/"read": for tasks needing interaction (search a site, fill a form, page through results). "read" returns the current page after your actions.
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
}

const defaultBackend: BrowserBackend = {
  scrape: (url) => anvil.scrape(url, { format: "text" }),
  createSession: () => anvil.createSession().then((s) => ({ id: s.id })),
  navigate: (id, url) => anvil.navigate(id, url),
  click: (id, sel) => anvil.click(id, sel),
  type: (id, sel, text) => anvil.type(id, sel, text),
  readCurrent: (id) => anvil.readCurrent(id),
  releaseSession: (id) => anvil.releaseSession(id),
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
