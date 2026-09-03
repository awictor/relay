// Inbound-document classification (inbound-document-handling): a forwarded file is either something a
// VISION model reads natively (PDF, image scan) or something that is really just TEXT (CSV, JSON, .txt,
// Markdown, logs). The original document path sent EVERYTHING to describeImage (the vision call); a CSV
// or JSON handed to a vision model as raw bytes — mislabeled image/jpeg because csv wasn't even in the
// MIME map — came back as garbage. This module decides which path a doc takes and decodes textual bytes
// into a promptable string. Pure + unit-tested; the LLM/network stay out.

// mime types (and a few extension fallbacks) we treat as TEXT rather than a vision document.
const TEXT_MIMES = new Set([
  "text/plain", "text/csv", "text/tab-separated-values", "application/json", "text/markdown",
  "text/xml", "application/xml", "text/yaml", "application/x-yaml", "text/x-log",
]);

/** True when this document is textual (read it as text), false when it's a vision doc (PDF/image scan)
 * that the multimodal model should ingest as bytes. Uses the mime, then an extension fallback for the
 * generic application/octet-stream Telegram sometimes reports. Exported for tests. */
export function isTextualDoc(mimeType: string, fileName?: string): boolean {
  const mime = (mimeType || "").toLowerCase().split(";")[0]!.trim();
  if (mime === "application/pdf" || mime.startsWith("image/")) return false;
  if (TEXT_MIMES.has(mime)) return true;
  if (mime.startsWith("text/")) return true;
  // Fallback on extension when the mime is generic/absent (octet-stream, missing).
  const ext = (fileName || "").toLowerCase().split(".").pop() ?? "";
  return ["txt", "csv", "tsv", "json", "md", "markdown", "log", "xml", "yaml", "yml"].includes(ext);
}

const MAX_DOC_CHARS = 20_000; // ~5k tokens: enough for a statement/CSV, bounded so a huge log can't blow the context.

/** Decode textual document bytes to a UTF-8 string, stripping a BOM and capping length with a visible
 * marker (so the model knows it's partial and can say so, mirroring truncateForModel in agent.ts).
 * Exported for tests. */
export function decodeTextDoc(bytes: Uint8Array): string {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^﻿/, "");
  if (text.length > MAX_DOC_CHARS) {
    text = text.slice(0, MAX_DOC_CHARS) + `\n\n[... document truncated at ${MAX_DOC_CHARS} characters — ask about a specific part for the rest ...]`;
  }
  return text;
}

/** Build the prompt messages for answering about a textual document. The caption is the user's question
 * (or a sensible default). Kept here so index wiring stays a one-liner + it's unit-testable. Exported. */
export function buildDocPrompt(text: string, caption: string, fileName?: string): string {
  const q = caption?.trim() || "Summarize this document and flag anything important (totals, dates, action items).";
  const name = fileName?.trim() ? ` (${fileName.trim()})` : "";
  return `The user sent a document${name}. Answer their question about it using ONLY its contents; if the answer isn't in the document, say so.\n\nQuestion: ${q}\n\n--- DOCUMENT ---\n${text}\n--- END DOCUMENT ---`;
}
