// m16 ops-1: `relay status` — an offline operability CLI. An operator on the VM can ssh in and run
// `npm run status` to see, without reading logs or texting the bot: what's scheduled, saved,
// watched, and whether anvil is up. Reads only the DURABLE state files (the same paths the runtime
// writes, {v:1, items:[...]}) so it needs NO GEMINI/TELEGRAM key — the counts are file-based. Only
// the anvil probe touches the network. A missing/corrupt store reads as 0, never a crash.
import { readFileSync, existsSync } from "fs";

process.loadEnvFile?.(".env"); // optional: picks up ANVIL_BASE_URL / RELAY_*_FILE overrides if present

// Same env-defaulted paths as src/index.ts (kept in sync; ops-2 will factor these into a shared
// module so the CLI and runtime can't drift).
const STORES = [
  { label: "schedules", file: process.env.RELAY_SCHEDULE_FILE ?? "data/relay-schedules.json" },
  { label: "recipes",   file: process.env.RELAY_RECIPE_FILE   ?? "data/relay-recipes.json" },
  { label: "digests",   file: process.env.RELAY_DIGEST_FILE   ?? "data/relay-digests.json" },
  { label: "alerts",    file: process.env.RELAY_ALERT_FILE    ?? "data/relay-alerts.json" },
];

/** Safe read of a {v,items:[]} store file. Missing/corrupt -> [] (never throws). */
function readItems(file) {
  try {
    if (!existsSync(file)) return [];
    const obj = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(obj?.items) ? obj.items : [];
  } catch {
    return [];
  }
}

async function probeAnvil() {
  const base = (process.env.ANVIL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const started = Date.now();
  try {
    const r = await fetch(`${base}/v1/live`, { signal: AbortSignal.timeout(4000) });
    return { base, up: r.ok, status: r.status, ms: Date.now() - started };
  } catch (e) {
    return { base, up: false, err: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  }
}

console.log("Relay status\n============");

let grand = 0;
const chats = new Set();
for (const s of STORES) {
  const items = readItems(s.file);
  grand += items.length;
  for (const it of items) if (typeof it?.chatId === "number") chats.add(it.chatId);
  const present = existsSync(s.file) ? "" : "  (no file yet)";
  console.log(`  ${s.label.padEnd(10)} ${String(items.length).padStart(4)}${present}`);
}
console.log(`  ${"—".repeat(15)}`);
console.log(`  ${"total".padEnd(10)} ${String(grand).padStart(4)} across ${chats.size} chat(s)`);

// Optional metrics snapshot (ops-3 will have the runtime persist this; read it best-effort now).
const metricsFile = process.env.RELAY_METRICS_FILE ?? "data/relay-metrics.json";
if (existsSync(metricsFile)) {
  try { console.log(`\nLast metrics: ${readFileSync(metricsFile, "utf8").trim().slice(0, 300)}`); }
  catch { /* ignore */ }
}

const anvil = await probeAnvil();
console.log(`\nanvil (${anvil.base}): ${anvil.up ? `UP (${anvil.status}, ${anvil.ms}ms)` : `DOWN — ${anvil.err ?? anvil.status} (${anvil.ms}ms)`}`);

// Key presence (names only — never values), so the operator knows the bot can actually run.
const keys = ["TELEGRAM_BOT_TOKEN", "GEMINI_API_KEY"].map((k) => `${k}=${process.env[k] ? "set" : "MISSING"}`);
console.log(`keys: ${keys.join("  ")}`);

process.exit(0); // status is informational — always exits 0
