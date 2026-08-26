// SMS-friendly reply formatting. The agent's tools (extract/compare) hand JSON to
// the model; the model is told to summarize, but as a deterministic safety net we
// also catch a reply that is (or contains) a raw JSON array/object of data and render
// it as short readable lines — so a user never receives a raw JSON blob in a text.
// Pure + LLM-agnostic.

const MAX_LEN = 1200; // keep replies phone-sized
const MAX_LINES = 12;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return Array.isArray(v) ? v.map(scalar).join(", ") : JSON.stringify(v);
  return String(v);
}

/** Render one object as "k: v | k: v", preferring a name/title/url key first. */
function objectLine(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  const leadKey = ["title", "name", "url"].find((k) => k in obj);
  const ordered = leadKey ? [leadKey, ...keys.filter((k) => k !== leadKey)] : keys;
  return ordered.map((k) => `${k}: ${scalar(obj[k])}`).join(" | ");
}

/** Turn a parsed JSON value (array of objects / single object) into readable lines. */
function renderJson(val: unknown): string | null {
  if (Array.isArray(val) && val.length > 0 && val.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    return val.slice(0, MAX_LINES).map((o) => `• ${objectLine(o as Record<string, unknown>)}`).join("\n");
  }
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return objectLine(val as Record<string, unknown>);
  }
  return null;
}

function trim(s: string): string {
  const lines = s.split("\n");
  let out = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join("\n") + "\n…" : s;
  if (out.length > MAX_LEN) out = out.slice(0, MAX_LEN - 1).trimEnd() + "…";
  return out;
}

/**
 * Format an outgoing reply for SMS. If the whole reply is JSON, or contains a fenced
 * JSON block, render that data as compact lines; otherwise pass the text through.
 * Always trims to a phone-friendly size.
 */
export function formatReply(text: string): string {
  const raw = (text ?? "").trim();
  if (!raw) return "Done.";

  // Whole reply is JSON?
  if (/^[[{]/.test(raw)) {
    try {
      const rendered = renderJson(JSON.parse(raw));
      if (rendered) return trim(rendered);
    } catch { /* not valid JSON — fall through */ }
  }

  // A fenced ```json ... ``` (or bare {...}/[...]) block embedded in prose?
  const fence = raw.match(/```(?:json)?\s*([[{][\s\S]*?[\]}])\s*```/);
  const block = fence?.[1] ?? raw.match(/(^|\n)\s*([[{][\s\S]*[\]}])\s*$/)?.[2];
  if (block) {
    try {
      const rendered = renderJson(JSON.parse(block));
      if (rendered) {
        const prose = raw.replace(fence?.[0] ?? block, "").trim();
        return trim(prose ? `${prose}\n${rendered}` : rendered);
      }
    } catch { /* leave as-is */ }
  }

  return trim(raw);
}
