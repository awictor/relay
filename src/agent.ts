// Agent loop. An LLM plans over tools (browse/scrape/reply) to answer the user,
// driving the self-hosted anvil browser. The LLM sits behind the LLMClient
// interface so Claude can replace Gemini in one line (see llm.ts).
//
// Loop: feed the conversation + tool results to the LLM; it either calls a tool
// (we run it, append the result, continue) or emits a final reply. Bounded by
// RELAY_MAX_STEPS so a confused model can't loop forever.

import { scrape } from "./anvil.js";
import { isUrlSafe } from "./lib/url-validator.js";
import type { LLMClient, LLMMessage, ToolSpec, ToolCall } from "./llm.js";

const MAX_STEPS = Number(process.env.RELAY_MAX_STEPS ?? 8);

// Tool schemas advertised to the LLM.
export const TOOLS: ToolSpec[] = [
  {
    name: "scrape",
    description:
      "Fetch the readable text of a web page by URL. Use for reading an article, a listing, a docs page, or any single page. Returns the page title and text content.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "reply",
    description:
      "Send the final answer to the user and end the task. Call this exactly once when you have the answer or must report you cannot complete it.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The message to send to the user" },
      },
      required: ["text"],
    },
  },
];

const SYSTEM_PROMPT = `You are Relay, an assistant reached over text message. A user texts you a task; you use tools to accomplish it, then call "reply" with a concise, friendly answer (they're on a phone — keep it short, no markdown tables).

Rules:
- To read a web page, call "scrape" with an absolute URL. If the user names a site without a URL, infer the obvious URL (e.g. Hacker News -> https://news.ycombinator.com).
- Take at most a few steps. When you have enough to answer, call "reply".
- If you cannot do something (needs a login, a paid action, or a capability you lack), call "reply" and say so plainly.
- Never invent data you didn't retrieve. If a fetch failed, say it failed.`;

export interface AgentDeps {
  llm: LLMClient;
  // scrape is injected so tests can stub it without hitting the network/anvil.
  scrapeFn?: (url: string) => Promise<{ title: string; content: string; url: string }>;
}

/** Run one user task to completion. Returns the reply text sent to the user. */
export async function runAgent(
  userText: string,
  deps: AgentDeps,
  history: LLMMessage[] = []
): Promise<{ reply: string; steps: number }> {
  const scrapeFn = deps.scrapeFn ?? ((url: string) => scrape(url, { format: "text" }));
  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userText },
  ];

  for (let step = 1; step <= MAX_STEPS; step++) {
    const res = await deps.llm.complete(messages, TOOLS);

    if (!res.toolCall) {
      // Model answered directly without calling reply — treat its text as the reply.
      const text = res.text?.trim() || "Sorry, I couldn't come up with an answer.";
      return { reply: text, steps: step };
    }

    const call: ToolCall = res.toolCall;
    // Record the model's tool call in the transcript.
    messages.push({ role: "assistant", content: res.text ?? "", toolCall: call });

    if (call.name === "reply") {
      const text = String(call.args.text ?? "").trim() || "Done.";
      return { reply: text, steps: step };
    }

    if (call.name === "scrape") {
      const url = String(call.args.url ?? "");
      const safe = isUrlSafe(url);
      let toolResult: string;
      if (!safe.safe) {
        toolResult = `ERROR: refused to fetch that URL (${safe.reason}).`;
      } else {
        try {
          const r = await scrapeFn(url);
          toolResult = `TITLE: ${r.title || r.url}\n\n${r.content.slice(0, 6000)}`;
        } catch (e) {
          toolResult = `ERROR fetching ${url}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      messages.push({ role: "tool", name: "scrape", content: toolResult });
      continue;
    }

    // Unknown tool — tell the model and let it recover.
    messages.push({ role: "tool", name: call.name, content: `ERROR: unknown tool "${call.name}".` });
  }

  // Ran out of steps without a reply — ask the model for a best-effort summary once.
  const finalRes = await deps.llm.complete(
    [...messages, { role: "user", content: "Step budget reached. Reply now with your best answer using what you have." }],
    []
  );
  return { reply: finalRes.text?.trim() || "I ran out of steps before finishing. Try narrowing the request.", steps: MAX_STEPS };
}
