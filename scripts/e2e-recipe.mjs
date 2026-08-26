// Live e2e (m7 recipe-3): the full teach-once + schedule loop. Save a recipe, schedule it
// ~1.5s out, let the REAL runner's interval fire it, assert the (stubbed) agent ran the
// recipe's task and the reply went out unprompted. Offline (agent+send stubbed) but real
// RecipeStore + ScheduleStore + runner + timers. Run: npx tsx scripts/e2e-recipe.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { RecipeStore, parseRecipeCommand } = await import("../src/lib/recipes.ts");
const { ScheduleStore, parseScheduleFor } = await import("../src/lib/schedule.ts");
const { makeScheduleRunner } = await import("../src/schedule-runner.ts");

const dir = mkdtempSync(join(tmpdir(), "relay-recipe-e2e-"));
const recipes = new RecipeStore({ file: join(dir, "r.json") });
const schedules = new ScheduleStore({ file: join(dir, "s.json") });

// 1) user saves a recipe
const p = parseRecipeCommand("save btc: check the price of bitcoin");
const rec = recipes.add(4242, p, Date.now());
console.log(`saved recipe "${rec.name}" -> "${rec.task}"`);

// 2) user schedules it ~1.5s out (parse timing, attach the recipe's task)
const sp = parseScheduleFor("in 1 min", rec.task, Date.now());
schedules.add(4242, { ...sp, dueMs: Date.now() + 1500 }, Date.now());
console.log("scheduled it ~1.5s out");

// 3) real runner fires it
const sent = [];
let agentTask = null;
const runner = makeScheduleRunner({
  store: schedules, llm: {},
  runAgent: async (task) => { agentTask = task; return { reply: `bitcoin is $65k (${task})` }; },
  send: async (chatId, text) => { sent.push({ chatId, text }); },
  formatReply: (t) => t, now: () => Date.now(), periodMs: 300, log: () => {},
});
runner.start();
const deadline = Date.now() + 4000;
while (Date.now() < deadline && sent.length === 0) await new Promise((r) => setTimeout(r, 100));
runner.stop();

const ok = sent.length === 1 && agentTask === "check the price of bitcoin"
  && sent[0].chatId === 4242 && /bitcoin/.test(sent[0].text) && schedules.list(4242).length === 0;
rmSync(dir, { recursive: true, force: true });

if (ok) { console.log(`E2E PASS: saved recipe ran on schedule -> chat ${sent[0].chatId}: ${JSON.stringify(sent[0].text)}`); process.exit(0); }
console.error(`E2E FAIL: sent=${sent.length} agentTask=${agentTask} remaining=${schedules.list(4242).length}`);
process.exit(1);
