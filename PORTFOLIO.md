# Portfolio: one self-hosted browser, two products, no vendor

**Thesis:** a single self-hosted agentic browser — **anvil-engine** — is the engine both products
run on. No Browserbase / Browserless / Steel meter in the path. Unlimited browser access on free
infra, at measured sub-second latency.

This is the map. For the numbers behind the thesis see **[THESIS.md](THESIS.md)**; to run it
yourself see [Guided demo](#guided-demo).

## The three repos and how they connect

```
                  ┌──────────────────────────────┐
                  │  anvil-engine (awictor/…)     │   self-hosted real Chrome
                  │  REST + CDP proxy + MCP        │   /v1/sessions, /v1/scrape, /v1/view …
                  │  pooling, caps, /v1/health     │   637 tests
                  └──────────────┬─────────────────┘
                                 │  same connect logic, vendored byte-identical
             ┌───────────────────┴───────────────────┐
             ▼                                         ▼
   ┌───────────────────────┐              ┌────────────────────────────┐
   │ Relay (awictor/relay)  │              │ DataFaucet (awictor/mcp-…) │
   │ text-a-bot agent       │              │ dev/MCP capture layer      │
   │ Telegram → agent →     │              │ auto-scan/browse routes    │
   │ anvil → reply          │              │ BROWSER_BACKEND=anvil flag │
   │ 370 tests, live-proven │              │ 1823 tests, anvil path live │
   └───────────────────────┘              └────────────────────────────┘
```

- **anvil-engine** — the shared browser. Real Chrome, self-hosted; REST + a CDP websocket proxy +
  an MJPEG live view + an MCP surface. Pooling, per-session caps, crash-handlers (exit-for-supervisor),
  and an operator-legible `/v1/health` + `/v1/metrics` (sessions active/max, pool, uptime). The exact
  endpoints Relay verifies against are in [ANVIL-CONTRACT.md](ANVIL-CONTRACT.md).
- **Relay** — a consumer text-a-bot: text it a task, an agent drives anvil and texts back. Scheduled
  tasks, recipes, digests, change-alerts, graceful degradation. The brain is behind one `LLMClient`
  interface with two real adapters — `GeminiClient` (free tier, default) and `ClaudeClient`
  (Anthropic Messages API) — swapped by `LLM_PROVIDER=gemini|claude` (a live Claude call needs a
  paid `ANTHROPIC_API_KEY`).
- **DataFaucet** — the dev/MCP layer; its capture/browse flow can run on anvil behind
  `BROWSER_BACKEND=anvil` (default stays Browserbase until the owner merges — prod is untouched).

**The connection is literal, not aspirational:** the anvil connect logic (session-URL builder +
transient-error taxonomy) lives once as `src/lib/anvil-client.ts` in Relay and is **vendored
byte-identical** into DataFaucet, enforced by a parity test in both repos. One source of truth for
how anything talks to anvil. The full map of what's shared vs Relay-local is in
**[SHARED.md](SHARED.md)**.

**Safety:** Relay drives a real browser for anyone who texts it, so the blast radius is bounded by an
SSRF guard, a dangerous-action guard, secret redaction, a per-chat rate limit, and step caps — each
adversarially tested. See **[SECURITY.md](SECURITY.md)**.

## What's proven (live, not just typechecked)

- **Relay on anvil** — `npm run e2e:live`: the real Telegram→agent→anvil→reply pipe drives live
  anvil for scrape / fetch_json / multi-step browse→read and asserts real content.
- **DataFaucet on anvil** — `npm run e2e:anvil` (mcp-forge): the real capture routes under
  `BROWSER_BACKEND=anvil` create a live session, serve a real MJPEG frame, and release — the
  **second product proven live on the shared engine**, not just the first.
- **Degradation** — `npm run e2e:faults`: real induced failures (anvil down, blocked URL, session
  dies mid-task) all fail *soft* — friendly message, no crash, no raw error leaked.
- **Cost/latency** — `npm run bench:latency`: measured sub-second per errand; see THESIS.md.
- **Deploy readiness** — `npm run preflight`: one GO/NO-GO across the whole stack.
- **Merge readiness** — `node scripts/merge-readiness.mjs` (mcp-forge): the anvil→prod merge is a
  zero-surprise, read-only pre-check.

## Honest status

**Proven and gated — not yet deployed.** Every automated proof above is green. What remains is
genuinely **owner-only**:

- provision the always-on host (Oracle Cloud Always Free VM) and `docker compose up` — see
  [DEPLOY.md](DEPLOY.md);
- merge DataFaucet PR #1 (`anvil-migration` → `master`) — pre-checked by merge-readiness;
- fix the mcp-forge GitHub Actions billing block so the PR's CI can run.

None of these are code problems; they're a host, a merge click, and a billing setting. The code is
ready for all three.

## Guided demo

**Setup (once), from a clean checkout** — the two repos sit side by side under one parent dir:

```bash
git clone https://github.com/awictor/relay.git
git clone https://github.com/awictor/mcp-forge.git
git -C mcp-forge checkout anvil-migration        # the flag-gated anvil work
cd relay && npm ci && cd ../mcp-forge && npm ci && cd ../relay
cp .env.example .env                             # fill GEMINI_API_KEY for the live cases
# start anvil separately (see anvil-engine repo); default ANVIL_BASE_URL=http://localhost:3000
```

**Step 0 — feel the product** (the human-facing one; needs `GEMINI_API_KEY` + anvil up):

```bash
npm run demo             # type a task; the real agent drives anvil and answers in your terminal
```

Then five commands walk the whole story (fullest signal when anvil is up + `GEMINI_API_KEY` set;
each SKIPs cleanly otherwise, so the sequence still runs on a bare machine):

```bash
# in relay/
npm run preflight        # ONE GO/NO-GO across Relay + DataFaucet + anvil (7 checks)
npm run bench:latency    # real measured anvil latency — the THESIS.md numbers
npm run e2e:faults       # induce real failures (anvil down / blocked URL / mid-session death)
npm run status           # offline health: schedules/recipes/alerts + anvil capacity

# in ../mcp-forge/  (anvil-migration branch)
node scripts/merge-readiness.mjs   # READY-TO-MERGE verdict for the anvil→prod PR
```

**What "working" looks like** (anvil up, key set):

- `preflight` → `GO ✅ — 7/7 passed` (or `N passed, M skipped` on a partial env; never a false green).
- `bench:latency` → a table: `session p50 ~244ms`, `fetch_json ~155ms`, `browse+read ~326ms`,
  `scrape ~923ms` (includes anvil's client-render settle).
- `e2e:faults` → `N/N fault assertions passed` — every drill degraded soft, no raw error, no crash.
- `status` → store counts + `anvil (…): UP … sessions X/Y` + last metrics window.
- `merge-readiness` → `READY TO MERGE ✅ — … no conflicts, gate green, browserbase default provably
  unchanged` (read-only of master; refuses on a dirty tree).

Every live command is **CI-safe**: absent anvil/key/`../mcp-forge` → SKIP (exit 0), never a hard
fail, so the demo runs anywhere and only exercises what the environment supports.

---
*Developed autonomously by a self-advancing dev loop (`/agent-loop`): 21 milestones shipped, each
picked, built, verified, and committed by the loop; the roadmap advances itself and authors its own
next milestone. See `portfolio-backlog.json` for the full history.*
