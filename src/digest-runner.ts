// Digest runner (m9 digest-2): run each member recipe of a digest through the agent and
// compose ONE labeled message. Reused by the /run <digest> handler + the scheduler (a
// scheduled digest fires this). Injectable (resolveRecipe/runAgent/now) so it's unit-tested
// with a mock agent + recipe lookup. A failed member becomes a "(couldn't fetch)" line —
// one bad source never sinks the whole digest.

import type { LLMClient, LLMMessage } from "./llm.js";
import type { Digest } from "./lib/digests.js";
import { mapPool } from "./lib/pool.js";
import { hasSlots, isChain } from "./lib/recipes.js";
import { looksLikeErrorReply } from "./lib/alerts.js";
import { isReadingRecapMember } from "./lib/readlater.js";
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
  // absent, a chain member falls back to runAgent (prior behavior). Returns the chain's final output —
  // as a structured result so a chain that STOPPED EARLY (a failed/degraded step, or an unmet if-gate)
  // is flagged rather than shown as if it completed (chain-partial-nonrun-paths). A bare string is still
  // accepted (legacy / when step counts aren't available).
  runChain?: (chatId: number, task: string) => Promise<string | { final: string; stoppedEarly?: boolean; stepsDone?: number; stepsTotal?: number }>;
  formatReply: (text: string) => string;
  // Reading-list recap (saved-page-digest-integration): a reserved member ("reading list"/"saved") folds
  // the user's read-it-later saves into the briefing. Returns the recap text, or null when nothing's saved
  // (treated as an empty member, not a failure). No agent/anvil — pure store read. Optional; absent -> a
  // recap member falls through to resolveRecipe (and reads as "no such recipe" if there's no such recipe).
  savedRecap?: (chatId: number) => string | null;
  maxMembers?: number; // safety bound on how many recipes one digest runs (default 10)
  // Smart ordering (digest-smart-ordering): given a real member's output, record its value + report
  // whether it CHANGED materially since the last run (a moved price, a new top story). When wired, the
  // briefing floats changed members to the top with a ✦ marker so a daily reader sees what's different
  // first. Optional; absent -> members stay in definition order (prior behavior). The store lives in the
  // caller (index) so it's persisted + testable. Called once per REAL member, in member order.
  memberChanged?: (chatId: number, digestName: string, member: string, body: string) => boolean;
  // digest-skip-unchanged: has this digest been run before (does the change-store hold any prior value for
  // it)? Lets the runner tell a genuine "nothing changed" from a first run — the FIRST scheduled fire must
  // still send (seed the baseline), only later unchanged fires go quiet. Called BEFORE memberChanged writes.
  digestSeenBefore?: (chatId: number, digestName: string) => boolean;
  // Per-user profile context (product-loop) so a scheduled digest resolves the user's location.
  contextFor?: (chatId: number) => string;
}

// The outcome of a digest run. Three cases the SCHEDULER must tell apart (digest-all-failed-bypasses-gate):
//  - string          -> real briefing content, send it.
//  - null            -> structurally dead (every member deleted / none defined): stay silent + stop firing.
//  - { allFailed }   -> every member failed to load THIS run (transient network/site blip). Distinct from a
//    dead digest: the automation is fine, the sources just didn't answer. The scheduler streaks this like a
//    watch soft-fail (silent per fire, escalation receipt after N) instead of pinging the reassuring `note`
//    every single cadence with no way to notice a source that's now permanently broken. The inbound /run +
//    callback paths still SHOW `note` (the user asked right now, so an honest "couldn't build it" is right).
export interface DigestAllFailed { allFailed: true; note: string; }
// quiet-unchanged (digest-skip-unchanged): the digest built fine but NOTHING changed since last run + the
// digest is set "only if changed". A SCHEDULED fire stays silent (skip the morning buzz); the inbound /run
// path shows `text` anyway (the user asked right now). `text` is the full composed briefing.
export interface DigestQuietNoChange { quietNoChange: true; text: string; }
export type DigestOutcome = string | DigestAllFailed | DigestQuietNoChange | null;

/**
 * Run a digest: execute each member recipe, compose a single message with a section per
 * member. Returns the composed text. Never throws on a member failure — that member gets a
 * fallback line. An unknown recipe (deleted after define) is noted, not fatal.
 */
