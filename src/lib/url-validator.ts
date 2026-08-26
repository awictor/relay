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
  /^fc00:/i,
  /^fe80:/i,
  /^fd/i,
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
 * against the blocklist. Fails OPEN on resolver error/timeout.
 */
export async function hostResolvesToBlockedIp(hostname: string, signal?: AbortSignal): Promise<boolean> {
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (/^[\d.]+$/.test(h) || h.includes(":")) return false;
  async function query(type: "A" | "AAAA"): Promise<string[]> {
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=${type}`, {
        headers: { Accept: "application/dns-json" },
        signal: signal ?? AbortSignal.timeout(3000),
      });
      if (!r.ok) return [];
      const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
      return (j.Answer || []).filter((a) => a.type === (type === "A" ? 1 : 28)).map((a) => a.data);
    } catch {
      return []; // fail open
    }
  }
  const ips = [...(await query("A")), ...(await query("AAAA"))];
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

  const hostname = parsed.hostname.toLowerCase();

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

  const BLOCKED_PORTS = [22, 23, 25, 465, 587, 2379, 3306, 3389, 4369, 5432, 5433, 6379, 6380, 6381, 8500, 9200, 9201, 9300, 11211, 15672, 27017, 27018];
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
export async function safeFetch(url: string, init: RequestInit & { signal?: AbortSignal }, maxRedirects = 5): Promise<Response> {
  let current = url;
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
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("Blocked request: too many redirects");
}
