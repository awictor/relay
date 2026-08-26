# relay — dev NOTES

Durable, reusable facts for anyone (or any loop) touching this repo. Keep terse.

## Architecture

Telegram long-poll → agent (LLM plans over tools) → anvil browser → reply.
`src/index.ts` wires it: `startPolling` → `createHandler` (src/handler.ts) per message.

- `src/agent.ts` — `runAgent(userText, deps, history=[])` → `{reply, steps, tools}`.
  Builds `messages = [system, ...history, {user}]`, loops ≤ `RELAY_MAX_STEPS` (env, default 8).
  Tools: scrape / browse+click/type/read / extract / compare / search / fetch_json / reply.
  `reply` ends the loop; unknown tool → error message back to the model (still recorded in `tools`).
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

## Free-infra constraint

Telegram long-poll, Gemini free tier, self-hosted anvil. No paid vendor. `.env` gitignored;
never commit real keys.
