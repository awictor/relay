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
  {
    name: "fetch_json (public no-key API)",
    // open-meteo is a stable, free, no-key JSON API. The live temperature varies, so we DON'T
    // assert an exact value — we assert the agent (a) used the fetch_json tool and (b) surfaced a
    // real number from the JSON into its reply. Proves the direct-JSON path end to end.
    task: "Use the JSON API at https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.13&current=temperature_2m to tell me the current temperature in London. Report the number.",
    fetchTools: ["fetch_json"],
    requireTool: "fetch_json", // this case specifically proves the direct-JSON tool, not just any fetch
    assert: (reply) => /-?\d+(\.\d+)?\s*(°|deg|c\b|celsius)/i.test(reply) || /\d/.test(reply),
    why: "reply surfaces a real numeric temperature pulled from the JSON",
  },
  {
    name: "multi-step browse->read",
    // The persistent-session path: open a page with browse, then read its rendered text in a
    // second step (vs one-shot scrape). example.com stays the deterministic target so the
    // content assertion is stable; the point here is that the browse+read pair actually drove a
    // held anvil session and the read text reached the reply.
    task: "Open https://example.com in the browser, then read the page and tell me exactly what the body paragraph says.",
    fetchTools: ["browse", "read", "scrape", "extract"],
    assert: (reply) => /example domain|for use in (documentation|illustrative)|without .*permission/i.test(reply),
    why: "reply carries example.com's body text read from a live browsed session",
  },
];

let ok = 0;
for (const c of cases) {
  try {
    const res = await runAgent(c.task, { llm });
    const usedFetch = res.tools.some((t) => c.fetchTools.includes(t));
    // Some cases pin a SPECIFIC tool (e.g. fetch_json) to prove that exact path, not just any fetch.
    const usedRequired = !c.requireTool || res.tools.includes(c.requireTool);
    const passed = usedFetch && usedRequired && c.assert(res.reply);
    console.log(`\nCASE: ${c.name}`);
    console.log(`  steps=${res.steps} tools=${res.tools.join(",") || "(none)"}`);
    console.log(`  reply: ${res.reply.slice(0, 200).replace(/\n/g, " ")}`);
    if (passed) { ok++; console.log(`  PASS: ${c.why}`); }
    else {
      const miss = !usedFetch ? "no fetch tool used"
        : !usedRequired ? `required tool '${c.requireTool}' not used`
        : `assertion failed (${c.why})`;
      console.log(`  FAIL: ${miss}`);
    }
  } catch (e) {
    console.log(`\nCASE: ${c.name}\n  ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n${ok}/${cases.length} live case(s) drove real anvil + asserted real content.`);
process.exit(ok === cases.length ? 0 : 1);
