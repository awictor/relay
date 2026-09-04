// Copied from mcp-forge (DataFaucet) src/lib/url-validator.ts — kept identical so
// SSRF fixes merge back. isUrlSafe() + safeFetch() (redirect re-validation) +
// DoH DNS-rebinding guard. Uses fetch/URL only — portable to any Node 18+ runtime.

const BLOCKED_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^::ffff:127\./,
  /^::ffff:7f/i,
  /^::ffff:10\./,
  /^::ffff:0?a/i,
  /^::ffff:192\.168\./,
  /^::ffff:c0a8:/i,
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./,
  /^::ffff:ac1/i,
  /^::ffff:169\.254\./,
  /^::ffff:a9fe:/i,
  /^::ffff:0\./,
  /^::ffff:0+:/i,
  // DEV-0460 (mcp-forge): cover the FULL IPv6 link-local (fe80::/10 = fe80–febf) + ULA (fc00::/7 =
  // fc00–fdff) ranges, not just their base prefixes. WHATWG serializes these to a bare hextet.
  /^fe[89ab]/i, // link-local fe80::/10
  /^f[cd]/i,    // unique-local fc00::/7 (fc00–fdff)
];

const BLOCKED_HOSTNAMES = [
  "localhost",
  "metadata.google.internal",
  "metadata.google",
  "[::1]",
  "[::]",
  "[0:0:0:0:0:0:0:1]",
  "[0:0:0:0:0:0:0:0]",
  "0.0.0.0",
];

/** True if a bare IP string falls in a blocked (private/loopback/link-local) range. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  return BLOCKED_IP_RANGES.some((p) => p.test(bare));
}

/**
 * DNS-rebinding guard: resolve a hostname via DoH and check every A/AAAA record
 * against the blocklist. Catches public names that resolve to internal IPs
 * (e.g. localtest.me -> 127.0.0.1). Edge-runtime safe (uses fetch, not node:dns).
 * Fails CLOSED on resolver error/timeout (DEV-0211): the hosted executor runs on cloud infra where
 * the metadata endpoint (169.254.169.254) is reachable, so an attacker could force a DoH timeout to
 * bypass the rebind check. If the resolver is unavailable we now BLOCK rather than allow. A query()
 * returns null on error (vs [] for a clean empty answer); when BOTH A and AAAA fail, we can't verify
 * the host is safe, so fail closed. Residual TOCTOU (record flips between resolve and fetch) remains —
 * that needs full IP pinning, tracked separately.
 */
