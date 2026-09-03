// Digest runner (m9 digest-2): run each member recipe of a digest through the agent and
// compose ONE labeled message. Reused by the /run <digest> handler + the scheduler (a
// scheduled digest fires this). Injectable (resolveRecipe/runAgent/now) so it's unit-tested
// with a mock agent + recipe lookup. A failed member becomes a "(couldn't fetch)" line —
// one bad source never sinks the whole digest.

import type { LLMClient, LLMMessage } from "./llm.js";
import type { Digest } from "./lib/digests.js";
import { mapPool } from "./lib/pool.js";
import { hasSlots, isChain } from "./lib/recipes.js";
import type { AgentEnv } from "./chain-runner.js";

// Cap on how many member agents run at once (DEV-0140). Each member opens an anvil browser session;
// the self-hosted anvil has a bounded Chrome pool, so an unbounded fan-out (DEV-0139's Promise.all)
// could open one session PER member simultaneously and 429/exhaust it. Default 3, env-tunable.
const DIGEST_CONCURRENCY = Math.max(1, Number(process.env.RELAY_DIGEST_CONCURRENCY) || 3);

export interface DigestRunnerDeps {
  llm: LLMClient;
  // Resolve a member recipe name -> its task (null if the recipe was deleted since define).
  resolveRecipe: (chatId: number, name: string) => { task: string } | null;
  runAgent: (userText: string, deps: { llm: LLMClient; context?: string } & AgentEnv, history: LLMMessage[]) => Promise<{ reply: string; degraded?: boolean }>;
  // Clock + units for the proactive run (proactive-runs-datetime-units-blind): a digest member reasons
  // from the real date + the user's units. Optional.
  agentEnv?: (chatId: number) => AgentEnv;
  // A member recipe whose task is a ">>" chain must run as a sequential workflow, not as one literal
  // agent task (digest-chain-member-literal) — same as the inbound /run + scheduled-recipe paths. When
  // absent, a chain member falls back to runAgent (prior behavior). Returns the chain's final output.
  runChain?: (chatId: number, task: string) => Promise<string>;
  formatReply: (text: string) => string;
  maxMembers?: number; // safety bound on how many recipes one digest runs (default 10)
  // Per-user profile context (product-loop) so a scheduled digest resolves the user's location.
  contextFor?: (chatId: number) => string;
}

/**
 * Run a digest: execute each member recipe, compose a single message with a section per
 * member. Returns the composed text. Never throws on a member failure — that member gets a
 * fallback line. An unknown recipe (deleted after define) is noted, not fatal.
 */
export async function runDigest(digest: Digest, deps: DigestRunnerDeps): Promise<string | null> {
  const cap = deps.maxMembers ?? 10;
  const members = digest.members.slice(0, cap);
  // A digest whose recipes were ALL deleted (or that never had any) has no real content — return null so
  // a SCHEDULED fire stays silent instead of pinging a contentless "📋 name" on cadence, and the inbound
  // /run path shows "empty or gone" (empty-digest-fires-noise). Guarded again after building sections.
  if (members.length === 0) return null;
  // Run members CONCURRENTLY (DEV-0139) but BOUNDED (DEV-0140): each member is a seconds-long agent
  // (LLM+browser) call, so a sequential for..await made a 5-member digest take ~5x one member. A
  // plain Promise.all fixed that but could open one anvil session PER member at once and exhaust the
  // self-hosted Chrome pool; mapPool caps in-flight at DIGEST_CONCURRENCY. Each member's own
  // try/catch keeps one failure from sinking the others; mapPool preserves member order.
  // Each section carries a `real` flag: true only when a member produced actual content. A section that
  // is a "(no such recipe anymore)" placeholder is NOT real — if EVERY member is gone, the whole digest
  // is dead and should stay silent (empty-digest-fires-noise), not fire a briefing of removal notices.
  const built = await mapPool(members, DIGEST_CONCURRENCY, async (name): Promise<{ line: string; real: boolean }> => {
    const rec = deps.resolveRecipe(digest.chatId, name);
    if (!rec) return { line: `• ${name}: (no such recipe anymore)`, real: false };
    // A slotted recipe ("track price of {item}") has no per-fire value inside a digest, so running
    // it would hand the literal "{item}" to the agent and silently poison the briefing with an
    // off-topic/garbage section (the /run + schedule paths already refuse this). Skip it with a clear
    // note instead so the composed briefing stays trustworthy.
    if (hasSlots(rec.task)) return { line: `• ${name}: (skipped — needs a value; can't run in a digest)`, real: false };
    try {
      // A chained recipe ("a >> b") is a sequential workflow, not one task — run it via runChain so the
      // briefing shows the chain's final output, not a confused literal-"a >> b" agent run
      // (digest-chain-member-literal). Falls back to runAgent when runChain isn't wired.
      if (isChain(rec.task) && deps.runChain) {
        const out = (await deps.runChain(digest.chatId, rec.task)).trim();
        return out ? { line: `• ${name}: ${out}`, real: true } : { line: `• ${name}: (couldn't fetch)`, real: false };
      }
      const res = await deps.runAgent(rec.task, { llm: deps.llm, context: deps.contextFor?.(digest.chatId) || undefined, ...deps.agentEnv?.(digest.chatId) }, []);
      // A degraded reply (agent ran out of steps / produced no answer, DEV-0176) is NOT briefing
      // content — showing its failure text as this member's section would read as real data. Treat
      // it exactly like a thrown error: the "(couldn't fetch)" fallback line (DEV-0177).
      if (res.degraded) return { line: `• ${name}: (couldn't fetch)`, real: false };
      const body = deps.formatReply(res.reply).trim();
      return { line: `• ${name}: ${body}`, real: true };
    } catch {
      return { line: `• ${name}: (couldn't fetch)`, real: false };
    }
  });
  // If NO member produced real content — every recipe was deleted (all "(no such recipe anymore)") —
  // the digest is dead; return null so a scheduled fire stays silent + /run says "empty or gone" instead
  // of sending a briefing that's nothing but removal notices (empty-digest-fires-noise). A digest with at
  // least one real section (others transiently "(couldn't fetch)") still sends — that's a real briefing.
  if (!built.some((b) => b.real)) return null;
  const title = `📋 ${digest.name}`;
  return `${title}\n${built.map((b) => b.line).join("\n")}`;
}
