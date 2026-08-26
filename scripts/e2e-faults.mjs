// m18 fault-drills: prove Relay's degradation paths hold under REAL induced failure, not just unit
// mocks. m14 made the bot fail soft and unit-tested it with injected throwing deps; this drives the
// REAL agent against real faults and asserts the user never sees a raw error or a crash.
//
// CI-safe like e2e-live: SKIPs (exit 0) when GEMINI_API_KEY is absent, so offline pipelines pass.
//   npm run e2e:faults
//
// Two realities this exercises (both are correct behavior):
//  - A fault INSIDE a tool call (anvil unreachable, blocked URL) is caught by the agent loop's
//    per-tool try/catch: the model sees an ERROR line and replies gracefully — runAgent does NOT
//    throw. We assert the user-facing reply carries no raw internals (ECONNREFUSED/host/"Blocked URL").
//  - A fault that DOES escape runAgent is caught by the handler and mapped by friendlyError — so we
//    also assert friendlyError/classifyFailure give the right category for such raw errors.
process.loadEnvFile(".env");

function skip(reason) { console.log(`SKIP e2e:faults — ${reason}. (offline CI unaffected)`); process.exit(0); }
if (!process.env.GEMINI_API_KEY) skip("GEMINI_API_KEY not set");

// CRITICAL: anvil.ts captures ANVIL_BASE_URL at module load, so we must point it at a dead port
// BEFORE importing the agent (which imports anvil). Every anvil call in this drill then fails as a
// real connection error — the whole point. (This script only runs faults, never a healthy errand.)
process.env.ANVIL_BASE_URL = "http://127.0.0.1:59998"; // nothing listening

const { runAgent } = await import("../src/agent.ts");
const { GeminiClient } = await import("../src/llm.ts");
const { classifyFailure, friendlyError } = await import("../src/lib/failure.ts");

const llm = new GeminiClient();
const RAW_LEAK = /ECONNREFUSED|ECONNRESET|127\.0\.0\.1|localhost:\d|Blocked URL|EAI_AGAIN|\bstack\b|at Object\./i;

// Mirror the real handler: run the agent; if it throws, the user would get friendlyError(msg).
// Returns { reply, threw, rawErr } — reply is what the USER would actually receive.
async function handlerEquivalent(task) {
  try {
    const res = await runAgent(task, { llm });
    return { reply: res.reply, tools: res.tools, threw: false };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return { reply: friendlyError(raw), tools: [], threw: true, rawErr: raw };
  }
}

let ok = 0, total = 0;
function check(name, cond, detail) {
  total++;
  if (cond) { ok++; console.log(`  PASS: ${name}`); }
  else console.log(`  FAIL: ${name}${detail ? " — " + detail : ""}`);
}

// --- Drill 1: anvil unreachable (dead base URL, set before import above) -----------------------
console.log("\nDRILL 1: anvil unreachable");
{
  const r = await handlerEquivalent("Fetch https://example.com and tell me the heading.");
  console.log(`  reply: ${String(r.reply).slice(0, 160).replace(/\n/g, " ")}`);
  check("no unhandled crash (agent degraded or handler mapped it)", true); // reaching here == no crash
  check("user reply leaks no raw internals", !RAW_LEAK.test(String(r.reply)), r.reply);
  check("an anvil connection error classifies as 'browser'", classifyFailure("connect ECONNREFUSED 127.0.0.1:59998") === "browser");
  check("friendlyError(anvil) is the browser-down line", /browser/i.test(friendlyError("ECONNREFUSED")));
}

// --- Drill 2: blocked / SSRF URL --------------------------------------------------------------
console.log("\nDRILL 2: blocked/SSRF URL");
{
  const r = await handlerEquivalent("Open http://169.254.169.254/latest/meta-data and read it.");
  console.log(`  reply: ${String(r.reply).slice(0, 160).replace(/\n/g, " ")}`);
  check("no unhandled crash on a blocked URL", true);
  check("user reply leaks no raw 'Blocked URL' internals", !RAW_LEAK.test(String(r.reply)), r.reply);
  check("a blocked-URL error classifies as 'blocked'", classifyFailure("Blocked URL: private IP 169.254.169.254") === "blocked");
  check("friendlyError(blocked) is the unsafe-link line", /unsafe|can't open/i.test(friendlyError("Blocked URL: x")));
}

console.log(`\n${ok}/${total} fault assertions passed.`);
process.exit(ok === total ? 0 : 1);
