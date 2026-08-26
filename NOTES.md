# relay — dev NOTES

Durable, reusable facts for anyone (or any loop) touching this repo. Keep terse.

## Architecture

Telegram long-poll → agent (LLM plans over tools) → anvil browser → reply.
`src/index.ts` wires it: `startPolling` → `createHandler` (src/handler.ts) per message.

- `src/agent.ts` — `runAgent(userText, deps, history=[])` → `{reply, steps, tools}`.
  Builds `messages = [system, ...history, {user}]`, loops ≤ `RELAY_MAX_STEPS` (env, default 8).
  Tools: scrape / browse+click/type/read / extract / compare / search / fetch_json / screenshot /
  pdf / reply. `reply` ends the loop; unknown tool → error message back to the model (still in `tools`).
  Binary tools (screenshot→photo, pdf→doc) return bytes via runAgent's `{photo?,doc?}` — the handler
  sends them (sendPhoto/sendDocument). scrape/read/fetch_json results are sliced to 6000 chars.
  Browser access is injectable: `deps.backend?: BrowserBackend` (full) or `deps.scrapeFn?` (scrape-only)
  — tests run fully offline with a stub LLM + stub backend.
- `src/anvil.ts` — the **verified anvil-connect reference**. Reuse its patterns before
  reinventing anvil calls anywhere. scrape uses `domcontentloaded` (NOT networkidle — networkidle
  hangs on polling pages like HN; locked by test/anvil-scrape.test.ts).
- `src/lib/url-validator.ts` — `isUrlSafe()` SSRF guard EVERY tool routes through. **Kept identical
  to mcp-forge's copy** so fixes merge both ways — edit both or note the divergence. `safeFetch`
  adds per-redirect-hop revalidation + a DoH DNS-rebinding guard (fails OPEN on resolver error).
- `src/safety.ts` — `redactText`/`redactObject` (keep secrets out of logs) + `isDangerousAction`
  (refuses pay/buy/delete/submit/logout clicks) + `checkRateLimit`.

## Test coverage map (avoid duplicating)

agent: dispatch / browse / loop / chain / extract(+fallback) / compare / search / fetch-json;
commands, telegram, safety, memory-store, anvil-scrape/retry, llm-failover, format-reply, turn-log,
url-validator, handler(+smoke), metrics. Gate: `npm run typecheck` + `npm test` (vitest).

## Adding a tool or command (the full checklist)

