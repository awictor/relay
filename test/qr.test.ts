import { describe, it, expect } from "vitest";
import { parseQrRequest, qrUrl, renderQr } from "../src/lib/qr.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const NOT_PNG = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]); // "<html"

describe("parseQrRequest", () => {
  it("pulls the payload after 'qr code for/of'", () => {
    expect(parseQrRequest("make a QR code for https://x.com")).toBe("https://x.com");
    expect(parseQrRequest("qr code of hello world")).toBe("hello world");
    expect(parseQrRequest("generate a qr for WIFI:S:home;T:WPA;P:pw;;")).toBe("WIFI:S:home;T:WPA;P:pw;;");
  });
  it("handles a bare 'qr <payload>' and strips quotes + trailing please", () => {
    expect(parseQrRequest('QR "https://y.com" please')).toBe("https://y.com");
    expect(parseQrRequest("make me a qr code https://z.com")).toBe("https://z.com");
  });
  it("null when it isn't a QR ask or has no payload", () => {
    expect(parseQrRequest("what's the weather")).toBeNull();
    expect(parseQrRequest("make a qr code for")).toBeNull();
    expect(parseQrRequest("qr code")).toBeNull();
  });
  it("null for an over-long payload", () => {
    expect(parseQrRequest("qr for " + "a".repeat(1000))).toBeNull();
  });
});

describe("qrUrl", () => {
  it("builds a keyless api.qrserver.com URL with the encoded payload", () => {
    const u = qrUrl("https://x.com/a b");
    expect(u).toContain("https://api.qrserver.com/v1/create-qr-code/");
    expect(u).toContain("data=https%3A%2F%2Fx.com%2Fa%20b");
    expect(u).toContain("300x300");
  });
});

describe("renderQr (injected fetch)", () => {
  it("returns PNG bytes on a valid render", async () => {
    const out = await renderQr("https://x.com", async () => PNG);
    expect(out).toBe(PNG);
  });
  it("null when the fetch returns a non-PNG (an error page)", async () => {
    expect(await renderQr("https://x.com", async () => NOT_PNG)).toBeNull();
  });
  it("null on empty/over-long payload or a fetch throw (caller falls back)", async () => {
    expect(await renderQr("", async () => PNG)).toBeNull();
    expect(await renderQr("a".repeat(1000), async () => PNG)).toBeNull();
    expect(await renderQr("https://x.com", async () => { throw new Error("net"); })).toBeNull();
  });
});
