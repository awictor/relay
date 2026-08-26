// Copied from mcp-forge (DataFaucet) src/lib/redact-secrets.ts — battle-tested,
// kept identical so fixes can be merged back. Recursive secret redaction: sensitive
// values are replaced anywhere in a nested object/array, matched by KEY NAME.

export const SENSITIVE_KEY_RE =
  /password|passwd|secret|token|api_key|apikey|access_token|refresh_token|private_key|client_secret|credential|credit_card|card_number|cvv|ssn|social_security/i;

export function redactSecretsDeep(
  node: unknown,
  replacement: (key: string) => unknown,
  keyRe: RegExp = SENSITIVE_KEY_RE
): unknown {
  if (Array.isArray(node)) return node.map((v) => redactSecretsDeep(v, replacement, keyRe));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = keyRe.test(k) ? replacement(k) : redactSecretsDeep(v, replacement, keyRe);
    }
    return out;
  }
  return node;
}

/** Redact a JSON (or urlencoded) body string. Returns the redacted string, or
 * the original if it isn't parseable JSON / urlencoded. */
export function redactBodyString(
  raw: string | undefined,
  replacement: (key: string) => string,
  keyRe: RegExp = SENSITIVE_KEY_RE
): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(redactSecretsDeep(parsed, replacement, keyRe));
    }
  } catch {
    /* not JSON — fall through to urlencoded handling */
  }
  if (raw.includes("=")) {
    return raw
      .split("&")
      .map((pair) => {
        const key = pair.split("=")[0] ?? "";
        return keyRe.test(key) ? `${key}=${replacement(key)}` : pair;
      })
      .join("&");
  }
  return raw;
}
