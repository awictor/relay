import { describe, it, expect } from "vitest";
import { osrmUrl, routeMode, parseOsrm, formatRoute, getDirections, wantsTransit, transitMapsLink } from "../src/lib/directions.js";

describe("routeMode (directions-eta)", () => {
  it("picks a mode from phrasing, default driving", () => {
    expect(routeMode("how long to walk to the park")).toBe("walking");
    expect(routeMode("bike to work")).toBe("cycling");
    expect(routeMode("how far is the airport")).toBe("driving");
  });
});

describe("wantsTransit (transit-honest-not-driving)", () => {
  it("detects public-transit asks", () => {
    for (const q of ["how long to downtown by subway", "bus to the airport", "train to Boston",
      "directions by transit", "metro to the museum", "take the tube to Camden", "public transport to X"]) {
      expect(wantsTransit(q)).toBe(true);
    }
  });
  it("does NOT fire on a plain drive/walk/how-do-I-get ask", () => {
    for (const q of ["how far is the airport", "directions to the park", "how do I get to downtown", "walk to work"]) {
      expect(wantsTransit(q)).toBe(false);
    }
  });
});

describe("transitMapsLink", () => {
  it("builds a travelmode=transit Maps link, coords when present else labels", () => {
    expect(transitMapsLink({ to: "Downtown", from: "Home" }))
      .toBe("https://www.google.com/maps/dir/?api=1&origin=Home&destination=Downtown&travelmode=transit");
    const withCoords = transitMapsLink({ to: "Museum", fromLat: 40.7, fromLng: -74 });
    expect(withCoords).toContain("origin=40.7%2C-74");
    expect(withCoords).toContain("travelmode=transit");
    // No from + no coords -> "My Location" origin.
    expect(transitMapsLink({ to: "X" })).toContain("origin=My%20Location");
  });
});

describe("osrmUrl", () => {
  it("uses lng,lat order + the right profile", () => {
    expect(osrmUrl(30, -97, 31, -96, "driving")).toBe("https://router.project-osrm.org/route/v1/car/-97,30;-96,31?overview=false");
    expect(osrmUrl(1, 2, 3, 4, "walking")).toContain("/foot/");
    expect(osrmUrl(1, 2, 3, 4, "cycling")).toContain("/bike/");
  });
});

describe("parseOsrm", () => {
  it("converts m->km and s->min from routes[0]", () => {
    const r = parseOsrm(JSON.stringify({ code: "Ok", routes: [{ distance: 11000, duration: 900 }] }))!;
    expect(r.distanceKm).toBe(11);
    expect(r.durationMin).toBe(15);
  });
  it("null on error code / no route / bad json", () => {
    expect(parseOsrm(JSON.stringify({ code: "NoRoute", routes: [] }))).toBeNull();
    expect(parseOsrm(JSON.stringify({ routes: [] }))).toBeNull();
    expect(parseOsrm("nope")).toBeNull();
  });
});

describe("formatRoute", () => {
  it("imperial by default (mi + verb)", () => {
    expect(formatRoute({ fromLabel: "your location", toLabel: "SFO", distanceKm: 16.0934, durationMin: 25, mode: "driving" }))
      .toBe("your location → SFO: 10.0 mi, ~25 min drive.\nhttps://www.google.com/maps/dir/?api=1&origin=your%20location&destination=SFO&travelmode=driving");
  });
  it("metric + hours for a long route + walk verb", () => {
    expect(formatRoute({ fromLabel: "A", toLabel: "B", distanceKm: 8, durationMin: 95, mode: "walking" }, "metric"))
      .toBe("A → B: 8.0 km, ~1h 35m walk.\nhttps://www.google.com/maps/dir/?api=1&origin=A&destination=B&travelmode=walking");
  });
  it("uses coords in the maps link when the route has them, driving travelmode", () => {
    const out = formatRoute({ fromLabel: "your location", toLabel: "SFO", distanceKm: 16, durationMin: 25, mode: "driving", fromLat: 37.77, fromLng: -122.42, toLat: 37.62, toLng: -122.38 });
    expect(out).toContain("origin=37.77%2C-122.42&destination=37.62%2C-122.38&travelmode=driving");
  });
});

describe("getDirections (injected fetch)", () => {
  it("geocodes both endpoints then routes (from coords)", async () => {
    const calls: string[] = [];
    const fetchText = async (url: string) => {
      calls.push(url);
      if (url.includes("nominatim")) return JSON.stringify([{ lat: "30.2", lon: "-97.7" }]);
      return JSON.stringify({ code: "Ok", routes: [{ distance: 11000, duration: 900 }] });
    };
    const r = await getDirections({ to: "the airport", fromLat: 30.26, fromLng: -97.74 }, fetchText);
    expect(r).toMatchObject({ fromLabel: "your location", toLabel: "the airport", distanceKm: 11, durationMin: 15, mode: "driving" });
    // Only the destination is geocoded (origin came from coords); then OSRM.
    expect(calls.filter((u) => u.includes("nominatim"))).toHaveLength(1);
    expect(calls.some((u) => u.includes("router.project-osrm.org"))).toBe(true);
  });
  it("geocodes a named `from` too", async () => {
    let geocodes = 0;
    const fetchText = async (url: string) => {
      if (url.includes("nominatim")) { geocodes++; return JSON.stringify([{ lat: "30", lon: "-97" }]); }
      return JSON.stringify({ code: "Ok", routes: [{ distance: 5000, duration: 600 }] });
    };
    const r = await getDirections({ to: "B", from: "A" }, fetchText);
    expect(geocodes).toBe(2); // from + to
    expect(r!.fromLabel).toBe("A");
  });
  it("null on unknown place / no route / fetch failure", async () => {
    expect(await getDirections({ to: "Nowhere", fromLat: 1, fromLng: 2 }, async () => "[]")).toBeNull();
    expect(await getDirections({ to: "X", fromLat: 1, fromLng: 2 }, async () => { throw new Error("net"); })).toBeNull();
  });
  it("disambiguates an ambiguous destination toward the origin (geo-tools-disambiguate-coords)", async () => {
    let osrmFrom = "", osrmTo = "";
    const fetchText = async (url: string) => {
      if (url.includes("nominatim")) return JSON.stringify([
        { lat: "39.80", lon: "-89.64" }, // Springfield IL (top)
        { lat: "42.10", lon: "-72.59" }, // Springfield MA
      ]);
      // OSRM url: /car/<fromLng>,<fromLat>;<toLng>,<toLat>
      const m = url.match(/car\/([^;]+);([^?]+)/)!;
      osrmFrom = m[1]!; osrmTo = m[2]!;
      return JSON.stringify({ code: "Ok", routes: [{ distance: 130000, duration: 6000 }] });
    };
    // Origin is Boston coords -> destination "Springfield" should resolve to MA (near origin), not IL.
    const r = await getDirections({ to: "Springfield", fromLat: 42.36, fromLng: -71.06 }, fetchText);
    expect(r).not.toBeNull();
    expect(osrmTo).toBe("-72.59,42.1"); // Springfield MA, not IL (-89.64,39.8)
  });
});
