# Relay — demo transcript

An annotated walkthrough of what Relay does, as a real Telegram conversation. `You:` is what
you text; `Relay:` is what comes back. Notes in _italics_ explain what's happening under the
hood. Everything here is exercised by the test suite (`npm test`) and the live scripts noted
at the end (`scripts/e2e-*.mjs`).

---

### 1. First contact

> **You:** /start
>
> **Relay:** 👋 I'm Relay. Text me a task and I'll do it in a real browser and text you back.
> Try: "top story on Hacker News" · "extract the price and title from `<link>`" ·
> "compare the price across these 3 links" · "find the newest HN posts about AI"

_The agent drives a self-hosted browser (anvil-engine) — no Browserbase/vendor._

### 2. A one-off lookup

> **You:** what's the top story on Hacker News?
>
> **Relay:** _(typing…)_ Top story: "Show HN: …" — 412 points, 137 comments.

_The agent picked the `scrape` tool, inferred the HN URL, read the page, and summarized. On a
phone, so the reply is short — never a raw dump._

### 3. Pull out just the data you want

> **You:** extract the price and title from https://shop.example.com/widget
>
> **Relay:** price: $19.99 · title: Blue Widget

_`extract` returns clean fields, not prose. If the visible text has nothing, it falls back to
the page's JSON-LD / meta tags (SPAs)._

### 4. Compare across links

> **You:** compare the price across these: `<url1>` `<url2>` `<url3>`
>
> **Relay:**
> • `<url1>` — $19.99
> • `<url2>` — $17.50
> • `<url3>` — $21.00

_`compare` runs the same extraction over each URL in parallel; a page that fails becomes an
all-null row, never a whole-request failure._

### 5. See it / save it

> **You:** screenshot the top of Hacker News
>
> **Relay:** _(sends an image)_ Here's the top of Hacker News right now.

> **You:** save https://example.com/article as a PDF
>
> **Relay:** _(sends a PDF document)_ Saved the article as a PDF.

### 6. A reminder (proactive — Relay messages you later)

> **You:** remind me to stretch in 20 minutes
>
> **Relay:** Got it — I'll remind you: "stretch". Manage with /schedules.
>
> _…20 minutes later, unprompted…_
>
> **Relay:** ⏰ Reminder: stretch
> (done — take a break!)

_Parsed into a schedule, persisted, fired by the in-process runner. No external cron._

### 7. Teach it once — a recipe

> **You:** save btc: check the current price of bitcoin
>
> **Relay:** Saved recipe "btc". Run it anytime with /run btc.

> **You:** /run btc
>
> **Relay:** Bitcoin is about $67,000.

_Recipes turn a repeated ask into a named, reusable task._

### 8. Bundle into a morning briefing — a digest

> **You:** save weather: get the weather in NYC
> **You:** define digest morning: weather, btc
>
> **Relay:** Saved digest "morning" (2 recipes). Run it with /run morning.

> **You:** schedule morning every morning
>
> **Relay:** Scheduled "morning" to run daily. Manage with /schedules.
>
> _…every morning at 9am, unprompted…_
>
> **Relay:** 📋 morning
> • weather: 54°F, light rain in NYC
> • btc: about $67,000

_One curated message instead of several separate pings — recipes + scheduler fused._

### 9. Watch for a change — an alert

> **You:** watch btc: check the price of bitcoin when it changes by 1000
>
> **Relay:** Watching "btc" — I'll only message you when it changes. See /alerts.
>
> _…checked on a cadence; silent while it hovers around $67k…_
>
> **Relay:** 🔔 btc changed: Bitcoin is now about $65,400.

_Alerts only notify on a real change (with an optional numeric threshold), so you're not
pinged for noise. This is the jump from fetch-on-demand to watch-and-notify._

### 10. Managing it all

> **You:** /schedules → lists pending reminders/scheduled runs
> **You:** /recipes → lists saved recipes · /run `<name>` · /forget `<name>`
> **You:** /digests → lists digests · /forget-digest `<name>`
> **You:** /alerts → lists watches (with last value) · /forget-alert `<name>`
> **You:** /status → "✅ Relay up 3h 12m · 41 tasks handled · browser connected."
> **You:** /reset → clears this chat's memory

### Safety, always on

Relay won't log in as you, pay, buy, or take destructive actions — inbound **or** on a
schedule; it says so instead. Per-chat rate limits + a per-chat proactive-send cap keep a
misfiring alert from spamming you.

---

## Verify it live

Offline suite (no keys, no browser): `npm test` — 330+ tests.

Live end-to-end (need `.env` + anvil on `:3000`):
- `npx tsx scripts/e2e-agent-chain.mjs` — real agent drives anvil against a real site.
- `npx tsx scripts/e2e-schedule.mjs` — a reminder fires unprompted.
- `npx tsx scripts/e2e-recipe.mjs` — a saved recipe runs on schedule.
- `npx tsx scripts/e2e-digest.mjs` — a scheduled digest sends one combined briefing.
- `npx tsx scripts/e2e-alert.mjs` — a watched value change notifies; unchanged stays silent.
