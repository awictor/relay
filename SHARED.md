# Shared code across Relay + DataFaucet

*Part of the [portfolio](PORTFOLIO.md).* Relay and DataFaucet share browser + safety logic. This is
the map of **which files are shared and how**, so an edit lands in the right place(s) and the two
repos don't silently drift (the m26/m27 safety audit found exactly that kind of drift).

Repos sit side by side: `relay/` and `mcp-forge/` (DataFaucet) under one parent dir.

## 1. Vendored-identical, parity-guarded

**`src/lib/anvil-client.ts`** — the canonical anvil connect logic (session-URL builder +
transient-error taxonomy). Relay is the source of truth; DataFaucet holds a byte-identical copy.
A **parity test in both repos** fails if they diverge (`test/anvil-client-parity.test.ts` in Relay,
`tests/unit/anvil-client-parity.test.ts` in DataFaucet). **To change: edit the Relay copy, copy to
DataFaucet, both parity tests pass.** This is the only pair with an automated drift guard.

## 2. Copied-and-must-mirror (kept identical by hand, no automated guard yet)

These were copied from DataFaucet and are meant to stay logically identical so a fix in one merges
back. There's **no parity test**, so a change in one repo must be manually mirrored to the other
(on `anvil-migration` for DataFaucet, never master):

- **`src/lib/url-validator.ts`** — SSRF guard (`isUrlSafe` + `safeFetch` + DoH rebinding check).
  Logic is identical across repos (only docstring wording differs). The m26 trailing-dot fix was
  mirrored in m27 (`vendor-1`).
- **`src/lib/redact-secrets.ts`** — recursive by-key secret redaction (`redactSecretsDeep` +
  `SENSITIVE_KEY_RE`). The key matcher is now identical after m27 (`vendor-2`) aligned DataFaucet to
  Relay's superset (`authorization|^auth$|_auth$|bearer`). Minor comment/style differences remain;
  the security-relevant regex is the same.

> Candidate follow-up: add a parity test for these two pairs like anvil-client has, to make the
> "kept identical" contract enforced rather than manual.

## 3. Relay-local (NOT shared — do not expect these in DataFaucet)

- **`src/safety.ts`** — Relay's agent safety layer: `isDangerousAction` (`DANGEROUS_ACTION_RE`),
  `redactText` (free-text key masking incl. Gemini `AQ.`/`AIza`, Anthropic `sk-ant-`, Telegram bot
  tokens), and the per-chat `checkRateLimit`. These gate the **agent's** browsing/replies and have no
  DataFaucet equivalent — the m26 `AQ.`/`sk-ant` redaction additions live here and needed no mirror.
- Everything else under `src/` (agent loop, channels, scheduler, recipes, digests, alerts, handler,
  llm adapters) is Relay's own product surface.

## Rule of thumb
Editing a file in §1 → also update the other repo's copy (parity test enforces). §2 → also mirror by
hand to `anvil-migration`. §3 → Relay only. When unsure, check the file's header comment — each says
whether it's canonical, copied, or local.
