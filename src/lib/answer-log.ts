// Answer history (answer-history-recall): Relay remembers facts the USER tells it (notes) and the
// single last answer (last-result), but not the answers it has GIVEN over time — so "what was that
// sushi place you found me last week?" / "resend Tuesday's report" fall flat. This is a small capped
// per-chat log of past answers (the user's task + Relay's reply), searchable by keyword. Atomic +
// corrupt-safe JSON via safe-store, free-infra, keyed by chatId. Mirrors NotesStore/ProfileStore.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

export interface LoggedAnswer {
  task: string;   // what the user asked (trimmed)
  reply: string;  // Relay's answer (trimmed; capped so the log file stays small)
  at: number;     // epoch ms, for "last week"/"Tuesday" ordering + recency
}
interface ChatLog { chatId: number; answers: LoggedAnswer[] }

const MAX_ANSWERS_PER_CHAT = 100; // oldest-first drop when over
const MAX_REPLY_LEN = 2000;       // keep the stored reply bounded (drilldown still uses last-result)

/** True if the WHOLE message asks to recall a PAST answer Relay produced ("what was that X you found",
 * "what did you tell me about Y", "resend the Z", "what did you find on W"). Distinct from the notes
 * recall ("what do you know about ME") — this is about answers GIVEN, not facts stored. */
export function isAnswerRecall(text: string): boolean {
  const t = text.trim();
  // "what/which [was/were/did] ... <recall verb>" — allow words between (which RESTAURANT did you...).
  return /^\s*(?:what|which)\b.*\b(?:was|were|did|have)\b.*\byou\b.*\b(?:find|found|tell|told|say|said|show|showed|send|sent|get|got|recommend(?:ed)?|suggest(?:ed)?)\b/i.test(t)
    || /^\s*(?:what|which)\s+(?:was|were)\s+(?:that|the)\b.*\byou\b.*\b(?:find|found|recommend(?:ed)?|suggest(?:ed)?|show(?:ed)?|got|get)\b/i.test(t)
    || /^\s*(?:resend|re-send|send (?:me )?again|show (?:me )?again|remind me (?:of|what) )\b/i.test(t);
}

/** Extract the KEYWORDS from a recall request to search past answers — drop the recall scaffolding
 * ("what was that ... you found", "resend the") + stopwords, keep the content words ("sushi place",
 * "flights", "Tuesday report"). Returns lowercased tokens (>=3 chars, or any non-stopword). */
const RECALL_STOP = new Set([
  "what","which","was","were","did","have","that","the","you","me","again","of","about","on","for","my",
  "find","found","tell","told","say","said","show","showed","send","sent","resend","re","get","got",
  "recommend","recommended","suggest","suggested","remind","a","an","to","i","asked","your","last","one",
]);
export function recallKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !RECALL_STOP.has(w));
}

export class AnswerLog {
  private file: string;
  private items: ChatLog[] = [];
  constructor(opts: { file: string }) { this.file = opts.file; this.load(); }

  private load(): void {
    const obj = readJsonSafe<{ items?: ChatLog[] }>(this.file);
    if (obj && Array.isArray(obj.items)) {
      this.items = obj.items.filter((c) => c && typeof c.chatId === "number" && Array.isArray(c.answers));
    }
  }
  private persist(): void { atomicWriteJson(this.file, { v: 1, items: this.items }); }

  private forChat(chatId: number): ChatLog {
    let c = this.items.find((x) => x.chatId === chatId);
    if (!c) { c = { chatId, answers: [] }; this.items.push(c); }
    return c;
  }

  /** Record an answer Relay gave. Trims + caps the reply; drops the oldest when over the per-chat cap. */
  record(chatId: number, task: string, reply: string, at: number): void {
    const t = task.trim(), r = reply.trim();
    if (!t || !r) return;
    const c = this.forChat(chatId);
    c.answers.push({ task: t.slice(0, 300), reply: r.slice(0, MAX_REPLY_LEN), at });
    if (c.answers.length > MAX_ANSWERS_PER_CHAT) c.answers.splice(0, c.answers.length - MAX_ANSWERS_PER_CHAT);
    this.persist();
  }

  /** Search a chat's past answers by keyword relevance, newest-first among equal scores. An answer
   * scores by how many query keywords appear (whole-word) in its task OR reply. Empty query -> the most
   * recent answers. Returns up to `limit` matches (best + newest first), or [] if none. */
  search(chatId: number, keywords: string[], limit = 3): LoggedAnswer[] {
    const answers = this.items.find((x) => x.chatId === chatId)?.answers ?? [];
    if (!answers.length) return [];
    if (!keywords.length) return [...answers].sort((a, b) => b.at - a.at).slice(0, limit);
    const scored = answers.map((a) => {
      const hay = ` ${a.task.toLowerCase()} ${a.reply.toLowerCase()} `.replace(/[^\p{L}\p{N}\s]/gu, " ");
      const words = new Set(hay.split(/\s+/));
      const score = keywords.filter((k) => words.has(k)).length;
      return { a, score };
    }).filter((x) => x.score > 0);
    if (!scored.length) return [];
    scored.sort((x, y) => y.score - x.score || y.a.at - x.a.at); // best match, then newest
    return scored.slice(0, limit).map((x) => x.a);
  }

  size(): number { return this.items.reduce((n, c) => n + c.answers.length, 0); }
}
