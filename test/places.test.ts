import { describe, it, expect } from "vitest";
import { categoryFilters, haversineKm, overpassQuery, parseNominatim, parseNominatimAll, pickNominatim, parsePlaces, formatPlaces, findNearby } from "../src/lib/places.js";

describe("categoryFilters (near-me-poi)", () => {
  it("maps common words to OSM tags, stripping filler", () => {
    expect(categoryFilters("coffee").tags).toEqual(["amenity=cafe"]);
    expect(categoryFilters("nearest pharmacy").tags).toEqual(["amenity=pharmacy"]);
    expect(categoryFilters("a good gas station").tags).toEqual(["amenity=fuel"]);
  });
  it("falls back to a broad amenity+shop search for an unknown category", () => {
    const f = categoryFilters("blacksmith");
    expect(f.tags).toEqual(["amenity", "shop"]);
    expect(f.label).toBe("blacksmith");
  });
  it("matches on word boundaries + strips 'here'/'around here' so a short key can't hit inside a filler word (places-category-substring)", () => {
    // Regression: "atm around here" resolved to HOSPITAL because the short key "er" matched inside "here".
    expect(categoryFilters("atm around here").tags).toEqual(["amenity=atm"]);
    expect(categoryFilters("atm right now").tags).toEqual(["amenity=atm"]);
    // longer/multi-word key wins over a partial: "gas station" > "gas"; "hardware store" isn't "store"
    expect(categoryFilters("closest gas station").label).toBe("gas station");
    expect(categoryFilters("hardware store").tags).toEqual(["shop=hardware", "shop=doityourself"]);
    // a trailing plural still matches the singular key
    expect(categoryFilters("restaurants nearby").tags).toEqual(["amenity=restaurant"]);
    expect(categoryFilters("banks near me").tags).toEqual(["amenity=bank"]);
  });
});

describe("haversineKm", () => {
  it("computes a sane distance (Austin ~ downtown to airport ~11km)", () => {
    const d = haversineKm(30.2672, -97.7431, 30.1975, -97.6664);
    expect(d).toBeGreaterThan(9); expect(d).toBeLessThan(13);
  });
  it("zero for same point", () => { expect(haversineKm(1, 2, 1, 2)).toBeCloseTo(0); });
});

describe("overpassQuery", () => {
  it("builds an around: query with name filter per tag", () => {
    const q = overpassQuery(30, -97, ["amenity=cafe"], 3000);
    expect(q).toContain('node["amenity"="cafe"]["name"](around:3000,30,-97);');
  });
  it("a bare key selects any node with that key + a name", () => {
    expect(overpassQuery(1, 2, ["shop"], 500)).toContain('node["shop"]["name"](around:500,1,2);');
  });
});

describe("parseNominatim", () => {
  it("pulls the first result's lat/lng", () => {
    expect(parseNominatim(JSON.stringify([{ lat: "30.27", lon: "-97.74" }]))).toEqual({ lat: 30.27, lng: -97.74 });
  });
  it("null on empty / bad", () => {
    expect(parseNominatim("[]")).toBeNull();
    expect(parseNominatim("nope")).toBeNull();
  });
});

describe("pickNominatim (geo-tools-disambiguate-coords)", () => {
  // Two "Springfield"s: IL (top) and MA.
  const cands = [{ lat: 39.80, lng: -89.64 }, { lat: 42.10, lng: -72.59 }];
  it("no bias -> top (relevance) result", () => {
    expect(pickNominatim(cands)).toEqual({ lat: 39.80, lng: -89.64 });
  });
  it("biases to the candidate near the user's coords (within 250km)", () => {
    // Near Boston -> Springfield MA (~130km) beats Springfield IL (top).
    expect(pickNominatim(cands, { lat: 42.36, lng: -71.06 })).toEqual({ lat: 42.10, lng: -72.59 });
  });
  it("falls back to top when nothing is near the bias", () => {
    expect(pickNominatim(cands, { lat: 51.5, lng: -0.1 })).toEqual({ lat: 39.80, lng: -89.64 });
  });
  it("parseNominatimAll returns all candidates; empty -> null pick", () => {
    expect(parseNominatimAll(JSON.stringify([{ lat: "1", lon: "2" }, { lat: "3", lon: "4" }]))).toHaveLength(2);
    expect(pickNominatim([])).toBeNull();
  });
});

describe("parsePlaces", () => {
  const body = JSON.stringify({ elements: [
    { lat: 30.001, lon: -97.0, tags: { name: "Far Cafe", amenity: "cafe" } },
    { lat: 30.0001, lon: -97.0, tags: { name: "Near Cafe", amenity: "cafe", opening_hours: "7-19", phone: "555" } },
    { lat: 30.0, lon: -97.0, tags: { amenity: "cafe" } }, // no name -> dropped
    { lat: 30.0002, lon: -97.0, tags: { name: "Near Cafe", amenity: "cafe" } }, // dup name -> dropped
  ] });
  it("sorts by distance, drops nameless + dups, carries hours/phone", () => {
    const p = parsePlaces(body, 30.0, -97.0, "coffee", 5);
    expect(p.map((x) => x.name)).toEqual(["Near Cafe", "Far Cafe"]); // nearest first
    expect(p[0]!.openHours).toBe("7-19");
    expect(p[0]!.phone).toBe("555");
  });
});

