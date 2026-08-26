import { describe, it, expect, afterEach, vi } from "vitest";
import { safeFetch } from "../src/lib/url-validator.js";

// DEV-0038: safeFetch re-validates EVERY redirect hop against isUrlSafe — a public URL that 30x-es
// to a private IP must be blocked, not followed. Only lightly touched before. Stub global fetch;
// use IP-literal hosts so hostResolvesToBlockedIp early-returns (no live DoH) — this isolates the
// redirect-revalidation logic. 127.0.0.1 is blocked by isUrlSafe, so the guard fires before any
// fetch to it.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

// A minimal Response-like: manual-redirect uses status + headers.get("location") + body?.cancel().
function redirectTo(loc: string) {
  return { status: 302, headers: { get: (k: string) => (k.toLowerCase() === "location" ? loc : null) }, body: { cancel() {} } } as unknown as Response;
}
function ok() {
  return { status: 200, headers: { get: () => null } } as unknown as Response;
}

describe("safeFetch redirect revalidation (DEV-0038)", () => {
  it("blocks a public URL that redirects to a private IP", async () => {
    // hop 0: public IP literal (isUrlSafe ok, DoH skipped for IP) -> fetch returns 302 to loopback
    globalThis.fetch = vi.fn().mockResolvedValue(redirectTo("http://127.0.0.1/x")) as unknown as typeof fetch;
    await expect(safeFetch("http://93.184.216.34/start", {})).rejects.toThrow(/Blocked request/);
  });

  it("follows a redirect to another public target and returns the final 200", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(redirectTo("http://93.184.216.35/next")) // hop 0 -> public
      .mockResolvedValueOnce(ok());                                    // hop 1 -> 200
    globalThis.fetch = f as unknown as typeof fetch;
    const res = await safeFetch("http://93.184.216.34/start", {});
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("returns a non-redirect response directly (no extra fetch)", async () => {
    const f = vi.fn().mockResolvedValue(ok());
    globalThis.fetch = f as unknown as typeof fetch;
    const res = await safeFetch("http://93.184.216.34/x", {});
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("throws on too many redirects (a public->public redirect loop)", async () => {
    // always 302 to a fresh public target -> exhausts maxRedirects
    let n = 100;
    globalThis.fetch = vi.fn().mockImplementation(async () => redirectTo(`http://93.184.216.${n--}/loop`)) as unknown as typeof fetch;
    await expect(safeFetch("http://93.184.216.34/start", {}, 3)).rejects.toThrow(/too many redirects/);
  });

  it("blocks the INITIAL url when it is already unsafe (no fetch attempted)", async () => {
    const f = vi.fn().mockResolvedValue(ok());
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(safeFetch("http://127.0.0.1/x", {})).rejects.toThrow(/Blocked request/);
    expect(f).not.toHaveBeenCalled();
  });
});
