// Digest runner (m9 digest-2): run each member recipe of a digest through the agent and
// compose ONE labeled message. Reused by the /run <digest> handler + the scheduler (a
// scheduled digest fires this). Injectable (resolveRecipe/runAgent/now) so it's unit-tested
// with a mock agent + recipe lookup. A failed member becomes a "(couldn't fetch)" line —
// one bad source never sinks the whole digest.

import type { LLMClient, LLMMessage } from "./llm.js";
import type { Digest } from "./lib/digests.js";

export interface DigestRunnerDeps {
  llm: LLMClient;
  // Resolve a member recipe name -> its task (null if the recipe was deleted since define).
  resolveRecipe: (chatId: number, name: string) => { task: string } | null;
  runAgent: (userText: string, deps: { llm: LLMClient }, history: LLMMessage[]) => Promise<{ reply: string }>;
  formatReply: (text: string) => string;
  maxMembers?: number; // safety bound on how many recipes one digest runs (default 10)
}

/**
 * Run a digest: execute each member recipe, compose a single message with a section per
 * member. Returns the composed text. Never throws on a member failure — that member gets a
 * fallback line. An unknown recipe (deleted after define) is noted, not fatal.
 */
export async function runDigest(digest: Digest, deps: DigestRunnerDeps): Promise<string> {
  const cap = deps.maxMembers ?? 10;
  const members = digest.members.slice(0, cap);
  // Run members CONCURRENTLY (DEV-0139): each member is a seconds-long agent (LLM+browser) call,
  // so a sequential for..await made a 5-member digest take ~5x one member. Promise.all fans them
  // out; each member's own try/catch keeps one failure from sinking the others (same isolation as
  // the sequential version + dispatchBatch, DEV-0037). Order is preserved by mapping members ->
  // indexed section strings, NOT by push-in-completion-order.
  const sections = await Promise.all(members.map(async (name) => {
    const rec = deps.resolveRecipe(digest.chatId, name);
    if (!rec) return `• ${name}: (no such recipe anymore)`;
    try {
      const res = await deps.runAgent(rec.task, { llm: deps.llm }, []);
      const body = deps.formatReply(res.reply).trim();
      return `• ${name}: ${body}`;
    } catch {
      return `• ${name}: (couldn't fetch)`;
    }
  }));
  const title = `📋 ${digest.name}`;
  return `${title}\n${sections.join("\n")}`;
}
