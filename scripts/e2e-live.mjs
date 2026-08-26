// m15 live-e2e: prove the REAL channel->agent->anvil->reply pipe against a live anvil, not just
// types. Unlike the other scripts/e2e-*.mjs, this is CI-SAFE: it SKIPS cleanly (exit 0) when anvil
// is down or GEMINI_API_KEY is absent, so it can run anywhere without failing an offline pipeline.
// When both are present it drives the real agent (Gemini + anvil) through canonical errands and
// ASSERTS real content in the reply — so the day the VM is provisioned, the deploy path is verified
// working, not merely green on tsc.
//
//   npm run e2e:live        (with .env filled + anvil on :3000)
//
// Each case is a real multi-step Gemini+anvil run (~30-60s). Bounded to a few LLM calls.
process.loadEnvFile(".env");

const { runAgent } = await import("../src/agent.ts");
const { GeminiClient } = await import("../src/llm.ts");
const { anvilLive } = await import("../src/anvil.ts");

// --- CI-safe skip gate: no anvil or no key => SKIP (exit 0), never a red pipeline. ---
function skip(reason) {
  console.log(`SKIP e2e:live — ${reason}. (offline CI unaffected)`);
  process.exit(0);
}
if (!process.env.GEMINI_API_KEY) skip("GEMINI_API_KEY not set");
if (!(await anvilLive())) skip("anvil not reachable on ANVIL_BASE_URL (" + (process.env.ANVIL_BASE_URL ?? "http://localhost:3000") + ")");

const llm = new GeminiClient();

// A live errand: the task, the fetch tools that count as "drove anvil", and a predicate on the
// reply that asserts REAL content came back (not a hallucinated or empty answer).
const cases = [
  {
    name: "scrape (deterministic page)",
    // example.com is a stable, tiny, unchanging page — its body text is a known constant, so the
    // assertion is deterministic across runs (no flaky live-content dependency).
    task: "Fetch the page at https://example.com and tell me the main heading and what the page says.",
    fetchTools: ["scrape", "browse", "extract", "fetch_json", "search"],
    assert: (reply) => /example domain/i.test(reply),
    why: "reply mentions 'Example Domain' (example.com's constant H1)",
  },
];

let ok = 0;
for (const c of cases) {
  try {
    const res = await runAgent(c.task, { llm });
    const usedFetch = res.tools.some((t) => c.fetchTools.includes(t));
    const passed = usedFetch && c.assert(res.reply);
    console.log(`\nCASE: ${c.name}`);
    console.log(`  steps=${res.steps} tools=${res.tools.join(",") || "(none)"}`);
    console.log(`  reply: ${res.reply.slice(0, 200).replace(/\n/g, " ")}`);
    if (passed) { ok++; console.log(`  PASS: ${c.why}`); }
    else console.log(`  FAIL: expected ${c.why}${usedFetch ? "" : " (and a fetch tool was used)"}`);
  } catch (e) {
    console.log(`\nCASE: ${c.name}\n  ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n${ok}/${cases.length} live case(s) drove real anvil + asserted real content.`);
process.exit(ok === cases.length ? 0 : 1);
