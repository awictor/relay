// Nearby places (near-me-poi): the onboarding promises "near me" + the location pin invites it, but
// there was no POI backend — the agent scraped a logged-out map shell. This resolves nearby places
// from the user's coords via keyless OpenStreetMap infra: Nominatim (name->coords when only a place
// name is given) + Overpass (POIs within a radius, by category). Pure parse/format helpers exported +
// unit-tested; the network fetch is injected so it runs offline. No key, no vendor.

import { openTag, isOpenNow } from "./openhours.js";

export interface Place { name: string; category: string; distanceKm: number; openHours?: string; phone?: string; lat?: number; lng?: number }

/** A tappable Google Maps link for a place (maps-link-on-nearby-directions): prefer exact coords
 * (drops a pin), else a name search. So a "coffee near me" row is navigable, not a dead end. Exported. */
export function mapsLink(name: string, lat?: number, lng?: number): string {
  if (typeof lat === "number" && typeof lng === "number") {
    return `https://www.google.com/maps/search/?api=1&query=${lat}%2C${lng}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;
}

// Map common user words to OSM tag filters for the Overpass query. Each entry is a list of
// key=value tag selectors OR'd together. A miss falls back to a broad amenity search.
const CATEGORY_TAGS: Record<string, string[]> = {
  coffee: ["amenity=cafe"], cafe: ["amenity=cafe"],
  restaurant: ["amenity=restaurant"], food: ["amenity=restaurant", "amenity=fast_food"], dinner: ["amenity=restaurant"], lunch: ["amenity=restaurant"],
  bar: ["amenity=bar", "amenity=pub"], pub: ["amenity=pub"], beer: ["amenity=bar", "amenity=pub"],
  pharmacy: ["amenity=pharmacy"], drugstore: ["amenity=pharmacy"],
  hospital: ["amenity=hospital"], er: ["amenity=hospital"], doctor: ["amenity=doctors", "amenity=clinic"],
  atm: ["amenity=atm"], bank: ["amenity=bank"],
  gas: ["amenity=fuel"], "gas station": ["amenity=fuel"], fuel: ["amenity=fuel"], petrol: ["amenity=fuel"],
  grocery: ["shop=supermarket", "shop=convenience"], supermarket: ["shop=supermarket"], store: ["shop=supermarket", "shop=convenience"],
  hotel: ["tourism=hotel"], gym: ["leisure=fitness_centre", "amenity=gym"],
  parking: ["amenity=parking"], park: ["leisure=park"], library: ["amenity=library"],
  hardware: ["shop=hardware", "shop=doityourself"], bakery: ["shop=bakery"], pizza: ["amenity=fast_food", "cuisine=pizza"],
};

/** Pick the OSM tag selectors for a free-text "what" (e.g. "coffee", "nearest pharmacy"). Falls back to
 * a general amenity+shop search when nothing matches. Exported for tests. */
export function categoryFilters(what: string): { tags: string[]; label: string } {
  // Strip locational filler INCLUDING "here"/"around here"/"right now" (places-category-substring): a bare
  // "here" left the short key "er" (hospital) matching inside it, so "atm around here" resolved to HOSPITAL.
  const w = what.toLowerCase()
    .replace(/\b(nearest|closest|nearby|near\s*me|near\s*here|around\s*here|round\s*here|over\s*here|right\s*now|near|around|a|an|the|some|good|best|find|me)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  // Match on WORD BOUNDARIES, not raw substring (so "er" doesn't hit "here"/"beer", "gas" doesn't hit
  // "gasket"). Try longer keys first so "gas station" beats "gas" + a multi-word key wins over a partial.
  const keys = Object.keys(CATEGORY_TAGS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i"); // trailing -s tolerated ("restaurants")
    if (re.test(w)) return { tags: CATEGORY_TAGS[key]!, label: key };
  }
  // Unknown category: search named amenities + shops broadly, filtered by name match downstream.
  return { tags: ["amenity", "shop"], label: w || "places" };
}

const R_EARTH_KM = 6371;
/** Haversine distance in km between two lat/lng points. Exported for tests. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R_EARTH_KM * 2 * Math.asin(Math.sqrt(s));
}

/** Build an Overpass QL query for POIs of the given tag selectors within `radiusM` of lat,lng. */
export function overpassQuery(lat: number, lng: number, tags: string[], radiusM: number): string {
  const clauses = tags.map((t) => {
    // A bare key ("amenity") -> any node with that key + a name; "k=v" -> that exact tag.
    const sel = t.includes("=") ? `["${t.split("=")[0]}"="${t.split("=")[1]}"]` : `["${t}"]`;
    return `node${sel}["name"](around:${radiusM},${lat},${lng});`;
  }).join("");
  return `[out:json][timeout:20];(${clauses});out body 60;`;
}
export function overpassUrl(): string { return "https://overpass-api.de/api/interpreter"; }
export function nominatimUrl(place: string): string {
  // Ask for several candidates (not limit=1) so an ambiguous name ("Springfield", "Washington") can be
  // disambiguated toward the user's region (geo-tools-disambiguate-coords) instead of the top global hit.
  return `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(place)}`;
}

/** Parse a Nominatim response into ALL candidates {lat,lng}, in the API's relevance order. */
export function parseNominatimAll(body: string): Array<{ lat: number; lng: number }> {
  try {
    const arr = JSON.parse(body) as Array<{ lat: string; lon: string }>;
    return (arr ?? [])
      .map((r) => ({ lat: parseFloat(r.lat), lng: parseFloat(r.lon) }))
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  } catch { return []; }
}

/** Pick the best geocode candidate: when the user's coords are known, prefer the nearest within
 * ~250km (a same-name place in their region), else the top (relevance) result. Exported for tests. */
export function pickNominatim(cands: Array<{ lat: number; lng: number }>, near?: { lat: number; lng: number }): { lat: number; lng: number } | null {
  if (!cands.length) return null;
  if (near) {
    const sorted = cands.map((c) => ({ c, d: haversineKm(near.lat, near.lng, c.lat, c.lng) })).sort((a, b) => a.d - b.d);
    if (sorted[0]!.d <= 250) return sorted[0]!.c;
  }
  return cands[0]!;
}

/** Back-compat: the single top candidate. */
export function parseNominatim(body: string): { lat: number; lng: number } | null {
  return parseNominatimAll(body)[0] ?? null;
}

/** Parse an Overpass response into Place[] sorted by distance from the origin, capped to `limit`. A
 * `nameFilter` (for unknown categories) keeps only elements whose name contains it. Exported for tests. */
export function parsePlaces(body: string, originLat: number, originLng: number, label: string, limit = 5, nameFilter?: string): Place[] {
  try {
    const obj = JSON.parse(body) as { elements?: Array<{ lat?: number; lon?: number; tags?: Record<string, string> }> };
    const out: Place[] = [];
    for (const el of obj.elements ?? []) {
      const name = el.tags?.name;
      if (!name || typeof el.lat !== "number" || typeof el.lon !== "number") continue;
      if (nameFilter && !name.toLowerCase().includes(nameFilter.toLowerCase())) continue;
      const t = el.tags!;
      const category = t.amenity || t.shop || t.tourism || t.leisure || label;
      out.push({
        name, category, lat: el.lat, lng: el.lon,
        distanceKm: haversineKm(originLat, originLng, el.lat, el.lon),
        ...(t.opening_hours ? { openHours: t.opening_hours } : {}),
        ...(t.phone || t["contact:phone"] ? { phone: t.phone || t["contact:phone"] } : {}),
      });
    }
    out.sort((a, b) => a.distanceKm - b.distanceKm);
    // De-dupe by name (Overpass can return a node + its building), keep the nearest.
    const seen = new Set<string>();
    return out.filter((p) => { const k = p.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
  } catch { return []; }
}

/** Format nearby places into a short human list, honoring the user's unit preference (mi vs km). When
 * `now` (the user's LOCAL day-of-week 0-6 + minutes-since-midnight) is given, each place is tagged
 * open/closed-now from its OSM hours (nearby-open-now) and OPEN places are listed first — so "pharmacy
 * near me" at 9pm doesn't lead with one that closed at 6. Without `now`, behaves as before (raw hours). */
export function formatPlaces(places: Place[], what: string, units: "metric" | "imperial" = "imperial", now?: { dow: number; mins: number }): string {
  if (!places.length) return `I couldn't find any ${what} nearby.`;
  const dist = (km: number) => units === "metric" ? `${km.toFixed(1)}km` : `${(km * 0.621371).toFixed(1)}mi`;
  // Rank open-first when we can evaluate hours (open=0, unknown=1, closed=2), keeping distance order within.
  const ranked = now
    ? [...places].map((p, i) => ({ p, i, r: p.openHours ? ({ open: 0, unknown: 1, closed: 2 } as const)[isOpenNow(p.openHours, now.dow, now.mins)] : 1 }))
        .sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p)
    : places;
  const lines = ranked.map((p) => {
    // Append a tappable maps link so the user can navigate, not just read a name + distance
    // (maps-link-on-nearby-directions). When we know the time, show a computed "open now"/"closed now"
    // tag instead of (or alongside) the raw OSM hours string.
    const tag = now ? openTag(p.openHours, now.dow, now.mins) : "";
    const hours = tag ? ` — ${tag}` : (p.openHours ? ` — ${p.openHours}` : "");
    return `• ${p.name} (${dist(p.distanceKm)})${hours}${p.phone ? ` — ${p.phone}` : ""}\n  ${mapsLink(p.name, p.lat, p.lng)}`;
  });
  return `Nearby ${what}:\n${lines.join("\n")}`;
}

