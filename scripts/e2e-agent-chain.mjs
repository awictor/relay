// Manual live e2e: the REAL agent (Gemini + anvil browser), end to end. Not in CI —
// needs TELEGRAM/GEMINI keys + a running anvil. Proves the full no-URL-pasting flow:
// the agent picks a fetch tool, drives anvil against a real site, and replies from real
// data. Run with tsx (resolves the .ts imports):
//   npx tsx scripts/e2e-agent-chain.mjs   (with .env filled + anvil on :3000)
process.loadEnvFile(".env");

const { runAgent } = await import("../src/agent.ts");
const { GeminiClient } = await import("../src/llm.ts");
const { anvilLive } = await import("../src/anvil.ts");

if (!(await anvilLive())) { console.error("anvil not reachable — start it first"); process.exit(1); }
if (!process.env.GEMINI_API_KEY) { console.error("GEMINI_API_KEY not set"); process.exit(1); }

const llm = new GeminiClient();
// One case by default (each is a real multi-step Gemini+anvil run, ~30-60s). Add more
// locally if you want broader coverage.
const cases = [
  "Go to https://news.ycombinator.com/newest and list 3 story links you find there.",
];

let ok = 0;
for (const task of cases) {
  try {
    const res = await runAgent(task, { llm });
    const usedFetch = res.tools.some((t) => ["search", "scrape", "browse", "extract", "fetch_json"].includes(t));
    console.log(`\nTASK: ${task}\n  steps=${res.steps} tools=${res.tools.join(",")||"(none)"}\n  reply: ${res.reply.slice(0, 200).replace(/\n/g, " ")}`);
    if (usedFetch && res.reply.length > 10) ok++;
    else console.log("  WARN: no fetch tool or empty reply");
  } catch (e) {
    console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`\n${ok}/${cases.length} cases drove a real fetch + replied.`);
process.exit(ok === cases.length ? 0 : 1);
