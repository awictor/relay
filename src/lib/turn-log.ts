// Per-turn observability. Formats a single structured JSON line summarizing an agent
// turn — enough to debug a 24/7 deploy from logs alone, with no message content
// (privacy) and no secrets. Pure so it's unit-testable.

export interface TurnSummary {
  chatId: string | number;
  steps: number;
  tools: string[];
  elapsedMs: number;
  replyChars: number;
  ok: boolean;
  error?: string;
}

/** Build the `[out]` log line: a compact JSON object. Never includes message text or
 * secrets — only shape/metadata. Tool names are deduped+counted (e.g. "scrape x2"). */
export function formatTurnLog(s: TurnSummary): string {
  const counts = new Map<string, number>();
  for (const t of s.tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tools = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} x${c}` : n));
  const obj: Record<string, unknown> = {
    chat: String(s.chatId),
    steps: s.steps,
    tools,
    ms: Math.max(0, Math.round(s.elapsedMs)),
    replyChars: Math.max(0, s.replyChars),
    ok: s.ok,
  };
  if (s.error) obj.error = s.error.slice(0, 200);
  return `[out] ${JSON.stringify(obj)}`;
}
