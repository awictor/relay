// Live e2e (m10 alert-3): watch-and-notify across changing values. Real AlertStore +
// alert runner. Drive a value that changes then stabilizes; assert: first check notifies
// (baseline), a changed value notifies, an unchanged value is SILENT. Offline (agent stubbed).
// Run: npx tsx scripts/e2e-alert.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AlertStore, parseAlertCommand } = await import("../src/lib/alerts.ts");
const { checkAlert } = await import("../src/alert-runner.ts");

const dir = mkdtempSync(join(tmpdir(), "relay-alert-e2e-"));
const alerts = new AlertStore({ file: join(dir, "a.json") });
alerts.add(4242, parseAlertCommand("watch btc: price of bitcoin"), Date.now());

// Scripted "agent" values across successive checks: baseline, changed, same, same.
const values = ["$65,000", "$67,000", "$67,000"];
let i = 0;
const deps = {
  llm: {},
  runAgent: async () => ({ reply: values[Math.min(i, values.length - 1)] }),
  formatReply: (t) => t,
  setLast: (c, n, v) => alerts.setLast(c, n, v),
};

const notifies = [];
for (i = 0; i < values.length; i++) {
  const a = alerts.get(4242, "btc");
  const r = await checkAlert(a, deps);
  if (r.notify) notifies.push({ i, msg: r.message });
}
rmSync(dir, { recursive: true, force: true });

// Expect: check0 baseline notify ($65k), check1 changed notify ($67k), check2 unchanged silent.
const ok = notifies.length === 2
  && /watching/.test(notifies[0].msg) && /65,000/.test(notifies[0].msg)
  && /changed/.test(notifies[1].msg) && /67,000/.test(notifies[1].msg);

if (ok) {
  console.log("E2E PASS: baseline + change notified, unchanged stayed silent");
  console.log(notifies.map((n) => `  check${n.i}: ${n.msg.replace(/\n/g, " ")}`).join("\n"));
  process.exit(0);
}
console.error(`E2E FAIL: notifies=${notifies.length}\n${JSON.stringify(notifies, null, 2)}`);
process.exit(1);
