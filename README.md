# Relay

Text a bot; it sends an autonomous agent + a **self-hosted browser** to fetch and process
data from any app, and texts you back. A competitor to [Instinct](https://instinct.co) built
on our own browser engine ([anvil-engine](https://github.com/awictor/anvil-engine)) — **no
Browserbase / Browserless / Steel vendor** in the path, unlimited browser access.

MVP is **free infra**: Telegram (long-poll, no public URL), a free-tier LLM (Gemini), and
self-hosted anvil-engine (real Chrome).

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

It won't log in as you, pay, buy, or take destructive actions — it says so instead.

**Commands**: `/help` `/start` `/reset` (clear chat) `/status` (health) · `/schedules` `/cancel` ·
`/recipes` `/run` `/forget` · `/digests` `/forget-digest` · `/alerts` `/forget-alert`.

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
npm test                              # 100+ offline unit/wiring tests (no keys, no anvil)
npx tsx scripts/e2e-agent-chain.mjs   # LIVE end-to-end: real Gemini + anvil against a real site
```

The live e2e needs `.env` filled (`GEMINI_API_KEY`) and anvil reachable at `ANVIL_BASE_URL`
(default `http://localhost:3000`). It drives the real agent, asserts it used a fetch tool +
replied from real data, and exits non-zero on failure — a one-command deploy smoke test.

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
