// m20 deploy-preflight: ONE command that runs every automated proof across the stack and prints a
// single GO / NO-GO. The whole system is live-proven but undeployed; the remaining steps are
// owner-gated (provision the Oracle VM, merge PR #1, fix gh-billing). This de-risks that effort — a
// GREEN preflight means the code is ready and the only unknowns left are the host + secrets.
//
//   npm run preflight
//
// Each sub-proof owns its own SKIP (e.g. e2e:live exits 0 with a SKIP note when anvil/keys absent),
// so preflight degrades gracefully offline: SKIP is not a failure. NO-GO only when a check hard-fails.
// preflight-1 covers Relay's own proofs; preflight-2 will fold in the cross-repo (DataFaucet + anvil).
import { spawnSync } from "child_process";

// A check: label + the npm script command to run. Order = cheapest/most-fundamental first. Commands
// are static, trusted strings (no interpolation), so shell:true is safe here and portable (npm
// resolves to npm.cmd on Windows only via a shell).
const CHECKS = [
  { label: "unit tests        (npm test)",           cmd: "npm test" },
  { label: "live e2e          (npm run e2e:live)",   cmd: "npm run e2e:live" },
  { label: "fault drills      (npm run e2e:faults)", cmd: "npm run e2e:faults" },
  { label: "operability       (npm run status)",     cmd: "npm run status" },
];

// Classify a finished run: SKIP if it exited 0 AND its output announced a skip; else pass/fail on code.
function classify(r) {
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === 0 && /\bSKIP\b/.test(out)) return "SKIP";
  return r.status === 0 ? "PASS" : "FAIL";
}

console.log("Relay deploy preflight\n======================");

const results = [];
for (const c of CHECKS) {
  process.stdout.write(`… ${c.label}\r`);
  const r = spawnSync(c.cmd, { cwd: process.cwd(), encoding: "utf8", timeout: 300000, shell: true });
  const verdict = classify(r);
  results.push({ ...c, verdict });
  const mark = verdict === "PASS" ? "✅" : verdict === "SKIP" ? "⏭️ " : "❌";
  console.log(`${mark} ${c.label.padEnd(34)} ${verdict}`);
  if (verdict === "FAIL") {
    // Surface the tail of a failure so the operator sees why without re-running.
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n");
    console.log(tail.split("\n").map((l) => `      | ${l}`).join("\n"));
  }
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
