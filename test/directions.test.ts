import { describe, it, expect } from "vitest";
import { osrmUrl, routeMode, parseOsrm, formatRoute, getDirections } from "../src/lib/directions.js";

describe("routeMode (directions-eta)", () => {
  it("picks a mode from phrasing, default driving", () => {
    expect(routeMode("how long to walk to the park")).toBe("walking");
    expect(routeMode("bike to work")).toBe("cycling");
    expect(routeMode("how far is the airport")).toBe("driving");
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
      .toBe("your location → SFO: 10.0 mi, ~25 min drive.");
  });
  it("metric + hours for a long route + walk verb", () => {
    expect(formatRoute({ fromLabel: "A", toLabel: "B", distanceKm: 8, durationMin: 95, mode: "walking" }, "metric"))
      .toBe("A → B: 8.0 km, ~1h 35m walk.");
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
