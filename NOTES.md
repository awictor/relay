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
The `Commands:` line lives in START (commands.ts, returned by `/start`), NOT HELP (HELP is the
capability-bullet block). It's the advertised set; keep it == the union of sites 1-3. DEV-0101
(test/commands.test.ts) parses those tokens + drives createHandler with a runAgentFn spy to prove
each is handled, never falls through to the agent.

## Recipe / digest / schedule parsing (two parsers, don't merge them)

Naming a saved thing and scheduling it are parsed in TWO places with different jobs:
- **Timing** — `src/lib/schedule.ts` owns cadence. `parseSchedule(text, now)` and the recipe-facing
  `parseScheduleFor(clause, task, now)` recognize the cadence HEADS: relative `in N min/hour/day`,
  `tomorrow at 9am`/`at 5pm` (→ `once`), and `every day|daily|every morning|every evening|every night`
  (→ `daily`, morning=9/evening=18/night=21). This is the ONLY place that knows what a valid time
  clause looks like.
- **name↔clause split** — `src/handler.ts:~217` `schedule <name> <when>` does its OWN split with a
  regex before handing the clause to schedule.ts: `/^schedule\s+(.+?)\s+((?:every|daily|in|tomorrow|at)\b.*)$/i`.
  The name capture is **lazy** and the when-clause starts at the FIRST `every|daily|in|tomorrow|at`
  token. **BUG (DEV-0129):** a saved name whose 2nd word is one of those keywords ("check in",
  "log in", "sign in", "stand up at ...") truncates — `schedule check in every morning` →
  name="check", when="in every morning", so the "check in" recipe/digest never resolves. Correct fix
  keeps the split in the pure parse: prefer the LONGEST trailing clause that schedule.ts actually
  accepts (try successive split points right-to-left, or feed candidate clauses to `parseScheduleFor`
  and take the first that parses), so an interior time word in a name survives. Do NOT regress the
  common single-word-name case (`schedule digest daily` must stay name="digest").
- **/run name resolution** (`handler.ts:~241`) is digest-first: a digest and recipe with the SAME name
  → the digest always wins silently (no way to target the recipe). Known gap (candidate C-AW).

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

## Numeric env parsing — use intEnv (`src/lib/env.ts`)

- **Never `Number(process.env.X ?? default)` raw.** A typo yields NaN and downstream comparisons
  silently BREAK the feature: a NaN step budget dead-locks the agent (loop `step<=NaN` never runs), a
  NaN rate limit fails OPEN (checkRateLimit always allows), a NaN timer period stops scheduled
  reminders/digests firing. This class bit DEV-0161/0162/0163.
- `intEnv(raw, {fallback, min=0, max?, allowZeroDisable?})` → a finite floored clamped integer or the
  fallback, NEVER NaN. Blank/unset → fallback (Number("") is 0, which would misread as a real 0). A
  literal 0 is honored ONLY with `allowZeroDisable` (means "disable"); else 0/below-min → fallback so a
  bad value can't silently turn a feature off. Pinned by `test/env.test.ts`.
- Consumers: index.ts timer/limit envs (SCHED_TICK/ANVIL_PING/METRICS_*/PROACTIVE_MAX). agent.ts
  resolveMaxSteps + safety.ts resolveRateLimit are named wrappers (their own tests) — DEV-0166 folds
  them onto intEnv. DIGEST/DISPATCH concurrency + ANVIL_RETRY use `Math.max(1, Number(env)||default)`
  (also NaN-safe via `||`). GOTCHA: env-example-parity.test greps source for `process.env.NAME` — don't
  write a literal `process.env.<name>` in a doc comment (it registers a phantom var, DEV-0163).
