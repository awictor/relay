// Live e2e of the proactive loop (m4 sched-4): real ScheduleStore + real
// makeScheduleRunner, schedule a task ~1s out, let the runner's real interval fire it,
// assert it ran the (stubbed) agent + "sent" the reply unprompted + removed the once-task.
// Offline: agent + send are stubbed (no Gemini/Telegram/anvil needed) — this proves the
// STORE->RUNNER->SEND chain end to end with real timers. Run: npx tsx scripts/e2e-schedule.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ScheduleStore, parseSchedule } = await import("../src/lib/schedule.ts");
const { makeScheduleRunner } = await import("../src/schedule-runner.ts");

const dir = mkdtempSync(join(tmpdir(), "relay-sched-e2e-"));
const file = join(dir, "s.json");
const store = new ScheduleStore({ file });

const sent = [];
let agentRuns = 0;
const runner = makeScheduleRunner({
  store,
  llm: {},
  runAgent: async (task) => { agentRuns++; return { reply: `weather for ${task}` }; },
  send: async (chatId, text) => { sent.push({ chatId, text }); },
  formatReply: (t) => t,
  now: () => Date.now(),
  periodMs: 300,          // real interval, tight for the test
  log: () => {},
});

// User "texts" a reminder ~1s out, parsed the same way the handler does.
const p = parseSchedule("remind me to check the weather in 1 min", Date.now());
if (!p) { console.error("FAIL: parseSchedule returned null"); process.exit(1); }
// Override to ~1s so the test is fast (parse gives +1min; we just need a near-future due).
const rec = store.add(4242, { ...p, dueMs: Date.now() + 1000 }, Date.now());
console.log(`scheduled id=${rec.id} due in ~1s; runner tick 300ms`);

runner.start();

// Wait up to 4s for it to fire.
const deadline = Date.now() + 4000;
while (Date.now() < deadline && sent.length === 0) await new Promise((r) => setTimeout(r, 100));
runner.stop();

const ok = sent.length === 1 && agentRuns === 1 && store.list(4242).length === 0
  && sent[0].chatId === 4242 && /weather/.test(sent[0].text) && /Reminder/.test(sent[0].text);
rmSync(dir, { recursive: true, force: true });

if (ok) {
  console.log(`E2E PASS: reminder fired unprompted -> chat ${sent[0].chatId}: ${JSON.stringify(sent[0].text)}; once-task removed`);
  process.exit(0);
}
console.error(`E2E FAIL: sent=${sent.length} agentRuns=${agentRuns} remaining=${store.list(4242).length}`);
console.error(JSON.stringify(sent));
process.exit(1);
