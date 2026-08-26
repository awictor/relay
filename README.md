# Relay

Text a bot; it sends an autonomous agent + a **self-hosted browser** to fetch and process
data from any app, and texts you back. A competitor to [Instinct](https://instinct.co) built
on our own browser engine ([anvil-engine](https://github.com/awictor/anvil-engine)) — **no
Browserbase / Browserless / Steel vendor** in the path, unlimited browser access.

MVP is **free infra**: Telegram (long-poll, no public URL), a free-tier LLM (Gemini), and
self-hosted anvil-engine (real Chrome).

> **New here?** [PORTFOLIO.md](PORTFOLIO.md) is the 2-minute map — the one-shared-browser thesis,
> the three repos and how they connect, what's proven live, and a 5-command guided demo.
>
> **Want to just *see* it?** `npm run demo` — type a task at a prompt and watch the real agent drive
> self-hosted anvil and answer, right in your terminal (no Telegram bot). Needs `GEMINI_API_KEY` +
> anvil running; prints a clear notice and exits if either is missing.

## Architecture

```
Telegram user ──text──> Telegram Bot API ──long-poll──> Relay worker (Node/TS)
                                                          ├─ agent loop (Gemini free tier; Claude-swappable)
                                                          ├─ tools: scrape/browse/extract/compare/search/fetch_json, reply
                                                          ├─ persistent per-chat memory + safety caps + SMS formatting
                                                          └─ transient-retry + per-turn [out]/[metrics] logs
                                                                │ puppeteer.connect / REST /v1/scrape
                                                                ▼
                                                     anvil-engine (self-hosted Chrome)
```

## Why self-hosted (no browser vendor)

Relay and DataFaucet both run their browsing on self-hosted **anvil-engine** instead of a
Browserbase / Browserless / Steel meter. That's not just a preference — it's **measured**:
`npm run bench:latency` shows sub-second latency on every canonical errand (fast path ~155 ms),
and the marginal cost of a session is **$0** on an Oracle Always-Free VM. The honest trade (a
concurrency ceiling + ops ownership, both instrumented here) and a reproducible cost model are
written up in **[THESIS.md](THESIS.md)**.

## What you can text it

**Fetch & read**
- **Read**: send a link, or name a site + what you want — "top HN story", "weather in Paris".
- **Extract** structured data: "extract the price and title from `<link>`" → clean JSON, not prose.
- **Compare** across pages: "compare the price of X across these links" → one row per link.
- **Search then fetch**: "find the newest listings for `<thing>`" → Relay opens the search page,
  harvests the result links, and reads/extracts across them (no URL pasting).
- **JSON APIs**: hits a public JSON endpoint directly (no browser) when that's faster.
- **See / save**: "screenshot the top of Hacker News" → an image; "save this as a PDF: `<link>`" → a doc.

**Proactive (it messages you)**
- **Reminders / schedules**: "remind me to stretch in 20 min", "every morning text me the weather".
- **Recipes**: "save btc: check the price of bitcoin" → re-run with `/run btc` or `schedule btc every morning`.
- **Digests**: "define digest morning: weather, hn, btc" → one combined briefing, `/run morning` or scheduled.
- **Alerts**: "watch btc: price of bitcoin when it changes by 1000" → it only pings you when it moves.

It won't pay, buy, or take destructive actions — it says so instead. It stays logged-out on public
pages by default; you can **authorize specific sites** by configuring host-scoped cookies
(`RELAY_COOKIES`, opt-in + gitignored) so it can read a page you're entitled to — `/sites` lists which
hosts you've authorized (names only), and the dangerous-action guard still blocks committing clicks.
See [SECURITY.md](SECURITY.md).

**Commands**: `/help` `/start` `/reset` (clear chat) `/status` (health) `/sites` (authorized hosts) ·
`/schedules` `/cancel` · `/recipes` `/run` `/forget` · `/digests` `/forget-digest` · `/alerts` `/forget-alert`.

Runs on Telegram by default, or a terminal (`RELAY_CHANNEL=console`) — the agent core is
transport-agnostic (see `src/channel.ts`).

## Setup

```bash
npm install
cp .env.example .env      # fill TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, ANVIL_BASE_URL
```

- **Telegram token**: message [@BotFather](https://t.me/BotFather) → `/newbot`.
- **Gemini key** (free): https://aistudio.google.com/apikey
- **anvil-engine**: clone `awictor/anvil-engine`, `npm run build && npm start` (or
  `docker run -p 3000:3000 anvil-engine`). Needs Node 22 + Chrome/Chromium.

## Run

```bash
npm run dev       # start the worker (long-polls Telegram)
npm run typecheck # tsc --noEmit
npm test          # vitest (unit, no network)
```

Then text your bot a task in plain English — it plans over its tools, drives anvil, and
texts back a phone-friendly answer.

## Verify

```bash
npm test              # 350+ offline unit/wiring tests (no keys, no anvil)
npm run e2e:live      # LIVE end-to-end: real Gemini + anvil across canonical errands
npm run e2e:faults    # LIVE fault drills: induce real failures, assert it fails soft
npm run status        # offline health: what's scheduled/saved/watched + is anvil up
npm run preflight     # ONE GO/NO-GO across the whole stack (Relay + DataFaucet + anvil)
```

`npm run e2e:live` (`scripts/e2e-live.mjs`) is the **CI-safe** live smoke test. It drives the
real agent (Gemini + anvil) through the canonical errands — a deterministic **scrape**
(example.com), a **fetch_json** against a public no-key API (open-meteo), and a multi-step
**browse→read** — and asserts real content came back plus the expected tool was used.

- It **SKIPs cleanly (exit 0)** when anvil is unreachable or `GEMINI_API_KEY` is unset, so it's
  safe to run in an offline pipeline — hence it's the deploy smoke test to run once the VM is up.
- Needs `.env` filled (`GEMINI_API_KEY`) + anvil reachable at `ANVIL_BASE_URL`
  (default `http://localhost:3000`) to actually exercise the pipe; exits non-zero if a live case fails.

`npm run e2e:faults` (`scripts/e2e-faults.mjs`) is the **fault-injection** counterpart: it induces
REAL failures through the live agent and asserts the bot fails *soft* — anvil unreachable (dead base
URL), a blocked/SSRF URL, and anvil dying mid-session (browse ok, then the read throws). Each drill
asserts the user-facing reply carries no raw internals (ECONNREFUSED/host/`Blocked URL`/stack) and
that nothing crashes. Same CI-safe skip (exit 0 without `GEMINI_API_KEY`). This is what turns the
m14 degradation guarantees from unit-mock-proven into deploy-proven.

The older `scripts/e2e-*.mjs` (agent-chain, schedule, recipe, digest, alert, shutdown) are
feature-specific live/offline proofs; `e2e:live` is the consolidated deploy check.

`npm run status` (`scripts/status.mjs`) is the offline **operability** view — ssh into the VM and
run it to see, without reading logs or texting the bot: how many schedules/recipes/digests/alerts
are stored (across how many chats), anvil health from its `/v1/health` (up + latency, plus active/max
sessions, warm pool, and uptime when the running anvil build reports them), which keys are set (names
only), and the last persisted metrics window (ok/fail, latency percentiles, tool mix). It needs
**no keys** — counts come from the durable state files the runtime writes — and always exits 0.

### Deploy readiness — `npm run preflight`

`npm run preflight` (`scripts/preflight.mjs`) runs **every automated proof across the whole stack**
and prints a single **GO / NO-GO**. It's the one command to run before spending effort on the
deploy — GREEN means the code is ready and the only remaining unknowns are the **host** (Oracle VM)
and **secrets**.

The seven checks and what each proves:

| Check | Proves |
|-------|--------|
| `relay: unit tests` (`npm test`) | 350+ pure logic/wiring units — all Relay behavior, offline. |
| `relay: live e2e` (`npm run e2e:live`) | Real channel→agent→anvil→reply pipe (scrape, fetch_json, browse→read). |
| `relay: fault drills` (`npm run e2e:faults`) | Degradation holds under real faults (anvil-down, blocked URL, mid-session death). |
| `relay: operability` (`npm run status`) | The offline health/state view runs clean. |
| `datafaucet: unit` (`npm run test:unit`, in `../mcp-forge`) | DataFaucet's suite incl. the anvil-migration paths (browserbase default unchanged). |
| `datafaucet: anvil` (`npm run e2e:anvil`, in `../mcp-forge`) | The **second product** drives real anvil end to end (session→live view→release). |
| `anvil: health` (`GET /v1/health`) | The shared engine is up + reports session capacity. |

**SKIP is not a failure.** Each live check exits 0 with a `SKIP` note when its dependency is
offline (anvil down, `GEMINI_API_KEY` unset, or `../mcp-forge` not checked out), so preflight runs
anywhere — a fully offline machine still gets a GO on what it *can* prove. **NO-GO** fires only on a
hard failure, and the failing check's output tail is printed inline. See `DEPLOY.md` for the host +
secrets steps that a GREEN preflight leaves as the only remaining work.

## Shared anvil client (vendoring contract)

`src/lib/anvil-client.ts` (session-URL builder + transient-error taxonomy) is the **canonical**
copy of the anvil connect logic; it's **vendored byte-identical** into DataFaucet
(`mcp-forge/src/lib/anvil-client.ts`) so both products connect to anvil the same way — the
"one shared browser" thesis, deduplicated. It's a vendored copy (not an npm package) because
the repos are separate + free-infra. **To change it: edit here, copy to mcp-forge, run both
suites** — `test/anvil-client-parity.test.ts` (here) and `tests/unit/anvil-client-parity.test.ts`
(there) fail if the two drift.

## Autonomous development

This repo is developed by the `/relay-loop` command (see `../.claude/commands/relay-loop.md`),
runnable on a cron: `/loop 5m /relay-loop`. It pulls the next item from `backlog.json`, builds,
verifies (tsc + vitest + real e2e when keys are present), commits, and pushes.

## Status

**Feature-complete, live-verified.** The full pipe (Telegram → agent → anvil → reply) works
end to end on free infra.

- **Agent tools**: `scrape`, `browse`/`click`/`type`/`read` (multi-step), `extract` (fields → clean
  JSON, with a JSON-LD/meta fallback for SPAs), `compare` (same fields across many URLs),
  `search` (harvest result links, no URL pasting), `fetch_json` (direct JSON APIs, no browser),
  `screenshot` (image), `pdf` (document).
- **Proactive**: scheduled tasks/reminders that fire unprompted; saved **recipes** (teach-once,
  re-run by name or schedule); **digests** (bundle recipes into one briefing); **change-alerts**
  (silent until a watched value moves, optional numeric threshold). All persisted, all
  schedulable via one runner.
- **Transport-agnostic**: a `Channel` interface (Telegram + a Console channel); pick with `RELAY_CHANNEL`.
- **Robustness**: SSRF guard on every URL, dangerous-action refusal (inbound AND proactive),
  per-chat rate limit, bounded step/time caps, transient-error retry around anvil, per-chat
  proactive-send cap (anti-spam), secret redaction, graceful shutdown.
- **Persistence**: per-chat memory + schedules + recipes + digests + alerts, all across restarts
  (JSON files, gitignored).
- **Replies**: SMS-friendly formatting — never dumps raw JSON at a user.
- **Observability**: `[out]` per turn + `[proactive]` per scheduled fire + a rolling `[metrics]` summary.
- **Model**: Gemini free tier with a multi-model failover chain; behind an adapter so Claude is
  a one-line swap.
- **Tests**: 330+ (`npm test`), offline (mock LLM + backend); plus live `scripts/e2e-*.mjs`.
  See `DEPLOY.md` for the 24/7 runbook.
