// m16 ops-1: `relay status` — an offline operability CLI. An operator on the VM can ssh in and run
// `npm run status` to see, without reading logs or texting the bot: what's scheduled, saved,
// watched, and whether anvil is up. Reads only the DURABLE state files (the same paths the runtime
// writes, {v:1, items:[...]}) so it needs NO GEMINI/TELEGRAM key — the counts are file-based. Only
// the anvil probe touches the network. A missing/corrupt store reads as 0, never a crash.
import { readFileSync, existsSync } from "fs";
import { statePaths, readStoreItems } from "../src/lib/state-paths.ts";

process.loadEnvFile?.(".env"); // optional: picks up ANVIL_BASE_URL / RELAY_*_FILE overrides if present

// Paths resolved through the SAME shared module the runtime uses (ops-2) — the CLI can't drift from
// what index.ts writes.
const paths = statePaths();
const STORES = [
  { label: "schedules", file: paths.schedules },
  { label: "recipes",   file: paths.recipes },
  { label: "digests",   file: paths.digests },
  { label: "alerts",    file: paths.alerts },
];

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
  const items = readStoreItems(s.file);
  grand += items.length;
  for (const it of items) if (typeof it?.chatId === "number") chats.add(it.chatId);
  const present = existsSync(s.file) ? "" : "  (no file yet)";
  console.log(`  ${s.label.padEnd(10)} ${String(items.length).padStart(4)}${present}`);
}
console.log(`  ${"—".repeat(15)}`);
console.log(`  ${"total".padEnd(10)} ${String(grand).padStart(4)} across ${chats.size} chat(s)`);

// Optional metrics snapshot (ops-3 will have the runtime persist this; read it best-effort now).
const metricsFile = paths.metrics;
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
