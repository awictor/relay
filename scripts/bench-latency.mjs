// m21 thesis-1: measure REAL end-to-end anvil latency for the canonical errands, so the no-vendor
// thesis rests on data, not claims. Drives the same src/anvil.ts client the product uses, over N
// runs, and reports p50/p95/avg per errand. CI-safe: SKIPs (exit 0) when anvil is unreachable.
//
//   npm run bench:latency            # default 10 runs
//   BENCH_RUNS=20 npm run bench:latency
//
// Errands measured (each = one full cycle the product actually performs):
//   session      create a session + release it (the fixed per-task overhead)
//   scrape       scrape(example.com) — create+navigate+read+release, one-shot
//   fetch_json   a raw JSON GET (open-meteo) — the no-browser fast path
//   browse+read  create -> navigate -> readCurrent -> release (multi-step path)
process.loadEnvFile?.(".env");

const anvil = await import("../src/anvil.ts");

const ANVIL = (process.env.ANVIL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
if (!(await anvil.anvilLive())) {
  console.log(`SKIP bench:latency — anvil not reachable at ${ANVIL}. (offline CI unaffected)`);
  process.exit(0);
}

const RUNS = Math.max(1, Number(process.env.BENCH_RUNS ?? 10));
const EXAMPLE = "https://example.com";
const JSON_API = "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.13&current=temperature_2m";

// now() without Date.now() (blocked in some sandboxes): performance.now() is monotonic ms.
const now = () => performance.now();

const errands = {
  session: async () => { const s = await anvil.createSession(); await anvil.releaseSession(s.id); },
  scrape: async () => { await anvil.scrape(EXAMPLE, { format: "text" }); },
  fetch_json: async () => {
    const r = await fetch(JSON_API, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    await r.json();
  },
  "browse+read": async () => {
    const s = await anvil.createSession();
    try { await anvil.navigate(s.id, EXAMPLE); await anvil.readCurrent(s.id); }
    finally { await anvil.releaseSession(s.id); }
  },
};

function stats(ms) {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
  return { n: ms.length, avg: Math.round(avg), p50: Math.round(at(50)), p95: Math.round(at(95)), min: Math.round(sorted[0]), max: Math.round(sorted[sorted.length - 1]) };
}

console.log(`anvil latency bench — ${ANVIL}, ${RUNS} runs/errand\n${"=".repeat(52)}`);
const table = {};
for (const [name, fn] of Object.entries(errands)) {
  const samples = [];
  let errs = 0;
  // one warm-up (not counted) so first-hit cold cost doesn't skew the p50
  try { await fn(); } catch { /* warm-up error tolerated */ }
  for (let i = 0; i < RUNS; i++) {
    const t = now();
    try { await fn(); samples.push(now() - t); }
    catch (e) { errs++; }
  }
  if (samples.length === 0) { console.log(`${name.padEnd(13)} ALL ${RUNS} runs errored`); table[name] = { error: true }; continue; }
  const s = stats(samples);
  table[name] = { ...s, errs };
  console.log(`${name.padEnd(13)} p50 ${String(s.p50).padStart(5)}ms  p95 ${String(s.p95).padStart(5)}ms  avg ${String(s.avg).padStart(5)}ms  (min ${s.min} / max ${s.max}${errs ? `, ${errs} err` : ""})`);
}

console.log(`\nJSON: ${JSON.stringify(table)}`);
process.exit(0);
