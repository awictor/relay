# Why self-hosted anvil, not a browser vendor

The whole stack (Relay + DataFaucet) runs its browsing on **anvil-engine**, self-hosted, instead
of Browserbase / Browserless / Steel. This page states the case with **measured latency** and a
**reproducible cost model** — not marketing numbers.

## Measured latency (real, reproducible)

From `npm run bench:latency` against a local anvil (10 runs/errand, one uncounted warm-up, timed
through the product's own `src/anvil.ts` client — the same path a user hits):

| Errand | p50 | p95 | avg | notes |
|--------|-----|-----|-----|-------|
| session create + release | **244 ms** | 271 ms | 246 ms | fixed per-task browser overhead |
| `fetch_json` (open-meteo) | **155 ms** | 158 ms | 156 ms | no-browser fast path (public JSON API) |
| `browse → read` (example.com) | **326 ms** | 366 ms | 327 ms | create → navigate → read → release |
| `scrape` (example.com) | **923 ms** | 945 ms | 928 ms | includes anvil's ~600 ms client-render settle |

Reproduce: `BENCH_RUNS=20 npm run bench:latency`. Figures are localhost (VM-local anvil is the
deploy target, so this reflects the real topology — Relay/DataFaucet and anvil on the same host).

**Takeaway:** sub-second for every errand; the fast path is ~155 ms. This is competitive with a
hosted vendor's network round-trip, and on the deploy topology (co-located) it avoids the extra
public-internet hop a remote vendor adds.

## Cost model (reproducible — plug in verified prices)

Vendor browser services meter **per session** or **per browser-minute**. Self-hosted anvil on an
**Oracle Cloud Always Free** VM has **$0 marginal infra cost** — the compute is already paid for
(free tier), so the per-session cost is **$0** up to the box's concurrency ceiling.

Cost per 1,000 sessions:

```
vendor_cost_1k   = 1000 × price_per_session
                 (or, for per-minute pricing: 1000 × avg_session_minutes × price_per_minute)
selfhosted_cost_1k = 0            # Oracle Always Free VM, within its resource limits
```

**Worked example** — plug in the vendor's *current* published price (verify before quoting;
figures below are illustrative placeholders, **not** a live quote):

| Assumption | Value (verify) |
|------------|----------------|
| vendor price per session | `$P` (e.g. a few cents/session on published tiers, as-of the vendor's pricing page) |
| sessions/month | `N` |
| avg session length | our errands finish in **< 1 s** (see above), so per-minute plans bill the 1-minute floor |

- **Vendor:** `N × $P` per month, scaling linearly forever.
- **Self-hosted:** `$0` marginal on Always Free, until you exceed the VM (then one paid VM ≈ a
  fixed monthly step, still flat, not per-session).

**Break-even is immediate** on the free tier: any `N > 0` at any `P > 0` favors self-hosting on
marginal cost. The real question isn't marginal price — it's the fixed/ops cost below.

## The honest caveat

**Compute is the real cost, not the vendor's meter.** Self-hosting removes the per-session charge
and the quota, but you still run the Chrome fleet:

- **Concurrency ceiling.** One Always-Free VM handles a few concurrent sessions (tune
  `ANVIL_MAX_SESSIONS`); the vendor "handles" unbounded concurrency by charging for it. Past the
  free box you add VMs — a flat step cost, still far under linear per-session metering at volume.
- **Ops.** You own uptime, restarts, and Chrome upgrades. This portfolio offsets that with the
  operability + fault work: `npm run status` (health), `npm run preflight` (deploy GO/NO-GO),
  `installCrashHandlers` (auto-restart), graceful degradation (m14) — so the ops burden is
  bounded and observable, not a hidden tax.
- **Not free-as-in-magic.** The claim is *no per-call vendor meter and no quota ceiling*, on free
  infra, at acceptable (sub-second) latency — **proven** by the numbers above and the live e2e /
  fault drills. It is **not** "infinite browsers for $0."

## Bottom line

Self-hosted anvil delivers sub-second latency on every canonical errand and **removes the
per-session vendor meter entirely** — the marginal cost of a session is $0 on free infra. The
trade you accept is a concurrency ceiling and ops ownership, both bounded and instrumented here.
For the two products in this portfolio (a personal text-bot and a dev/MCP capture layer, neither
needing massive parallel browser fleets), that trade is clearly correct.

---
*Latency: `npm run bench:latency` (measured, this repo). Pricing: parameterized — substitute the
vendor's current published rate before quoting externally; do not cite the placeholder `$P`.*
