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

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";

interface GeminiPart {
  text?: string;
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
      if (m.toolCall) parts.push({ functionCall: { name: m.toolCall.name, args: m.toolCall.args } });
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const j = (await r.json()) as {
      candidates?: { content?: { parts?: GeminiPart[] } }[];
    };
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    const fc = parts.find((p) => p.functionCall)?.functionCall;
    const text = parts.map((p) => p.text).filter(Boolean).join("").trim() || undefined;
    if (fc) return { text, toolCall: { name: fc.name, args: fc.args ?? {} } };
    return { text };
  }
}
