// Digest runner (m9 digest-2): run each member recipe of a digest through the agent and
// compose ONE labeled message. Reused by the /run <digest> handler + the scheduler (a
// scheduled digest fires this). Injectable (resolveRecipe/runAgent/now) so it's unit-tested
// with a mock agent + recipe lookup. A failed member becomes a "(couldn't fetch)" line —
// one bad source never sinks the whole digest.

import type { LLMClient, LLMMessage } from "./llm.js";
import type { Digest } from "./lib/digests.js";
import { mapPool } from "./lib/pool.js";

// Cap on how many member agents run at once (DEV-0140). Each member opens an anvil browser session;
// the self-hosted anvil has a bounded Chrome pool, so an unbounded fan-out (DEV-0139's Promise.all)
// could open one session PER member simultaneously and 429/exhaust it. Default 3, env-tunable.
const DIGEST_CONCURRENCY = Math.max(1, Number(process.env.RELAY_DIGEST_CONCURRENCY) || 3);

export interface DigestRunnerDeps {
  llm: LLMClient;
  // Resolve a member recipe name -> its task (null if the recipe was deleted since define).
  resolveRecipe: (chatId: number, name: string) => { task: string } | null;
  runAgent: (userText: string, deps: { llm: LLMClient }, history: LLMMessage[]) => Promise<{ reply: string; degraded?: boolean }>;
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
  // Run members CONCURRENTLY (DEV-0139) but BOUNDED (DEV-0140): each member is a seconds-long agent
  // (LLM+browser) call, so a sequential for..await made a 5-member digest take ~5x one member. A
  // plain Promise.all fixed that but could open one anvil session PER member at once and exhaust the
  // self-hosted Chrome pool; mapPool caps in-flight at DIGEST_CONCURRENCY. Each member's own
  // try/catch keeps one failure from sinking the others; mapPool preserves member order.
  const sections = await mapPool(members, DIGEST_CONCURRENCY, async (name) => {
    const rec = deps.resolveRecipe(digest.chatId, name);
    if (!rec) return `• ${name}: (no such recipe anymore)`;
    try {
      const res = await deps.runAgent(rec.task, { llm: deps.llm }, []);
      // A degraded reply (agent ran out of steps / produced no answer, DEV-0176) is NOT briefing
      // content — showing its failure text as this member's section would read as real data. Treat
      // it exactly like a thrown error: the "(couldn't fetch)" fallback line (DEV-0177).
      if (res.degraded) return `• ${name}: (couldn't fetch)`;
      const body = deps.formatReply(res.reply).trim();
      return `• ${name}: ${body}`;
    } catch {
      return `• ${name}: (couldn't fetch)`;
    }
  });
  const title = `📋 ${digest.name}`;
  return `${title}\n${sections.join("\n")}`;
}
