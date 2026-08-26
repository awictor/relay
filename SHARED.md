# Shared code across Relay + DataFaucet

*Part of the [portfolio](PORTFOLIO.md).* Relay and DataFaucet share browser + safety logic. This is
the map of **which files are shared and how**, so an edit lands in the right place(s) and the two
repos don't silently drift (the m26/m27 safety audit found exactly that kind of drift).

Repos sit side by side: `relay/` and `mcp-forge/` (DataFaucet) under one parent dir.

## 1. Shared, parity-guarded (drift fails CI in both repos)

- **`src/lib/anvil-client.ts`** — canonical anvil connect logic (session-URL builder +
  transient-error taxonomy). Relay is the source of truth; DataFaucet holds a **byte-identical** copy.
  Guarded by `test/anvil-client-parity.test.ts` (Relay) + `tests/unit/anvil-client-parity.test.ts`
  (DataFaucet).
- **`src/lib/url-validator.ts`** — SSRF guard (`isUrlSafe` + `safeFetch` + DoH rebinding check).
- **`src/lib/redact-secrets.ts`** — recursive by-key secret redaction (`redactSecretsDeep` +
  `SENSITIVE_KEY_RE`).

url-validator + redact-secrets are guarded by `test/shared-lib-parity.test.ts` (Relay) +
`tests/unit/shared-lib-parity.test.ts` (DataFaucet), added in m28. These use a **code-only** compare
(comments/whitespace stripped) rather than byte-identity, because each repo's header comment
legitimately differs; the executable code must match. **To change any file here: edit both copies
(DataFaucet on `anvil-migration`, never master) — the parity tests fail until they match.**

## 2. Relay-local (NOT shared — do not expect these in DataFaucet)

- **`src/safety.ts`** — Relay's agent safety layer: `isDangerousAction` (`DANGEROUS_ACTION_RE`),
  `redactText` (free-text key masking incl. Gemini `AQ.`/`AIza`, Anthropic `sk-ant-`, Telegram bot
  tokens), and the per-chat `checkRateLimit`. These gate the **agent's** browsing/replies and have no
  DataFaucet equivalent — the m26 `AQ.`/`sk-ant` redaction additions live here and needed no mirror.
- Everything else under `src/` (agent loop, channels, scheduler, recipes, digests, alerts, handler,
  llm adapters) is Relay's own product surface.

## Rule of thumb
Editing a file in §1 → also update the other repo's copy (DataFaucet on `anvil-migration`, never
master); the parity test enforces it, so a forgotten mirror fails CI. §2 → Relay only. When unsure,
check the file's header comment — each says whether it's canonical, copied, or local.
