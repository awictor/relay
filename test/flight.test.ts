import { describe, it, expect } from "vitest";
import {
  detectFlight, parseAdsbdbRoute, parseAdsbLive, adsbdbUrl, adsbLiveUrl, trackerLink, formatFlight, getFlight,
} from "../src/lib/flight.js";

const routeBody = (over: Record<string, unknown> = {}) => JSON.stringify({
  response: { flightroute: {
    callsign_iata: "AA100",
    airline: { name: "American Airlines" },
    origin: { iata_code: "JFK", municipality: "New York" },
    destination: { iata_code: "LHR", municipality: "London" },
    ...over,
  } },
});

describe("detectFlight", () => {
  it("detects a designator with a flight cue or when it stands alone", () => {
    expect(detectFlight("is AA100 on time")).toMatchObject({ iata: "AA100", airlineCode: "AA", number: "100" });
    expect(detectFlight("flight UA 83")).toMatchObject({ iata: "UA83" });
    expect(detectFlight("AA100")).toMatchObject({ iata: "AA100" });      // bare designator
    expect(detectFlight("when does DL215 land")).toMatchObject({ iata: "DL215" });
    expect(detectFlight("status of B6 622")).toMatchObject({ iata: "B6622", airlineCode: "B6" }); // letter+digit airline
  });
  it("treats 'where('s)' and 'track(ing)' as flight cues (flight-cue-where-track)", () => {
    expect(detectFlight("where's UA83")).toMatchObject({ iata: "UA83", number: "83" });
    expect(detectFlight("where is UA83")).toMatchObject({ iata: "UA83" });
    expect(detectFlight("track BA2490")).toMatchObject({ iata: "BA2490" });
    expect(detectFlight("tracking DL215")).toMatchObject({ iata: "DL215" });
    // a cue with NO flight-shaped token is still null (cue alone isn't a flight)
    expect(detectFlight("where's the nearest ATM")).toBeNull();
    expect(detectFlight("track my order")).toBeNull();
  });
  it("does NOT fire on a bare number, prose, or a no-cue mid-sentence match", () => {
    expect(detectFlight("what's 20% of 100")).toBeNull();
    expect(detectFlight("the meeting is at 3")).toBeNull();
    // "AA100" buried in a non-flight sentence with no cue -> not a flight
    expect(detectFlight("my membership number AA100 expired and I need help renewing it")).toBeNull();
  });
});

describe("parseAdsbdbRoute", () => {
  it("parses airline + origin/destination", () => {
    const r = parseAdsbdbRoute(routeBody())!;
    expect(r).toMatchObject({ iata: "AA100", airline: "American Airlines" });
    expect(r.origin).toMatchObject({ iata: "JFK", city: "New York" });
    expect(r.destination).toMatchObject({ iata: "LHR", city: "London" });
  });
  it("returns null on an unknown callsign or bad json", () => {
    expect(parseAdsbdbRoute(JSON.stringify({ response: "unknown callsign" }))).toBeNull();
    expect(parseAdsbdbRoute("not json")).toBeNull();
  });
});

describe("parseAdsbLive", () => {
  it("airborne with altitude/speed when ac present", () => {
    expect(parseAdsbLive(JSON.stringify({ ac: [{ alt_baro: 37000, gs: 480 }] }))).toEqual({ airborne: true, altFt: 37000, groundSpeedKt: 480 });
  });
  it("not airborne when ac empty / bad", () => {
    expect(parseAdsbLive(JSON.stringify({ ac: [] }))).toEqual({ airborne: false });
    expect(parseAdsbLive("nope")).toEqual({ airborne: false });
  });
  it("handles a non-numeric alt_baro (\"ground\") without inventing an altitude", () => {
    expect(parseAdsbLive(JSON.stringify({ ac: [{ alt_baro: "ground", gs: 0 }] }))).toEqual({ airborne: true, groundSpeedKt: 0 });
  });
});

describe("url builders", () => {
  it("use the ICAO callsign when the airline is known, IATA otherwise", () => {
    expect(adsbdbUrl({ iata: "AA100", airlineCode: "AA", number: "100" })).toContain("/AAL100");
    expect(adsbLiveUrl({ iata: "AA100", airlineCode: "AA", number: "100" })).toContain("/AAL100");
    // unknown airline code -> IATA fallback
    expect(adsbdbUrl({ iata: "ZZ9", airlineCode: "ZZ", number: "9" })).toContain("/ZZ9");
    expect(trackerLink({ iata: "AA100", airlineCode: "AA", number: "100" })).toContain("flight/AA100");
  });
});

describe("formatFlight (honest — no invented gate/delay)", () => {
  it("shows route + airborne + tracker link, never a gate", () => {
    const out = formatFlight({ iata: "AA100", airlineCode: "AA", number: "100" }, parseAdsbdbRoute(routeBody()), { airborne: true, altFt: 37000, groundSpeedKt: 480 });
    expect(out).toMatch(/American Airlines AA100/);
    expect(out).toMatch(/New York \(JFK\) → London \(LHR\)/);
    expect(out).toMatch(/In the air now/);
    expect(out).toMatch(/flightaware\.com\/live\/flight\/AA100/);
    expect(out).not.toMatch(/gate [A-Z0-9]/i); // never fabricates a gate
  });
  it("says not-airborne honestly when on the ground/scheduled", () => {
    const out = formatFlight({ iata: "AA100", airlineCode: "AA", number: "100" }, parseAdsbdbRoute(routeBody()), { airborne: false });
    expect(out).toMatch(/Not airborne right now/);
  });
});

describe("getFlight (injected fetch)", () => {
  it("returns route + live from the two keyless sources", async () => {
    const r = await getFlight({ iata: "AA100", airlineCode: "AA", number: "100" }, async (u) =>
      u.includes("adsbdb") ? routeBody() : JSON.stringify({ ac: [{ alt_baro: 35000, gs: 500 }] }));
    expect(r!.route!.airline).toBe("American Airlines");
    expect(r!.live).toMatchObject({ airborne: true, altFt: 35000 });
  });
  it("route-only still returns (live source empty)", async () => {
    const r = await getFlight({ iata: "AA100", airlineCode: "AA", number: "100" }, async (u) =>
      u.includes("adsbdb") ? routeBody() : JSON.stringify({ ac: [] }));
    expect(r!.route).toBeTruthy();
    expect(r!.live.airborne).toBe(false);
  });
  it("returns null when there's no route AND the live fetch throws (nothing to report)", async () => {
    const r = await getFlight({ iata: "ZZ9", airlineCode: "ZZ", number: "9" }, async (u) => {
      if (u.includes("adsbdb")) return JSON.stringify({ response: "unknown callsign" });
      throw new Error("net");
    });
    expect(r).toBeNull();
  });
});
