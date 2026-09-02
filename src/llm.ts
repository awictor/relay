// LLM adapter. The agent talks to this interface only, so the model is swappable:
// GeminiClient (free tier) today; a ClaudeClient is a drop-in later. Function-calling
// is normalized to a single optional toolCall per turn.

export type LLMProvider = "gemini" | "claude";

/**
 * Resolve the LLM_PROVIDER env value to a known provider. Only "gemini"/"claude" are valid
 * (case/space-insensitive); anything else defaults to gemini AND returns a warning naming the bad
 * value, so a typo like "claud"/"gpt" doesn't silently run Gemini while the startup log claims
 * otherwise (DEV-0155). An empty/unset value is the intended default — no warning.
 */
export function resolveProvider(raw: string | undefined): { provider: LLMProvider; warning?: string } {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "gemini") return { provider: "gemini" };
  if (v === "claude") return { provider: "claude" };
  return { provider: "gemini", warning: `Unknown LLM_PROVIDER="${raw}" — falling back to gemini. Valid: gemini | claude.` };
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
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
  // Optional multimodal: describe/answer about an image (product-loop). Given raw bytes + mime +
  // the user's question (caption), return a text answer. Absent = the provider has no vision path.
  describeImage?(image: Uint8Array, mimeType: string, prompt: string): Promise<string>;
}

// ---- Gemini (free tier) ----------------------------------------------------

// Failover chain of free models. First = primary (GEMINI_MODEL env, default the
// -lite tier for its higher free-tier request cap). On a 429/quota, we advance to
// the next model instead of failing — one exhausted bucket won't kill the bot.
// Each has an independent free quota. Set GEMINI_MODELS (comma-list) to override.
const GEMINI_MODELS: string[] = (
  process.env.GEMINI_MODELS ??
  [process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"].join(",")
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean)
  .filter((m, i, a) => a.indexOf(m) === i); // de-dupe

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

/** Map our neutral message list to Gemini's contents[] + systemInstruction. Exported for tests
 * (DEV-0039): a wrong mapping — esp. the Gemini-2.5 thoughtSignature roundtrip — silently breaks
 * every LLM call. */
export function toGemini(messages: LLMMessage[]): { system?: string; contents: GeminiContent[] } {
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
    // Transient (retry same model w/ backoff) vs quota (fail over to next model now). 502 Bad Gateway
    // + 408 Request Timeout are transient upstream blips too (DEV-0149) — worth a same-model retry
    // before failover, consistent with 500/503/504 and anvil's own 502 handling.
    const TRANSIENT = new Set([500, 502, 503, 504, 408]);
    const MAX_ATTEMPTS = 3;
    let r!: Response;
    let lastErr = "";

    // Outer loop: models (failover). Inner loop: transient retries on one model.
    outer: for (let mi = 0; mi < GEMINI_MODELS.length; mi++) {
      const model = GEMINI_MODELS[mi]!;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        }).catch((e) => new Response(JSON.stringify({ error: { message: String(e) } }), { status: 503 }));

        if (r.ok) break outer;

        // 429/quota (or 403 quota) → don't retry this model; fail over immediately.
        if (r.status === 429 || r.status === 403) {
          lastErr = `${model} ${r.status}`;
          r.body?.cancel?.();
          continue outer;
        }
        // Transient → backoff + retry same model.
        if (TRANSIENT.has(r.status) && attempt < MAX_ATTEMPTS) {
          r.body?.cancel?.();
          await new Promise((res) => setTimeout(res, 800 * 2 ** (attempt - 1)));
          continue;
        }
        // Non-retryable (e.g. 400/404) or out of attempts → try next model.
        lastErr = `${model} ${r.status}`;
        r.body?.cancel?.();
        continue outer;
      }
    }
    if (!r.ok) throw new Error(`Gemini all models failed (${lastErr}): ${(await r.text().catch(() => "")).slice(0, 160)}`);
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

  /** Vision: answer `prompt` about an image via Gemini's inlineData part (multimodal, free tier).
   * Fails over across GEMINI_MODELS on quota like complete(). Throws on total failure. */
  async describeImage(image: Uint8Array, mimeType: string, prompt: string): Promise<string> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY not set");
    const b64 = Buffer.from(image).toString("base64");
    const body = {
      contents: [{ role: "user", parts: [
        { text: prompt || "Describe this image and answer any question in it." },
        { inlineData: { mimeType: mimeType || "image/jpeg", data: b64 } },
      ] }],
    };
    const TRANSIENT = new Set([500, 502, 503, 504, 408]);
    let r!: Response; let lastErr = "";
    outer: for (const model of GEMINI_MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      for (let attempt = 1; attempt <= 3; attempt++) {
        r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        }).catch((e) => new Response(JSON.stringify({ error: { message: String(e) } }), { status: 503 }));
        if (r.ok) break outer;
        if (r.status === 429 || r.status === 403) { lastErr = `${model} ${r.status}`; r.body?.cancel?.(); continue outer; }
        if (TRANSIENT.has(r.status) && attempt < 3) { r.body?.cancel?.(); await new Promise((res) => setTimeout(res, 800 * 2 ** (attempt - 1))); continue; }
        lastErr = `${model} ${r.status}`; r.body?.cancel?.(); continue outer;
      }
    }
    if (!r.ok) throw new Error(`Gemini vision failed (${lastErr})`);
    const j = (await r.json()) as { candidates?: { content?: { parts?: GeminiPart[] } }[] };
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p) => p.text).filter(Boolean).join("").trim() || "I couldn't read that image.";
  }
}

