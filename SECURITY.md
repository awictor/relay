# Relay security model

*Part of the [portfolio](PORTFOLIO.md).* Relay drives a **real browser** on behalf of anyone who
texts the bot, so the safety controls below bound the blast radius. Each is unit-tested, including
an adversarial sweep (m26) that tries to bypass it.

## Controls

### 1. SSRF guard — `src/lib/url-validator.ts` (`isUrlSafe` + `safeFetch`)
Every URL the agent fetches (scrape/browse/extract/compare/search/fetch_json/screenshot/pdf) is
validated first, and **`safeFetch` re-validates every redirect hop** + does a DoH DNS-rebinding
check. Blocks: loopback/private/link-local IPv4 + IPv6 (incl. IPv4-mapped, ULA `fc00::/7`,
link-local `fe80::`), cloud metadata (`169.254.169.254`, `metadata.google.internal`), numeric IP
encodings (decimal / hex / octal / dotted-octal), non-`http(s)` protocols (`file:`/`gopher:`/
`data:`/`ftp:`), embedded-credential hosts, trailing-dot FQDN tricks, and privileged / internal
service ports (SSH, Redis, Postgres, Mongo, Elasticsearch, …). Adversarial sweep:
`test/ssrf-adversarial.test.ts` (31 shapes).

### 2. Dangerous-action guard — `src/safety.ts` (`isDangerousAction`)
Before the agent clicks or types, the target label is checked against a committing/destructive verb
set (pay, buy, purchase, checkout, order, subscribe, bid, add to cart, book, donate, submit,
confirm, delete, remove, transfer, withdraw, logout, deactivate, …). A match is **refused** and the
agent is told to hand back to the user. Sweep: `test/dangerous-action-adversarial.test.ts`.
**Accepted limit:** a regex can't judge semantic intent — a homoglyph/obfuscated label could slip.
The backstops are the step cap (below), the reply-only-when-done flow, and that anvil sessions are
ephemeral + unauthenticated to the user's real accounts unless they log in themselves.

### 3. Secret redaction — `src/safety.ts` (`redactText`, `redactObject`)
Anything logged or echoed to a user is scrubbed of key/token shapes the system actually handles:
`Bearer …`, Gemini `AIza…` and `AQ.…`, Anthropic `sk-ant-…`, generic `sk-…`, Telegram bot tokens
(`\d{8,10}:AA…`), and long hex. Sweep: `test/redaction-adversarial.test.ts`. So a scraped page or a
user paste containing a credential doesn't leak into logs or a reply.

### 4. Per-chat rate limit — `src/safety.ts` (`checkRateLimit`)
Sliding 60s window per chat (`RELAY_RATE_LIMIT_PER_MIN`, default 10). Verified reset-resistant:
hammering during the window does not clear it; it recovers only after the window elapses.

### 5. Step / time caps — `src/agent.ts`
The agent loop is bounded by `RELAY_MAX_STEPS` (default 8) and every anvil call has a timeout, so a
task can't loop or hang indefinitely. anvil itself enforces per-session page caps + a session
timeout.

## Reporting
This is a personal/portfolio project; there is no formal disclosure process. The controls above are
the security surface — see the linked tests for exactly what each is proven to catch.
