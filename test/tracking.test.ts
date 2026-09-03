import { describe, it, expect } from "vitest";
import { detectCarrier, trackingUrl, carrierName, parseTrackingRequest } from "../src/lib/tracking.js";

describe("detectCarrier (package-tracking-watcher)", () => {
  it("detects UPS 1Z numbers", () => {
    expect(detectCarrier("1Z999AA10123456784")).toBe("ups");
    expect(detectCarrier("1z 999 aa1 01 2345 6784")).toBe("ups"); // spaces + lowercase normalized
  });
  it("detects USPS (IMpb 9x + letter-prefixed intl)", () => {
    expect(detectCarrier("9400111899223817612345")).toBe("usps"); // 22-digit starting 94
    expect(detectCarrier("EC123456789US")).toBe("usps");           // SNN...US
  });
  it("detects FedEx digit lengths (12/15/20)", () => {
    expect(detectCarrier("123456789012")).toBe("fedex");
    expect(detectCarrier("123456789012345")).toBe("fedex");
  });
  it("detects DHL (10 digits / JJD)", () => {
    expect(detectCarrier("1234567890")).toBe("dhl");
    expect(detectCarrier("JJD0123456789")).toBe("dhl");
  });
  it("returns null for a non-tracking string", () => {
    expect(detectCarrier("hello there")).toBeNull();
    expect(detectCarrier("12345")).toBeNull();       // too short
    expect(detectCarrier("")).toBeNull();
  });
});

describe("trackingUrl", () => {
  it("builds the official carrier URL with the normalized number", () => {
    expect(trackingUrl("ups", "1Z999AA10123456784")).toBe("https://www.ups.com/track?tracknum=1Z999AA10123456784");
    expect(trackingUrl("usps", "9400 1118 9922 3817 6123 45")).toContain("tLabels=9400111899223817612345");
    expect(trackingUrl("fedex", "123456789012")).toContain("trknbr=123456789012");
    expect(trackingUrl("dhl", "1234567890")).toContain("tracking-id=1234567890");
  });
});

describe("carrierName", () => {
  it("maps to a human label", () => {
    expect(carrierName("ups")).toBe("UPS");
    expect(carrierName("fedex")).toBe("FedEx");
    expect(carrierName("usps")).toBe("USPS");
    expect(carrierName("dhl")).toBe("DHL");
  });
});

describe("parseTrackingRequest", () => {
  it("pulls a tracking number out of a free-text request + detects the carrier", () => {
    expect(parseTrackingRequest("where's my package 1Z999AA10123456784")).toEqual({ carrier: "ups", number: "1Z999AA10123456784" });
    expect(parseTrackingRequest("track 9400111899223817612345 please")).toEqual({ carrier: "usps", number: "9400111899223817612345" });
  });
  it("an explicitly named carrier overrides shape detection", () => {
    // 12 digits would shape-detect FedEx, but the user said USPS.
    expect(parseTrackingRequest("track my usps package 123456789012")).toEqual({ carrier: "usps", number: "123456789012" });
  });
  it("null when there's no tracking-number-shaped token", () => {
    expect(parseTrackingRequest("where is my order")).toBeNull();
    expect(parseTrackingRequest("track the news")).toBeNull();
  });
});
