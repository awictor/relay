// Directions / travel time (directions-eta): "how far is the airport", "directions to X", "how long
// to drive to Denver" are advertised (the location-pin ack + LOCATION_ERRAND_RE) but had no backend —
// the agent scraped a JS map shell and returned nothing. This resolves both endpoints via Nominatim
// (reused from places.ts) and routes them via the keyless OSRM public server for distance + duration.
// Pure parse/format helpers exported + unit-tested; the network fetch is injected so it runs offline.
import { nominatimUrl, parseNominatimAll, pickNominatim } from "./places.js";

export interface Route { fromLabel: string; toLabel: string; distanceKm: number; durationMin: number; mode: "driving" | "walking" | "cycling" }

// OSRM public server. profile: driving/walking/cycling. Coords are lng,lat (OSRM order!).
export function osrmUrl(fromLat: number, fromLng: number, toLat: number, toLng: number, mode: Route["mode"]): string {
  const profile = mode === "walking" ? "foot" : mode === "cycling" ? "bike" : "car";
  return `https://router.project-osrm.org/route/v1/${profile}/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
}

/** Pick a travel mode from the user's phrasing (walk/bike/transit->driving fallback). */
export function routeMode(text: string): Route["mode"] {
  if (/\b(walk|walking|on foot)\b/i.test(text)) return "walking";
  if (/\b(bike|cycling|bicycle)\b/i.test(text)) return "cycling";
  return "driving";
}

/** Parse an OSRM route response -> {distanceKm, durationMin} (from routes[0]), or null. */
export function parseOsrm(body: string): { distanceKm: number; durationMin: number } | null {
  try {
    const obj = JSON.parse(body) as { code?: string; routes?: Array<{ distance?: number; duration?: number }> };
    if (obj.code && obj.code !== "Ok") return null;
    const r = obj.routes?.[0];
    if (!r || typeof r.distance !== "number" || typeof r.duration !== "number") return null;
    return { distanceKm: r.distance / 1000, durationMin: r.duration / 60 };
  } catch { return null; }
}

/** Render a route into a short human line honoring the unit preference (mi vs km). */
export function formatRoute(r: Route, units: "metric" | "imperial" = "imperial"): string {
  const dist = units === "metric" ? `${r.distanceKm.toFixed(1)} km` : `${(r.distanceKm * 0.621371).toFixed(1)} mi`;
  const h = Math.floor(r.durationMin / 60), m = Math.round(r.durationMin % 60);
  const time = h > 0 ? `${h}h ${m}m` : `${m} min`;
  const verb = r.mode === "walking" ? "walk" : r.mode === "cycling" ? "bike" : "drive";
  return `${r.fromLabel} → ${r.toLabel}: ${dist}, ~${time} ${verb}.`;
}

/**
 * Compute a route between two places. `fetchText` is injected (guarded GET in prod, a fake in tests).
 * `from` defaults to the user's coords when omitted (`fromLat`/`fromLng`). Each named endpoint is
 * geocoded via Nominatim. Returns null on a bad place / no route / fetch failure. Never throws.
 */
export async function getDirections(
  opts: { to: string; from?: string; fromLat?: number; fromLng?: number; bias?: { lat: number; lng: number }; mode?: Route["mode"]; units?: "metric" | "imperial" },
  fetchText: (url: string) => Promise<string>,
): Promise<Route | null> {
  try {
    const mode = opts.mode ?? "driving";
    // Resolve origin: explicit coords, else geocode `from`, else fail (caller asks for a start). `bias`
    // is a disambiguation HINT (the user's region) — it never overrides an explicit `from`.
    let fromLat = opts.fromLat, fromLng = opts.fromLng, fromLabel = "your location";
    if ((fromLat === undefined || fromLng === undefined) && opts.from) {
      const g = pickNominatim(parseNominatimAll(await fetchText(nominatimUrl(opts.from))), opts.bias);
      if (!g) return null;
      fromLat = g.lat; fromLng = g.lng; fromLabel = opts.from;
    }
    if (fromLat === undefined || fromLng === undefined) return null;
    // Resolve destination, biased toward the ORIGIN so an ambiguous "Springfield"/"Washington" resolves
    // to the nearest one to where they're starting, not a random same-name city.
    const dg = pickNominatim(parseNominatimAll(await fetchText(nominatimUrl(opts.to))), { lat: fromLat, lng: fromLng });
    if (!dg) return null;
    const route = parseOsrm(await fetchText(osrmUrl(fromLat, fromLng, dg.lat, dg.lng, mode)));
    if (!route) return null;
    return { fromLabel, toLabel: opts.to, distanceKm: route.distanceKm, durationMin: route.durationMin, mode };
  } catch { return null; }
}
