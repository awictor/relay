// Unit inference (metric-imperial-infer): the weather/nearby/directions tools defaulted to IMPERIAL
// for the whole world when the user hadn't set a preference — so a London user's very first errand,
// "weather in Paris", came back in °F (wrong for ~95% of people) unless they knew to append "(metric)".
// The resolved place string already carries a country tail (Open-Meteo geocode: "Paris, Île-de-France,
// France"; Nominatim similar), so we can infer the right system from it. Only the three
// imperial-using countries (US, Liberia, Myanmar) get imperial; everything we can identify gets metric;
// anything we CAN'T place keeps the old imperial default (no regression for the common US-no-location
// case). Pure + unit-tested.

// The countries that actually use imperial/US-customary for everyday temp + distance. Matched as whole
// words against the (lowercased) place tail. "united states"/"usa"/"us"/"u.s." + Liberia + Myanmar/Burma.
const IMPERIAL_PATTERNS: RegExp[] = [
  /\bunited states\b/, /\bunited states of america\b/, /\bu\.?s\.?a?\.?\b/, /\busa\b/,
  /\bliberia\b/, /\bmyanmar\b/, /\bburma\b/,
];

/** Infer "metric" | "imperial" from a resolved place string (its country tail), or null when the place
 * gives no usable signal (empty, or no recognizable country — caller then keeps its own default).
 * Deliberately conservative: only a recognized imperial country returns "imperial"; any other
 * non-empty place returns "metric" (the world default). Exported for tests. */
export function inferUnitsFromPlace(place: string | undefined): "metric" | "imperial" | null {
  const p = String(place ?? "").toLowerCase().trim();
  if (!p) return null;
  if (IMPERIAL_PATTERNS.some((re) => re.test(p))) return "imperial";
  // A place we can read but that isn't an imperial country -> metric (covers the ~95% case). We require
  // a country-ish tail (a comma-separated multi-part place, or a clearly non-US token) to avoid calling
  // a bare "Springfield" metric; a single-token place with no country stays null (keep the default).
  if (p.includes(",")) return "metric";
  return null;
}

/** Resolve the units to use: an explicit user preference always wins; else infer from the resolved
 * place; else fall back to `fallback` (imperial, preserving prior behavior). Exported for tests. */
export function resolveUnits(
  userPref: "metric" | "imperial" | undefined,
  place: string | undefined,
  fallback: "metric" | "imperial" = "imperial",
): "metric" | "imperial" {
  return userPref ?? inferUnitsFromPlace(place) ?? fallback;
}
