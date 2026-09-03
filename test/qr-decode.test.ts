import { describe, it, expect } from "vitest";
import { readQrUrl, parseQrRead, readQrFromBytes } from "../src/lib/qr-decode.js";

describe("parseQrRead", () => {
  it("pulls the decoded payload from a qrserver read response", () => {
    const body = JSON.stringify([{ type: "qrcode", symbol: [{ seq: 0, data: "WIFI:S:home;T:WPA;P:secret;;", error: null }] }]);
    expect(parseQrRead(body)).toBe("WIFI:S:home;T:WPA;P:secret;;");
  });
  it("null when no code is readable (data:null + error)", () => {
    const body = JSON.stringify([{ symbol: [{ seq: 0, data: null, error: "not found" }] }]);
    expect(parseQrRead(body)).toBeNull();
    expect(parseQrRead("nonsense")).toBeNull();
    expect(parseQrRead("[]")).toBeNull();
  });
});

describe("readQrFromBytes (injected POST)", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
  it("posts to the read endpoint + returns the decoded payload", async () => {
    let gotUrl = "";
    const out = await readQrFromBytes(bytes, async (url) => { gotUrl = url; return JSON.stringify([{ symbol: [{ data: "https://x.com", error: null }] }]); });
    expect(gotUrl).toBe(readQrUrl());
    expect(out).toBe("https://x.com");
  });
  it("null on empty bytes or a failed POST (caller falls back)", async () => {
    expect(await readQrFromBytes(new Uint8Array(), async () => "")).toBeNull();
    expect(await readQrFromBytes(bytes, async () => { throw new Error("net"); })).toBeNull();
  });
});
