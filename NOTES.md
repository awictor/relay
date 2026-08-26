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

## Concurrency

`startPolling` dispatches each getUpdates batch via `dispatchBatch` = `Promise.all` with per-handler
`.catch` (DEV-0037) — independent chats don't head-of-line-block each other; one throw doesn't sink the
batch. Concurrency is per-BATCH; cross-batch stays serial (the poll loop awaits the batch before the
next getUpdates). Per-chat `checkRateLimit` guards abuse, not latency.

## Free-infra constraint

Telegram long-poll, Gemini free tier, self-hosted anvil. No paid vendor. `.env` gitignored;
never commit real keys.