// Radius ladder (metres): a "nearest X" that finds nothing at 3km expands so a hospital/ER 5km away
// isn't a dangerous false-negative (find-nearby-radius-expand). Stops once results appear or the ladder
// ends. Overridden by an explicit opts.radiusM (single pass at that radius).
const RADIUS_LADDER_M = [3000, 10000, 30000];

export interface NearbyResult { places: Place[]; radiusKm: number }
// A distinct outcome so the caller can tell "your area couldn't be found" from "nothing exists nearby".
export type NearbyOutcome = NearbyResult | { error: "area_not_found" | "no_origin" };

/**
 * Find nearby places. `fetchText` is injected (guarded GET/POST in prod, a fake in tests). When only a
 * place name is given (no coords), Nominatim geocodes it (disambiguated toward opts.bias). Expands the
 * search radius (3->10->30km) until it finds results, so "nearest X" doesn't false-negative just past
 * 3km. Returns {places,radiusKm} (places may be [] if nothing exists even at the widest radius), or an
 * {error} distinguishing a failed area lookup from a genuinely-empty result. Never throws.
 */
export async function findNearby(
  opts: { what: string; lat?: number; lng?: number; near?: string; bias?: { lat: number; lng: number }; radiusM?: number; units?: "metric" | "imperial"; limit?: number },
  fetchText: (url: string, body?: string) => Promise<string>,
): Promise<NearbyOutcome> {
  try {
    let { lat, lng } = opts;
    if ((lat === undefined || lng === undefined) && opts.near) {
      const geo = pickNominatim(parseNominatimAll(await fetchText(nominatimUrl(opts.near))), opts.bias);
      if (!geo) return { error: "area_not_found" }; // the named area itself couldn't be resolved
      lat = geo.lat; lng = geo.lng;
    }
    if (lat === undefined || lng === undefined) return { error: "no_origin" };
    const { tags, label } = categoryFilters(opts.what);
    const nameFilter = tags[0] === "amenity" ? label : undefined; // broad search -> filter by name
    // Explicit radius = a single pass; otherwise climb the ladder until something's found.
    const ladder = opts.radiusM ? [opts.radiusM] : RADIUS_LADDER_M;
    for (const radiusM of ladder) {
      const body = await fetchText(overpassUrl(), overpassQuery(lat, lng, tags, radiusM));
      const places = parsePlaces(body, lat, lng, label, opts.limit ?? 5, nameFilter);
      if (places.length) return { places, radiusKm: radiusM / 1000 };
    }
    return { places: [], radiusKm: ladder[ladder.length - 1]! / 1000 };
  } catch { return { places: [], radiusKm: (opts.radiusM ?? RADIUS_LADDER_M[RADIUS_LADDER_M.length - 1]!) / 1000 }; }
}