export async function runDigest(digest: Digest, deps: DigestRunnerDeps): Promise<DigestOutcome> {
  const cap = deps.maxMembers ?? 10;
  const members = digest.members.slice(0, cap);
  // A digest whose recipes were ALL deleted (or that never had any) has no real content — return null so
  // a SCHEDULED fire stays silent instead of pinging a contentless "📋 name" on cadence, and the inbound
  // /run path shows "empty or gone" (empty-digest-fires-noise). Guarded again after building sections.
  if (members.length === 0) return null;
  // digest-skip-unchanged: snapshot whether this digest ran before BEFORE the members write new values,
  // so the first-ever fire still sends (only a later all-unchanged fire goes quiet).
  const seenBefore = digest.quietUnchanged ? (deps.digestSeenBefore?.(digest.chatId, digest.name) ?? false) : false;
  // Run members CONCURRENTLY (DEV-0139) but BOUNDED (DEV-0140): each member is a seconds-long agent
  // (LLM+browser) call, so a sequential for..await made a 5-member digest take ~5x one member. A
  // plain Promise.all fixed that but could open one anvil session PER member at once and exhaust the
  // self-hosted Chrome pool; mapPool caps in-flight at DIGEST_CONCURRENCY. Each member's own
  // try/catch keeps one failure from sinking the others; mapPool preserves member order.
  // Each section carries a `real` flag: true only when a member produced actual content. A section that
  // is a "(no such recipe anymore)" placeholder is NOT real — if EVERY member is gone, the whole digest
  // is dead and should stay silent (empty-digest-fires-noise), not fire a briefing of removal notices.
  // Each section's status: "real" (produced content) | "gone" (recipe deleted / slotted-skip — a
  // STRUCTURAL, permanent dead end) | "failed" (transient — couldn't fetch this time / degraded). The
  // gone-vs-failed split is what lets an ALL-fail digest tell a transient outage ("couldn't build it
  // this time") apart from a truly-dead one (stay silent) — digest-all-fail-silent-noshow.
  const built = await mapPool(members, DIGEST_CONCURRENCY, async (name): Promise<{ line: string; status: "real" | "gone" | "failed"; changed?: boolean }> => {
    // Reserved reading-list recap member (saved-page-digest-integration): fold recent saves in, no agent.
    // Nothing saved -> "gone" (an empty member, like a deleted recipe) so it doesn't count as content or a
    // transient failure — a digest of ONLY an empty reading list stays silent, same as an all-deleted one.
    if (deps.savedRecap && isReadingRecapMember(name)) {
      const recap = deps.savedRecap(digest.chatId);
      return recap ? { line: `• ${name}:\n${recap}`, status: "real" } : { line: `• ${name}: (nothing saved yet)`, status: "gone" };
    }
    const rec = deps.resolveRecipe(digest.chatId, name);
    if (!rec) return { line: `• ${name}: (no such recipe anymore)`, status: "gone" };
    // A slotted recipe ("track price of {item}") has no per-fire value inside a digest, so running
    // it would hand the literal "{item}" to the agent and silently poison the briefing with an
    // off-topic/garbage section (the /run + schedule paths already refuse this). Skip it with a clear
    // note instead so the composed briefing stays trustworthy.
    if (hasSlots(rec.task)) return { line: `• ${name}: (skipped — needs a value; can't run in a digest)`, status: "gone" };
    try {
      // A chained recipe ("a >> b") is a sequential workflow, not one task — run it via runChain so the
      // briefing shows the chain's final output, not a confused literal-"a >> b" agent run
      // (digest-chain-member-literal). Falls back to runAgent when runChain isn't wired.
      if (isChain(rec.task) && deps.runChain) {
        const raw = await deps.runChain(digest.chatId, rec.task);
        const out = (typeof raw === "string" ? raw : raw.final).trim();
        const stoppedEarly = typeof raw === "string" ? false : !!raw.stoppedEarly;
        // A chain that STOPPED EARLY (a step failed/degraded, or an if-gate wasn't met) produced only a
        // PARTIAL result — showing it as a normal briefing section reads as if the whole workflow ran
        // (chain-partial-nonrun-paths). Flag it inline + count it as failed (so an all-partial digest
        // still triggers the honest "couldn't build it" notice rather than a silent half-answer).
        if (out && !looksLikeErrorReply(out) && stoppedEarly) {
          const steps = (typeof raw === "object" && raw.stepsDone && raw.stepsTotal) ? ` (partial — ${raw.stepsDone} of ${raw.stepsTotal} steps)` : " (partial)";
          return { line: `• ${name}:${steps} ${out}`, status: "failed" };
        }
        // An error-shaped chain output ("the page returned a 404") is a soft failure, not content
        // (digest-error-as-content) — demote it so it's not shown as a real section + counts as failed.
        if (out && !looksLikeErrorReply(out)) { const changed = deps.memberChanged?.(digest.chatId, digest.name, name, out) ?? false; return { line: `• ${name}: ${out}`, status: "real", changed }; }
        return { line: `• ${name}: (couldn't fetch)`, status: "failed" };
      }
      const res = await deps.runAgent(rec.task, { llm: deps.llm, context: deps.contextFor?.(digest.chatId) || undefined, ...deps.agentEnv?.(digest.chatId) }, []);
      // A degraded reply (agent ran out of steps / produced no answer, DEV-0176) is NOT briefing
      // content — showing its failure text as this member's section would read as real data. Treat
      // it exactly like a thrown error: the "(couldn't fetch)" fallback line (DEV-0177).
      if (res.degraded) return { line: `• ${name}: (couldn't fetch)`, status: "failed" };
      const body = deps.formatReply(res.reply).trim();
      // An error-SHAPED body the model didn't flag as degraded ("couldn't load", "404") must NOT be shown
      // as a real briefing section (digest-error-as-content) — it reads as fact and miscounts toward "real"
      // content so the all-failed notice never fires. Demote it like a degraded reply.
      if (!body || looksLikeErrorReply(body)) return { line: `• ${name}: (couldn't fetch)`, status: "failed" };
      const changed = deps.memberChanged?.(digest.chatId, digest.name, name, body) ?? false;
      return { line: `• ${name}: ${body}`, status: "real", changed };
    } catch {
      return { line: `• ${name}: (couldn't fetch)`, status: "failed" };
    }
  });
  if (!built.some((b) => b.status === "real")) {
    // No real content. Two very different reasons:
    //  - at least one member FAILED transiently -> the user's relied-upon briefing would otherwise
    //    silently no-show, indistinguishable from "no news" or a deleted digest. Send a short honest
    //    note so they know it's a temporary blip, not a dead automation (digest-all-fail-silent-noshow).
    //  - every member is GONE (deleted / slotted-skip) -> the digest is structurally dead; return null
    //    so a scheduled fire stays silent + /run says "empty or gone" (empty-digest-fires-noise).
    if (built.some((b) => b.status === "failed")) {
      // Signal all-failed as a distinct outcome (not a plain string): the scheduler streaks it like a
      // watch soft-fail so a digest whose sources are ALL down doesn't ping this reassuring "temporary
      // blip" note every morning forever with no escalation (digest-all-failed-bypasses-gate). /run +
      // callback show `note` verbatim — the user asked right now, so the honest "couldn't build it" is right.
      return { allFailed: true, note: `📋 ${digest.name}\nI couldn't put your briefing together this time — every source failed to load (likely a temporary network blip). I'll try again on the next run.` };
    }
    return null;
  }
  const title = `📋 ${digest.name}`;
  // digest-skip-unchanged: this digest is "only if changed", it has run before, and NO member moved this
  // time -> return quietNoChange so a SCHEDULED fire stays silent (no morning buzz), while /run still shows
  // the composed briefing. Only when change-detection is wired (else there's no change signal to trust).
  if (digest.quietUnchanged && deps.memberChanged && seenBefore && !built.some((b) => b.changed)) {
    return { quietNoChange: true, text: `${title}\n${built.map((b) => b.line).join("\n")}` };
  }
  // Smart ordering (digest-smart-ordering): when change-detection is wired, float members that CHANGED
  // materially since last run to the top with a ✦ marker, so a daily reader sees what's different first.
  // Stable within each group (preserves definition order among changed, and among unchanged). No-op when
  // nothing changed or memberChanged isn't wired -> identical to the prior definition-order briefing.
  if (deps.memberChanged && built.some((b) => b.changed)) {
    const mark = (b: typeof built[number]) => (b.changed ? `✦ ${b.line.replace(/^• /, "")}` : b.line);
    const changed = built.filter((b) => b.changed);
    const rest = built.filter((b) => !b.changed);
    const ordered = [...changed, ...rest];
    return `${title} (✦ = changed since last time)\n${ordered.map(mark).join("\n")}`;
  }
  return `${title}\n${built.map((b) => b.line).join("\n")}`;
}
