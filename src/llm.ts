// LLM adapter. The agent talks to this interface only, so the model is swappable:
// GeminiClient (free tier) today; a ClaudeClient is a drop-in later. Function-calling
// is normalized to a single optional toolCall per turn.

export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  // Gemini 2.5+ returns a thoughtSignature on functionCall parts that MUST be
  // echoed back on the assistant turn, or the next call 400s. Opaque; carried through.
  thoughtSignature?: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string; // for role "tool": which tool produced this
  toolCall?: ToolCall; // for role "assistant": the call it made
}

export interface LLMResult {
  text?: string;
  toolCall?: ToolCall;
}

export interface LLMClient {
  complete(messages: LLMMessage[], tools: ToolSpec[]): Promise<LLMResult>;
}

// ---- Gemini (free tier) ----------------------------------------------------

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";

interface GeminiPart {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** Map our neutral message list to Gemini's contents[] + systemInstruction. */
function toGemini(messages: LLMMessage[]): { system?: string; contents: GeminiContent[] } {
  let system: string | undefined;
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
    } else if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      if (m.toolCall) {
        const fcPart: GeminiPart = { functionCall: { name: m.toolCall.name, args: m.toolCall.args } };
        // Echo the thoughtSignature back on the functionCall part (Gemini 2.5+ requires it).
        if (m.toolCall.thoughtSignature) fcPart.thoughtSignature = m.toolCall.thoughtSignature;
        parts.push(fcPart);
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
    } else if (m.role === "tool") {
      // Gemini expects tool output as a functionResponse in a "user"-role turn.
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: m.name ?? "tool", response: { result: m.content } } }],
      });
    }
  }
  return { system, contents };
}

export class GeminiClient implements LLMClient {
  constructor(private apiKey = process.env.GEMINI_API_KEY ?? "") {}

  async complete(messages: LLMMessage[], tools: ToolSpec[]): Promise<LLMResult> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY not set");
    const { system, contents } = toGemini(messages);
    const body: Record<string, unknown> = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    }
    // Auth via X-goog-api-key header (works for both classic AIza keys and the
    // newer AQ.* keys; the ?key= query param 404s newer keys against some models).
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    // Free tier 503s ("high demand") + 429s (rate limit) are common and transient.
    // Retry with exponential backoff before giving up.
    const RETRYABLE = new Set([429, 500, 503, 504]);
    const MAX_ATTEMPTS = 4;
    let r!: Response;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      }).catch((e) => {
        // Network/timeout — treat as retryable via a synthetic 503-like Response.
        return new Response(JSON.stringify({ error: { message: String(e) } }), { status: 503 });
      });
      if (r.ok || !RETRYABLE.has(r.status) || attempt === MAX_ATTEMPTS) break;
      r.body?.cancel?.();
      await new Promise((res) => setTimeout(res, 800 * 2 ** (attempt - 1))); // 0.8s, 1.6s, 3.2s
    }
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const j = (await r.json()) as {
      candidates?: { content?: { parts?: GeminiPart[] } }[];
    };
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    const fcPart = parts.find((p) => p.functionCall);
    const fc = fcPart?.functionCall;
    const text = parts.map((p) => p.text).filter(Boolean).join("").trim() || undefined;
    if (fc) {
      const tc: ToolCall = { name: fc.name, args: fc.args ?? {} };
      // thoughtSignature can sit on the functionCall part or a sibling part.
      const sig = fcPart?.thoughtSignature ?? parts.find((p) => p.thoughtSignature)?.thoughtSignature;
      if (sig) tc.thoughtSignature = sig;
      return { text, toolCall: tc };
    }
    return { text };
  }
}
