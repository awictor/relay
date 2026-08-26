// Live e2e (m9 digest-3): the full recipe->digest->schedule->one-message loop. Save 2
// recipes, define a digest of them, schedule it ~1.5s out, let the REAL runner fire it,
// assert ONE composed briefing (both members) goes out. Offline (agent+send stubbed) but
// real Recipe/Digest/Schedule stores + digest runner + scheduler + timers.
// Run: npx tsx scripts/e2e-digest.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { RecipeStore, parseRecipeCommand } = await import("../src/lib/recipes.ts");
const { DigestStore, parseDigestCommand } = await import("../src/lib/digests.ts");
const { ScheduleStore, parseScheduleFor } = await import("../src/lib/schedule.ts");
const { makeScheduleRunner } = await import("../src/schedule-runner.ts");
const { runDigest } = await import("../src/digest-runner.ts");

const dir = mkdtempSync(join(tmpdir(), "relay-digest-e2e-"));
const recipes = new RecipeStore({ file: join(dir, "r.json") });
const digests = new DigestStore({ file: join(dir, "d.json") });
const schedules = new ScheduleStore({ file: join(dir, "s.json") });

recipes.add(4242, parseRecipeCommand("save weather: get the weather"), Date.now());
recipes.add(4242, parseRecipeCommand("save btc: check the price of bitcoin"), Date.now());
const dg = digests.add(4242, parseDigestCommand("define digest morning: weather, btc"), Date.now());
console.log(`digest "${dg.name}" members=${dg.members.join(",")}`);

const digestRun = (chatId, name) => {
  const d = digests.get(chatId, name);
  if (!d) return Promise.resolve(null);
  return runDigest(d, { llm: {}, resolveRecipe: (c, n) => { const r = recipes.get(c, n); return r ? { task: r.task } : null; },
    runAgent: async (task) => ({ reply: `[${task}]` }), formatReply: (t) => t });
};

// schedule the digest ~1.5s out (marker task "digest:morning")
const sp = parseScheduleFor("in 1 min", `digest:${dg.name}`, Date.now());
schedules.add(4242, { ...sp, dueMs: Date.now() + 1500 }, Date.now());

const sent = [];
const runner = makeScheduleRunner({
  store: schedules, llm: {},
  runAgent: async (task) => ({ reply: `SHOULD-NOT-RUN:${task}` }), // digest path shouldn't hit this
  send: async (chatId, text) => { sent.push({ chatId, text }); },
  formatReply: (t) => t, now: () => Date.now(), periodMs: 300, log: () => {}, digestRun,
});
runner.start();
const deadline = Date.now() + 4000;
while (Date.now() < deadline && sent.length === 0) await new Promise((r) => setTimeout(r, 100));
runner.stop();

const t = sent[0]?.text ?? "";
const ok = sent.length === 1 && /📋 morning/.test(t) && /weather/.test(t) && /bitcoin/.test(t) && !/SHOULD-NOT-RUN/.test(t);
rmSync(dir, { recursive: true, force: true });

if (ok) { console.log(`E2E PASS: scheduled digest fired one composed briefing:\n${t}`); process.exit(0); }
console.error(`E2E FAIL: sent=${sent.length}\n${t}`); process.exit(1);
