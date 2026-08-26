// m25 demo-1: `npm run demo` — drive the REAL Relay agent from your terminal, no Telegram bot, no
// public URL. It sets RELAY_CHANNEL=console and boots the actual index.ts wiring (same handler, same
// anvil-backed agent, same LLM selector) so what you type goes through the real pipe and the reply
// comes from real anvil. Reuses index.ts entirely — the agent is NOT forked.
//
//   npm run demo            # then type a task at the > prompt; Ctrl-C to exit
//
// Preflight: if the model key or anvil is missing, print a clear one-line notice and exit 0 (no
// crash) — a demo that can't run should say why, not stack-trace.
process.loadEnvFile?.(".env");

const provider = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
const keyVar = provider === "claude" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
const anvilBase = (process.env.ANVIL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

function notice(msg) { console.log(`\n[demo] ${msg}\n`); process.exit(0); }

if (!process.env[keyVar]) {
  notice(`${keyVar} not set (LLM_PROVIDER=${provider}). Add it to .env, then: npm run demo`);
}
try {
  const r = await fetch(`${anvilBase}/v1/live`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`status ${r.status}`);
} catch (e) {
  notice(`anvil not reachable at ${anvilBase} (${e instanceof Error ? e.message : String(e)}). Start anvil-engine, then: npm run demo`);
}

// Force the console transport, then hand off to the real entrypoint (it self-runs main()).
process.env.RELAY_CHANNEL = "console";

console.log(`
┌─ Relay demo ───────────────────────────────────────────────┐
│ Type a task; the real agent drives self-hosted anvil and     │
│ answers here. No Telegram — this is the console channel.     │
│ Brain: ${provider.padEnd(7)}   Browser: ${anvilBase.padEnd(28)}│
│ Try:  what's the top story on Hacker News?                   │
│       what's the current weather in London?                  │
│ Ctrl-C to exit.                                              │
└──────────────────────────────────────────────────────────────┘`);

await import("../src/index.ts");
