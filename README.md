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
                                                          ├─ tools: browse/scrape via anvil, reply
                                                          └─ per-chat memory + safety caps
                                                                │ puppeteer.connect / REST /v1/scrape
                                                                ▼
                                                     anvil-engine (self-hosted Chrome)
```

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

Then text your bot a link — it fetches the page via anvil and replies. The full agent
(tell it an app + task) lands via the `/relay-loop` build backlog.

## Autonomous development

This repo is developed by the `/relay-loop` command (see `../.claude/commands/relay-loop.md`),
runnable on a cron: `/loop 5m /relay-loop`. It pulls the next item from `backlog.json`, builds,
verifies (tsc + vitest + real e2e when keys are present), commits, and pushes.

## Status

Scaffold + anvil client + Telegram transport + stub handler done. Next: the Gemini agent loop
(`backlog.json` item `agent-1`).
