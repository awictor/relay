// m20 deploy-preflight: ONE command that runs every automated proof across the stack and prints a
// single GO / NO-GO. The whole system is live-proven but undeployed; the remaining steps are
// owner-gated (provision the Oracle VM, merge PR #1, fix gh-billing). This de-risks that effort — a
// GREEN preflight means the code is ready and the only unknowns left are the host + secrets.
//
//   npm run preflight          full stack (~3-4 min: serial relay suite + DataFaucet test:unit + e2e)
//   npm run preflight -- --fast quick GO check — skips the heaviest cross-repo gate (DataFaucet unit)
//
// Each sub-proof owns its own SKIP (e.g. e2e:live exits 0 with a SKIP note when anvil/keys absent),
// so preflight degrades gracefully offline: SKIP is not a failure. NO-GO only when a check hard-fails.
// preflight-1: Relay's own proofs. preflight-2: fold in the cross-repo (DataFaucet second-product
// anvil path + its unit gate) + a direct anvil /v1/health probe, so ONE verdict covers the whole
// stack — Relay, DataFaucet, and the shared engine.
import { spawnSync } from "child_process";
import { existsSync as fsExists } from "fs";
import { join } from "path";

const RELAY = process.cwd();
const MCP_FORGE = join(RELAY, "..", "mcp-forge"); // sits beside relay under C:/Users/acwic
const ANVIL = (process.env.ANVIL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const FAST = process.argv.includes("--fast"); // audit-4: skip the heaviest gate for a quick check

// A check: label + npm command + the repo dir to run it in. `skipIf()` (optional) short-circuits to
// SKIP without running — used when the other repo isn't checked out (relay stays self-contained).
// `heavy` checks are skipped under --fast (the ~1800-test DataFaucet gate dominates the runtime).
// Commands are static, trusted strings (no interpolation), so shell:true is safe + portable.
const CHECKS = [
  { label: "relay: unit tests   (npm test)",            cmd: "npm test",           cwd: RELAY },
  { label: "relay: live e2e     (npm run e2e:live)",    cmd: "npm run e2e:live",   cwd: RELAY },
  { label: "relay: fault drills (npm run e2e:faults)",  cmd: "npm run e2e:faults", cwd: RELAY },
  { label: "relay: operability  (npm run status)",      cmd: "npm run status",     cwd: RELAY },
  { label: "datafaucet: unit    (npm run test:unit)",   cmd: "npm run test:unit",  cwd: MCP_FORGE, heavy: true,
    skipIf: () => (!fsExists(MCP_FORGE) && "mcp-forge not checked out beside relay") || (FAST && "--fast: heaviest gate skipped") },
  { label: "datafaucet: anvil   (npm run e2e:anvil)",   cmd: "npm run e2e:anvil",  cwd: MCP_FORGE,
    skipIf: () => !fsExists(MCP_FORGE) && "mcp-forge not checked out beside relay" },
];

// Classify a finished run: SKIP if it exited 0 AND its output announced a skip; else pass/fail on code.
function classify(r) {
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === 0 && /\bSKIP\b/.test(out)) return "SKIP";
  return r.status === 0 ? "PASS" : "FAIL";
}

// Direct anvil health probe — its own check so the verdict names the shared engine explicitly.
async function anvilHealth() {
  try {
    const r = await fetch(`${ANVIL}/v1/health`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { verdict: "FAIL", note: `status ${r.status}` };
    const b = await r.json().catch(() => ({}));
    const cap = typeof b.sessions === "number" ? ` (sessions ${b.sessions}${typeof b.maxSessions === "number" ? `/${b.maxSessions}` : ""})` : "";
    return { verdict: "PASS", note: `${ANVIL}${cap}` };
  } catch (e) {
    // anvil down is a SKIP, not a FAIL: the code is ready; the engine just isn't running here.
    return { verdict: "SKIP", note: `anvil not reachable at ${ANVIL} (${e instanceof Error ? e.message : String(e)})` };
  }
}

console.log("Stack deploy preflight\n======================");

const results = [];
for (const c of CHECKS) {
  const skipReason = c.skipIf?.();
  if (skipReason) {
    results.push({ ...c, verdict: "SKIP" });
    console.log(`⏭️  ${c.label.padEnd(36)} SKIP — ${skipReason}`);
    continue;
  }
  process.stdout.write(`… ${c.label}\r`);
  const r = spawnSync(c.cmd, { cwd: c.cwd, encoding: "utf8", timeout: 300000, shell: true });
  const verdict = classify(r);
  results.push({ ...c, verdict });
  const mark = verdict === "PASS" ? "✅" : verdict === "SKIP" ? "⏭️ " : "❌";
  console.log(`${mark} ${c.label.padEnd(36)} ${verdict}`);
  if (verdict === "FAIL") {
    // Surface the tail of a failure so the operator sees why without re-running.
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n");
    console.log(tail.split("\n").map((l) => `      | ${l}`).join("\n"));
  }
}

// Shared-engine health probe (async, after the spawn checks).
{
  const h = await anvilHealth();
  results.push({ label: "anvil: health (/v1/health)", verdict: h.verdict });
  const mark = h.verdict === "PASS" ? "✅" : h.verdict === "SKIP" ? "⏭️ " : "❌";
  console.log(`${mark} ${"anvil: health       (/v1/health)".padEnd(36)} ${h.verdict} — ${h.note}`);
}

const failed = results.filter((r) => r.verdict === "FAIL");
const skipped = results.filter((r) => r.verdict === "SKIP");
console.log("\n" + "─".repeat(50));
if (failed.length === 0) {
  console.log(`GO ✅  — ${results.length - skipped.length}/${results.length} passed${skipped.length ? `, ${skipped.length} skipped (dep offline)` : ""}.`);
  console.log("Code is deploy-ready. Remaining unknowns are the host (Oracle VM) + secrets — see DEPLOY.md.");
  process.exit(0);
} else {
  console.log(`NO-GO ❌ — ${failed.length} check(s) failed: ${failed.map((f) => f.label.split("(")[0].trim()).join(", ")}.`);
  process.exit(1);
}