export async function hostResolvesToBlockedIp(hostname: string, signal?: AbortSignal): Promise<boolean> {
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  // Literal IPs are already covered by isUrlSafe; skip the lookup.
  if (/^[\d.]+$/.test(h) || h.includes(":")) return false;
  async function query(type: "A" | "AAAA"): Promise<string[] | null> {
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=${type}`, {
        headers: { Accept: "application/dns-json" },
        signal: signal ?? AbortSignal.timeout(3000),
      });
      if (!r.ok) return null; // resolver error -> unknown, not "clean empty"
      const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
      return (j.Answer || []).filter((a) => a.type === (type === "A" ? 1 : 28)).map((a) => a.data);
    } catch {
      return null; // timeout / network -> unknown
    }
  }
  const a = await query("A");
  const aaaa = await query("AAAA");
  // DEV-0459 (mcp-forge): fail closed PER-FAMILY — if EITHER A or AAAA errors we can't verify that
  // family, and fetch may prefer the unvalidated one (clean-A / errored-AAAA -> loopback over IPv6).
  if (a === null || aaaa === null) return true;
  const ips = [...a, ...aaaa];
  return ips.some((ip) => isBlockedIp(ip));
}

export function isUrlSafe(urlString: string): { safe: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: "Invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }

  // Strip a fully-qualified trailing dot ("localhost." / "127.0.0.1.") — DNS treats it as the same
  // host, so it must not slip past the exact-match blocklist (m26 safety-audit-1).
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");

  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    return { safe: false, reason: `Blocked hostname: ${hostname}` };
  }

  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  for (const pattern of BLOCKED_IP_RANGES) {
    if (pattern.test(bare)) {
      return { safe: false, reason: `Blocked IP range: ${hostname}` };
    }
  }

  if (/^0x[0-9a-f]+$/i.test(hostname) || /^\d{4,}$/.test(hostname) || /^0\d+$/.test(hostname)) {
    return { safe: false, reason: `Blocked numeric IP encoding: ${hostname}` };
  }

  // DEV-0461 (mcp-forge): + container/orchestrator control-plane daemons (Docker 2375/2376, etcd 2380,
  // k8s API 6443, kubelet 10250/10255) — never a legitimate public API target. App ports stay allowed.
  const BLOCKED_PORTS = [22, 23, 25, 465, 587, 2375, 2376, 2379, 2380, 3306, 3389, 4369, 5432, 5433, 6379, 6380, 6381, 6443, 8500, 9200, 9201, 9300, 10250, 10255, 11211, 15672, 27017, 27018];
  if (parsed.port && !["80", "443", ""].includes(parsed.port)) {
    const port = parseInt(parsed.port);
    if (port < 1024 && port !== 80 && port !== 443) {
      return { safe: false, reason: `Blocked privileged port: ${port}` };
    }
    if (BLOCKED_PORTS.includes(port)) {
      return { safe: false, reason: `Blocked internal service port: ${port}` };
    }
  }

  return { safe: true };
}

/**
 * SSRF-safe fetch: validates the initial URL AND every redirect hop against
 * isUrlSafe(). Throws "Blocked request: ..." if any hop fails validation.
 */
// A default User-Agent for outbound requests (DEV-0332). Several public APIs (Reddit's .json, some
// GitHub/registry endpoints) reject a missing/default-runtime UA from datacenter IPs with 403/429.
// Only applied when the caller/template didn't set its own User-Agent, so an explicit one still wins.
const DEFAULT_USER_AGENT = "datafaucet-mcp/1.0 (+https://datafaucet.dev)";

function withDefaultUserAgent<T extends RequestInit>(init: T): T {
  const h = new Headers(init.headers);
  if (!h.has("user-agent")) h.set("User-Agent", DEFAULT_USER_AGENT);
  return { ...init, headers: h };
}

export async function safeFetch(url: string, init: RequestInit & { signal?: AbortSignal }, maxRedirects = 5): Promise<Response> {
  let current = url;
  init = withDefaultUserAgent(init);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = isUrlSafe(current);
    if (!check.safe) throw new Error(`Blocked request: ${check.reason}`);

    const host = new URL(current).hostname;
    if (await hostResolvesToBlockedIp(host, init.signal ?? undefined)) {
      throw new Error(`Blocked request: hostname resolves to a private IP: ${host}`);
    }

    const res = await fetch(current, { ...init, redirect: "manual" });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      res.body?.cancel();
      const nextUrl = new URL(loc, current); // resolve relative redirects
      // Strip credentials on a CROSS-ORIGIN redirect (DEV-0385/DEV-0403): headers are re-used on every
      // hop, so any credential would otherwise leak to whatever host the upstream redirects to. Deleting
      // only authorization+cookie missed header-based auth (X-API-Key, apikey, private-token, …). Fail
      // closed: on a cross-origin hop, keep only a small safe-public allowlist. Same-origin keeps all.
      if (nextUrl.origin !== new URL(current).origin) {
        const SAFE_CROSS_ORIGIN = new Set([
          "accept", "accept-charset", "accept-encoding", "accept-language",
          "content-type", "user-agent", "referer",
        ]);
        const src = new Headers(init.headers);
        const h = new Headers();
        for (const [k, v] of src) if (SAFE_CROSS_ORIGIN.has(k.toLowerCase())) h.set(k, v);
        init = { ...init, headers: h };
      }
      current = nextUrl.toString();
      continue;
    }
    return res;
  }
  throw new Error("Blocked request: too many redirects");
}
