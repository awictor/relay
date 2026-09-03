// Nearby places (near-me-poi): the onboarding promises "near me" + the location pin invites it, but
// there was no POI backend — the agent scraped a logged-out map shell. This resolves nearby places
// from the user's coords via keyless OpenStreetMap infra: Nominatim (name->coords when only a place
// name is given) + Overpass (POIs within a radius, by category). Pure parse/format helpers exported +
// unit-tested; the network fetch is injected so it runs offline. No key, no vendor.

export interface Place { name: string; category: string; distanceKm: number; openHours?: string; phone?: string }

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
  const w = what.toLowerCase().replace(/\b(nearest|closest|nearby|near me|a|an|the|some|good|best|find)\b/g, " ").replace(/\s+/g, " ").trim();
  for (const key of Object.keys(CATEGORY_TAGS)) {
    if (w.includes(key)) return { tags: CATEGORY_TAGS[key]!, label: key };
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
  return `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`;
}

/** Parse a Nominatim response -> {lat,lng} or null. */
export function parseNominatim(body: string): { lat: number; lng: number } | null {
  try {
    const arr = JSON.parse(body) as Array<{ lat: string; lon: string }>;
    const r = arr?.[0];
    if (!r) return null;
    const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch { return null; }
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
        name, category,
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

/** Format nearby places into a short human list, honoring the user's unit preference (mi vs km). */
export function formatPlaces(places: Place[], what: string, units: "metric" | "imperial" = "imperial"): string {
  if (!places.length) return `I couldn't find any ${what} nearby.`;
  const dist = (km: number) => units === "metric" ? `${km.toFixed(1)}km` : `${(km * 0.621371).toFixed(1)}mi`;
  const lines = places.map((p) => {
    const bits = [`${p.name} (${dist(p.distanceKm)}`];
    return `• ${bits[0]})${p.openHours ? ` — ${p.openHours}` : ""}${p.phone ? ` — ${p.phone}` : ""}`;
  });
  return `Nearby ${what}:\n${lines.join("\n")}`;
}

/**
 * Find nearby places. `fetchText` is injected (guarded GET/POST in prod, a fake in tests). When only a
 * place name is given (no coords), Nominatim geocodes it first. Returns [] on failure. Never throws.
 * `radiusM` default 3km. The Overpass query is sent as the POST body via fetchPost when provided,
 * else appended as ?data= (GET) — the caller wires the right transport.
 */
export async function findNearby(
  opts: { what: string; lat?: number; lng?: number; near?: string; radiusM?: number; units?: "metric" | "imperial"; limit?: number },
  fetchText: (url: string, body?: string) => Promise<string>,
): Promise<Place[]> {
  try {
    let { lat, lng } = opts;
    if ((lat === undefined || lng === undefined) && opts.near) {
      const geo = parseNominatim(await fetchText(nominatimUrl(opts.near)));
      if (!geo) return [];
      lat = geo.lat; lng = geo.lng;
    }
    if (lat === undefined || lng === undefined) return [];
    const { tags, label } = categoryFilters(opts.what);
    const q = overpassQuery(lat, lng, tags, opts.radiusM ?? 3000);
    const body = await fetchText(overpassUrl(), q);
    const nameFilter = tags[0] === "amenity" ? label : undefined; // broad search -> filter by name
    return parsePlaces(body, lat, lng, label, opts.limit ?? 5, nameFilter);
  } catch { return []; }
}