// ---- Claude (Anthropic Messages API) ---------------------------------------
// Drop-in LLMClient so the agent brain swaps with one env var (LLM_PROVIDER=claude).
// The Messages API differs from Gemini in shape: `system` is a top-level string (not a
// turn), tool calls are `tool_use` content blocks, tool results are `tool_result` blocks
// referenced by a tool_use_id, and tools carry an `input_schema` (our ToolSpec.parameters
// is already a JSON Schema object, so it maps 1:1).

interface ClaudeBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;                       // tool_use id
  name?: string;                     // tool_use name
  input?: Record<string, unknown>;   // tool_use args
  tool_use_id?: string;              // tool_result -> which call
  content?: string;                  // tool_result body
}
interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeBlock[];
}

/** Map our neutral message list to Anthropic's { system, messages[] }. Exported for tests: a wrong
 * mapping (esp. pairing a tool_result to its tool_use_id) silently breaks every Claude call. Our
 * ToolCall has no per-call id (Gemini has none), so we derive a stable synthetic id from the tool
 * name + its position, and the following tool turn reuses the most recent one. */
export function toClaude(messages: LLMMessage[]): { system?: string; messages: ClaudeMessage[] } {
  let system: string | undefined;
  const out: ClaudeMessage[] = [];
  let lastToolUseId: string | undefined;
  let seq = 0;
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: ClaudeBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      if (m.toolCall) {
        lastToolUseId = `call_${++seq}_${m.toolCall.name}`;
        blocks.push({ type: "tool_use", id: lastToolUseId, name: m.toolCall.name, input: m.toolCall.args });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
    } else if (m.role === "tool") {
      // Anthropic wants tool output as a tool_result block in a USER turn, tied to the tool_use id.
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: lastToolUseId ?? `call_${seq}`, content: m.content }],
      });
    }
  }
  return { system, messages: out };
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;

export class ClaudeClient implements LLMClient {
  private model: string;
  // Injectable transport so tests exercise the request-shaping + response-parsing offline (no key,
  // no network). Defaults to global fetch.
  constructor(
    private apiKey = process.env.ANTHROPIC_API_KEY ?? "",
    opts: { model?: string; fetch?: Transport } = {}
  ) {
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
    if (opts.fetch) this.transport = opts.fetch;
  }
  private transport: Transport = (url, init) => fetch(url, init);

  async complete(messages: LLMMessage[], tools: ToolSpec[]): Promise<LLMResult> {
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    const { system, messages: msgs } = toClaude(messages);
    const body: Record<string, unknown> = { model: this.model, max_tokens: 1024, messages: msgs };
    if (system) body.system = system;
    if (tools.length) {
      // ToolSpec.parameters is already a JSON Schema object → Anthropic's input_schema 1:1.
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    // Bounded same-endpoint retry on transient statuses (DEV-0150). A single attempt made a transient
    // 500/502/503/504/429/408 a hard user-facing failure; Gemini already retries, so Claude should too.
    // 4xx (except 408/429) is deterministic — throw immediately, no retry.
    const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
    const MAX_ATTEMPTS = 3;
    let r!: Response;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      r = await this.transport("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      }).catch((e) => new Response(JSON.stringify({ error: { message: String(e) } }), { status: 503 }));
      if (r.ok || !TRANSIENT.has(r.status) || attempt === MAX_ATTEMPTS) break;
      r.body?.cancel?.();
      await new Promise((res) => setTimeout(res, 800 * 2 ** (attempt - 1)));
    }

    if (!r.ok) {
      // Surface status in the message so isTransientError can classify (5xx/429 transient).
      const detail = (await r.text().catch(() => "")).slice(0, 160);
      throw new Error(`Claude API ${r.status}: ${detail}`);
    }
    const j = (await r.json()) as { content?: ClaudeBlock[] };
    const blocks = j.content ?? [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).filter(Boolean).join("").trim() || undefined;
    const use = blocks.find((b) => b.type === "tool_use");
    if (use && use.name) {
      return { text, toolCall: { name: use.name, args: (use.input as Record<string, unknown>) ?? {} } };
    }
    return { text };
  }
}
