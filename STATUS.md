# Portfolio status — one glance

Thesis: **anvil-engine is the self-hosted agentic browser both products run on** — no
Browserbase/Browserless/Steel vendor. Built autonomously via `/agent-loop`. Free infra only.

## Product-loop status (Relay) — converged, 2 levers left for the owner

`/product-loop` has driven Relay from MVP to a deep, hardened product surface (**~2021 offline
tests**, tsc-clean, every push green). The reliability/parse/safety/feed/UX veins are swept:
send-delivery gating, DST-correct reminders + world-clock + datetime, no-threshold-watch
deadband, silent-data-loss fixes (list/digest/watchlist/chain caps now surfaced), a widened +
runtime-verified dangerous-action guard, read-it-later (capture/recall/digest-recap/weekly
nudge), dead-follow fixes (HN/GitHub/Reddit-user/YouTube), and a run of parse fixes (unit-price,
alert-colon, quick-log commas, weather day-resolution, .ics line-folding). Recent iterations
have been self-audits of fresh surfaces — still finding real bugs, but returns are diminishing.

**Two high-value levers remain, both gated (the loop can't do them):**
1. **`confirm-to-act`** *(high, owner decision)* — should Relay confirm before a state-changing
   step, and with what UX? A product call, not a code task. This is the top remaining lever.
2. **`anvil-live-e2e-when-up`** *(medium, needs anvil running)* — anvil has been DOWN for ~20
   iterations, so every recent change is unit-verified only. Start anvil
   (`docker run -p 3000:3000 anvil-engine`) and the loop will drive one real errand end-to-end
   (scrape + weather via the console channel) and report `call-tested: true`.

## What shipped

**Relay** (`awictor/relay`) — text-a-Telegram-bot agent, an Instinct competitor.
- 6 fetch tools: `scrape`, `browse`/`click`/`type`/`read`, `extract` (fields → JSON, with a
  JSON-LD/meta fallback for SPAs), `compare` (same fields across many URLs), `search`
  (harvest result links, no URL pasting), `fetch_json` (direct JSON APIs, no browser).
- Persistent per-chat memory (survives restart), SSRF guard, dangerous-action refusal,
  rate limit, step/time caps, transient-error retry, secret redaction.
- SMS-friendly replies (never dumps raw JSON), per-turn `[out]` + rolling `[metrics]` logs.
- Gemini free tier with multi-model failover, behind an adapter (Claude = one-line swap).
- **117 offline tests**, CI-green on every push. Live-verified end to end (Gemini + anvil).

**DataFaucet migration** (`awictor/mcp-forge`, branch `anvil-migration`, **draft PR #1**).
- Entire browser surface moved onto anvil behind `BROWSER_BACKEND` (default `browserbase`):
  capture (auto-scan HAR) + manual browse (start/stop/debug + `/v1/view` live-view).
- **Prod byte-for-byte unchanged** until the flag is set. Kills the Browserbase vendor when on.
- Offline unit gate added to CI (`test:unit`, **1786 tests, 0 fail** locally) so the anvil
  suites are enforced, not just runnable. Both capture + browse live-e2e'd, zero Browserbase.

**anvil-engine** (`awictor/anvil-engine`) — the shared engine.
- Real Chrome over CDP: REST + WebSocket CDP proxy + MCP server; sessions, HAR (with
  response content-type + body preview), MJPEG live-view, `/v1/metrics` (session counts +
  per-endpoint p50/p95/p99). **529 tests**, CI-green.

## Owner actions (only these gate going live)

1. **Fix mcp-forge GitHub billing.** Actions is billing-blocked → the PR #1 CI gate
   (build / unit / e2e) queues but can't start. Settings → Billing & plans.
2. **Merge draft PR #1** (`anvil-migration` → `master`). Prod-safe (flag defaults to
   browserbase); 1786-test unit gate passes locally.
3. **Provision the Oracle Always Free VM + `docker compose up`** (see `DEPLOY.md`). Relay is
   feature-complete + deploy-ready (model default + healthcheck fixed). Then Relay is live 24/7.

## Honest limits

- **Live-view under anvil is read-only** (MJPEG; no click-injection like Browserbase's
  debugger). Fine for capture; interactive click-through is a follow-up (syn-2c).
- **Compute, not vendor, is the wall.** Self-hosting removes the per-call meter + quota, not
  the cost of running a Chrome fleet. The Always-Free Micro shape does a couple concurrent
  sessions; Ampere A1 does many. Tune `ANVIL_MAX_SESSIONS`.

## Verify it yourself

- Relay offline suite: `cd relay && npm test` (117, no keys).
- Relay live agent: `npx tsx scripts/e2e-agent-chain.mjs` (needs `.env` + anvil on :3000).
- Migration gate: `cd mcp-forge && git checkout anvil-migration && npm run test:unit` (1786).

## Reproducible deploy point

Both repos are tagged **`deploy-v1`** at this all-green state (anvil 529 tests + build CI
green; relay 117 tests CI green). For an exact validated deploy: `git checkout deploy-v1`
in each before `docker compose up` (see `DEPLOY.md`). Bump both tags together after
validating a newer state.
