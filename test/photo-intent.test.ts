import { describe, it, expect } from "vitest";
import { photoNeedsAgent, photoIsQrScan } from "../src/lib/photo-intent.js";

describe("photoNeedsAgent (photo-to-action)", () => {
  it("routes action captions through the agent", () => {
    for (const c of [
      "split this receipt 3 ways with 20% tip",
      "how much do we each owe?",
      "convert these prices to USD",
      "translate this menu to English",
      "what's the cheapest vegetarian dish here",
      "how many calories in this",
      "look up this book",
      "is this safe to eat?",
    ]) expect(photoNeedsAgent(c), c).toBe(true);
  });
  it("keeps a plain describe/identify caption as one-shot vision", () => {
    for (const c of ["what is this?", "what's this", "describe this photo", "what do you see", "read this", "identify this", ""]) {
      expect(photoNeedsAgent(c), JSON.stringify(c)).toBe(false);
    }
  });
  it("an empty / whitespace caption is not actionable", () => {
    expect(photoNeedsAgent("   ")).toBe(false);
  });
});

describe("photoIsQrScan (read-qr-from-photo)", () => {
  it("recognizes a scan-QR caption", () => {
    for (const c of ["scan this QR code", "read the qr", "what's in this QR code?", "decode this", "scan this barcode", "open this qr code"]) {
      expect(photoIsQrScan(c), c).toBe(true);
    }
  });
  it("is false for a non-QR caption + empty", () => {
    for (const c of ["what is this?", "split this receipt", "", "describe this photo"]) {
      expect(photoIsQrScan(c), JSON.stringify(c)).toBe(false);
    }
  });
});