describe("formatPlaces", () => {
  it("renders a list in miles by default", () => {
    const out = formatPlaces([{ name: "Zen", category: "cafe", distanceKm: 1.60934, openHours: "7-19", lat: 30.27, lng: -97.74 }], "coffee");
    expect(out).toMatch(/Nearby coffee:/);
    expect(out).toMatch(/Zen \(1\.0mi\) — 7-19/);
    expect(out).toContain("https://www.google.com/maps/search/?api=1&query=30.27%2C-97.74"); // tappable pin (maps-link-on-nearby-directions)
  });
  it("uses a name search link when a place has no coords", () => {
    const out = formatPlaces([{ name: "Blue Bottle", category: "cafe", distanceKm: 0.5 }], "coffee");
    expect(out).toContain("https://www.google.com/maps/search/?api=1&query=Blue%20Bottle");
  });
  it("empty -> a friendly none line", () => {
    expect(formatPlaces([], "sushi")).toMatch(/couldn't find any sushi nearby/i);
  });
  it("with a local time, tags open/closed-now + lists open places first (nearby-open-now)", () => {
    // Mon 9pm (dow=1, mins=1260). A closer place is already closed; a farther one is still open.
    const places = [
      { name: "Early Pharmacy", category: "pharmacy", distanceKm: 0.3, openHours: "Mo-Fr 08:00-18:00" },
      { name: "Night Pharmacy", category: "pharmacy", distanceKm: 1.2, openHours: "Mo-Su 08:00-23:00" },
    ];
    const out = formatPlaces(places, "pharmacy", "imperial", { dow: 1, mins: 1260 });
    expect(out).toMatch(/Night Pharmacy.*open now/); // open one shown
    expect(out).toMatch(/Early Pharmacy.*closed now/); // closed one tagged, not raw hours
    // Open place listed BEFORE the closer-but-closed one.
    expect(out.indexOf("Night Pharmacy")).toBeLessThan(out.indexOf("Early Pharmacy"));
  });
  it("without a local time, shows raw hours (back-compat)", () => {
    const out = formatPlaces([{ name: "Zen", category: "cafe", distanceKm: 1, openHours: "Mo-Fr 08:00-18:00" }], "coffee");
    expect(out).toMatch(/— Mo-Fr 08:00-18:00/);
    expect(out).not.toMatch(/open now|closed now/);
  });
});

describe("findNearby (injected fetch)", () => {
  it("geocodes a named area then queries Overpass (POST)", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchText = async (url: string, body?: string) => {
      calls.push({ url, body });
      if (url.includes("nominatim")) return JSON.stringify([{ lat: "30.0", lon: "-97.0" }]);
      return JSON.stringify({ elements: [{ lat: 30.001, lon: -97.0, tags: { name: "Cafe X", amenity: "cafe" } }] });
    };
    const r = await findNearby({ what: "coffee", near: "downtown Austin" }, fetchText);
    expect("places" in r && r.places[0]!.name).toBe("Cafe X");
    expect(calls[0]!.url).toContain("nominatim");
    expect(calls[1]!.body).toContain("around:"); // Overpass query POSTed
  });
  it("uses coords directly (no geocode) + [] places on fetch failure", async () => {
    let geocoded = false;
    const r = await findNearby({ what: "coffee", lat: 30, lng: -97 }, async (url) => {
      if (url.includes("nominatim")) { geocoded = true; return "[]"; }
      return JSON.stringify({ elements: [{ lat: 30.001, lon: -97, tags: { name: "C", amenity: "cafe" } }] });
    });
    expect(geocoded).toBe(false);
    expect("places" in r && r.places).toHaveLength(1);
    const fail = await findNearby({ what: "coffee", lat: 30, lng: -97 }, async () => { throw new Error("net"); });
    expect("places" in fail && fail.places).toEqual([]);
  });
  it("returns an area_not_found error when the named area can't be geocoded (find-nearby-radius-expand)", async () => {
    const r = await findNearby({ what: "coffee", near: "Xyzzyville" }, async (url) => url.includes("nominatim") ? "[]" : "{}");
    expect(r).toEqual({ error: "area_not_found" });
  });
  it("expands the radius until results appear (nearest-X not a false-negative)", async () => {
    const radii: number[] = [];
    const r = await findNearby({ what: "hospital", lat: 30, lng: -97 }, async (url, body) => {
      if (body) {
        const m = body.match(/around:(\d+)/); if (m) radii.push(Number(m[1]));
        // Empty at 3km + 10km; a hit only at 30km.
        return radii[radii.length - 1] === 30000
          ? JSON.stringify({ elements: [{ lat: 30.2, lon: -97, tags: { name: "Mercy Hospital", amenity: "hospital" } }] })
          : JSON.stringify({ elements: [] });
      }
      return "[]";
    });
    expect(radii).toEqual([3000, 10000, 30000]); // climbed the ladder
    expect("places" in r && r.places[0]!.name).toBe("Mercy Hospital");
    expect("radiusKm" in r && r.radiusKm).toBe(30);
  });
});