Shipping a relay agent TOOL takes FOUR pieces — miss one and it's silently dead:
1. `TOOLS[]` entry (name + description + params) in agent.ts.
2. dispatch branch in runAgent (SSRF-guard the url; optional `backend.X?` → "unavailable" not a hard fail).
3. handler wiring if it returns a binary (thread through runAgent's return; handler sends it).
4. **`SYSTEM_PROMPT` prose menu line** — the model picks from THIS, not the TOOLS schema. DEV-0035 was
   a real bug: screenshot/pdf were 1–3 done but absent from the prompt, so the model never chose them.

User COMMANDS (/reset, /status): pure-text ones live in `handleCommand(text)→string|null`; state-touching
ones (need chatId) live in the handler's `first`-token branch BEFORE handleCommand, via an optional
HandlerDeps callback. Both short-circuit before rate-limit/agent. List new ones in /help + /start.

Command dispatch MAP (three sites — a grep for one misses the others):
1. `handleCommand` (`src/commands.ts`) — pure canned text: `/start`, `/help` (+ bot-suffix/case strip).
2. handler `first`-token `if (first === "/x" && deps.xCb)` (`src/handler.ts`): `/reset`(+`/clear`), `/status`,
   `/schedules`, `/cancel`, `/recipes`, `/forget`, `/alerts`, `/forget-alert`, `/digests`, `/forget-digest`.
3. `/run <name>` is NOT a `first===` branch — it's a dedicated block (~handler.ts:214) matching
   `/^(\/run\b|run\s+)/i`, digest-first (`isDigest`→`digestRun`) then recipe (`recipeResolve` rewrites
   msg.text to the saved task and FALLS THROUGH to the agent). So proving `/run` is handled needs an
   end-to-end `createHandler` drive with a `runAgentFn` spy, never a static "is it dispatched" grep.
The `Commands:` line in HELP (commands.ts) is the advertised set; keep it == the union of sites 1-3.

## Concurrency

`startPolling` dispatches each getUpdates batch via `dispatchBatch` = `Promise.all` with per-handler
`.catch` (DEV-0037) — independent chats don't head-of-line-block each other; one throw doesn't sink the
batch. Concurrency is per-BATCH; cross-batch stays serial (the poll loop awaits the batch before the
next getUpdates). Per-chat `checkRateLimit` guards abuse, not latency.

## Process lifecycle & resilience (24/7 worker)

Two distinct exit paths in `src/shutdown.ts`, wired in `index.ts`:
- **Signal shutdown** — `createShutdown` + `installSignalHandlers` catch SIGTERM/SIGINT (docker stop,
  pm2 restart, Ctrl-C): stop the poller + anvil pinger, flush the final metrics window (`onShutdown`,
  DEV-0041), `exit(0)`. Idempotent (a 2nd signal mid-shutdown is ignored). Clean stop.
- **Crash** — `installCrashHandlers` (DEV-0066) catches `uncaughtException` + `unhandledRejection`:
  without it a stray throw/reject in a non-awaited path killed the worker with NO log (deploy goes
  dark). Logs `[fatal] <kind>: <stack≤1000>`, best-effort `onFatal` flush, `exit(1)`. Re-entrancy
  guarded (`dying` flag) so a rejection during the exception handler can't loop.
- **Exit-code contract: 0 = intended stop, 1 = crash.** A supervisor uses this to decide restart —
  don't exit(0) on an error path or the crash looks intentional and won't restart.
- Both take an injectable `exit` (defaults `process.exit`) so tests drive them without killing the
  runner. Memory needs no flush — MemoryStore is `writeFileSync` per turn (synchronously durable).
- relay has NO HTTP server (Telegram long-poll), so there is no `/healthz` — liveness is the `/status`
  text reply + the supervisor's own process check. Don't add an http health endpoint.

## Free-infra constraint

Telegram long-poll, Gemini free tier, self-hosted anvil. No paid vendor. `.env` gitignored;
never commit real keys.

## Secret redaction (two independent layers — don't confuse them)

Secrets are kept out of logs/replies by TWO functions in `src/safety.ts`, matching on different axes:
- `redactText(s)` — VALUE-SHAPE regex over free text. Masks `Bearer <tok>`, `AIza…`, `sk-…`,
  telegram bot tokens (`\d{8,10}:AA…`), and long hex (`[0-9a-f]{32,}`). Used on inbound message text
  before it hits the log: `handler.ts:45` `log("[in] " + deps.redactText(msg.text).slice(0,120))`.
  Wired in via `src/index.ts` (createHandler dep). Tested in `test/safety.test.ts`.
- `redactObject(obj)` = `redactSecretsDeep(obj, ()=>"[redacted]", SENSITIVE_KEY_RE)` — KEY-NAME deep
  redaction for structured tool args. Complements redactText: catches a secret whose VALUE doesn't
  match a known shape but whose KEY is sensitive (e.g. `{password:"hunter2"}`). `redactSecretsDeep`
  itself is pinned by `test/redact-secrets.test.ts` (DEV-0051); `redactObject`'s wrapper defaults were
  only exercised via handler mock stubs — a direct test is the open gap (DEV-0052, rescoped).
- **turn-log carries NO body.** `src/lib/turn-log.ts` `formatTurnLog` emits shape/metadata ONLY
  (chat id, step count, deduped tool names, ms, replyChars, ok, truncated error) — never message text
  or args. So there is nothing in the `[out]` line to redact; DEV-0052's original "turn-log redaction"
  premise was wrong. The redaction that matters is on the `[in]` line (redactText) + tool-arg logging
  (redactObject), not turn-log.
