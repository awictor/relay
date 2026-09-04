// Flight status (flight-status): "is AA100 on time", "what gate for UA83", "when does DL215 land" was
// a top assistant errand that dead-ended — track_package only knows parcel carriers, and a flight number
// fell to a flaky web_search. This resolves a flight number to its route (airline + origin/destination)
// via the KEYLESS adsbdb API, and its LIVE position (airborne now?) via the KEYLESS adsb.lol API. No
// signup, no anvil. Pure detect/format helpers exported + unit-tested; the network fetch is injected.
//
// Honest scope: these keyless sources give the ROUTE (from/to) and whether the aircraft is airborne +
// its altitude/speed — NOT scheduled gate/terminal or on-time-vs-delayed (that needs a paid flight-data
// vendor). We report what we truthfully have + link to a live tracker for the rest, rather than inventing
// a gate or an on-time claim (the codebase's no-silent-wrong-answer rule).

// A flight designator: 2-char airline code (2 letters, or a letter+digit like "B6"/"U2") + 1-4 digits,
// optionally spaced ("AA 100"). Rejects a bare number and an all-letters token.
const FLIGHT_RE = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/i;

export interface FlightRef { iata: string; airlineCode: string; number: string; }

/** Detect a flight number in free text, or null. Requires a flight cue word (flight/fly/gate/land/
 * depart/arrive/on time/delayed/status) OR the bare designator standing alone, so a random "AA100" inside
 * a sentence about something else doesn't trigger it. Returns the normalized IATA designator ("AA100").
 * Exported for tests. */
export function detectFlight(raw: string): FlightRef | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const m = text.match(FLIGHT_RE);
  if (!m) return null;
  const airlineCode = m[1]!.toUpperCase();
  const number = m[2]!;
  // Gate on a flight cue so "AA100" is read as a flight only in a flight context — EXCEPT when the whole
  // message basically IS the designator (a bare "AA100" / "flight AA100"), which is unambiguous.
  // Cues include "where('s)" + "track(ing)" (flight-cue-where-track): "where's UA83" / "track BA2490" are
  // the most natural flight-status asks and had no cue, so they fell to a flaky web_search. A parcel
  // tracking number (1Z…) can't match FLIGHT_RE's 2-char+<=4-digit shape, so "track" here is a flight.
  const hasCue = /\b(flight|flights|fly|flying|gate|terminal|land|landing|lands|depart|departs|departure|arrive|arrives|arrival|takeoff|take off|on\s?time|delayed|delay|status|inbound|airborne|in\s+the\s+air|tail\s?number|where'?s?|track|tracking)\b/i.test(text);
  const bareish = text.replace(/\bflight\b/i, "").replace(FLIGHT_RE, "").replace(/[^\p{L}\p{N}]/gu, "").length === 0;
  if (!hasCue && !bareish) return null;
  return { iata: `${airlineCode}${number}`, airlineCode, number };
}

export interface FlightRoute {
  iata: string;
  airline?: string;
  origin?: { iata?: string; city?: string };
  destination?: { iata?: string; city?: string };
}

/** Parse an adsbdb callsign response into a route, or null (unknown callsign / bad shape). Exported. */
export function parseAdsbdbRoute(body: string): FlightRoute | null {
  try {
    const obj = JSON.parse(body) as {
      response?: string | { flightroute?: {
        callsign_iata?: string;
        airline?: { name?: string };
        origin?: { iata_code?: string; municipality?: string };
        destination?: { iata_code?: string; municipality?: string };
      } };
    };
    if (!obj.response || typeof obj.response === "string") return null; // "unknown callsign"
    const fr = obj.response.flightroute;
    if (!fr) return null;
    return {
      iata: fr.callsign_iata ?? "",
      ...(fr.airline?.name ? { airline: fr.airline.name } : {}),
      ...(fr.origin ? { origin: { ...(fr.origin.iata_code ? { iata: fr.origin.iata_code } : {}), ...(fr.origin.municipality ? { city: fr.origin.municipality } : {}) } } : {}),
      ...(fr.destination ? { destination: { ...(fr.destination.iata_code ? { iata: fr.destination.iata_code } : {}), ...(fr.destination.municipality ? { city: fr.destination.municipality } : {}) } } : {}),
    };
  } catch { return null; }
}

export interface LivePosition { airborne: boolean; altFt?: number; groundSpeedKt?: number; }

/** Parse an adsb.lol callsign response into a live-position snapshot. Empty ac[] = not airborne now
 * (scheduled / on the ground / landed). Exported. */
export function parseAdsbLive(body: string): LivePosition {
  try {
    const obj = JSON.parse(body) as { ac?: Array<{ alt_baro?: number | string; gs?: number }> };
    const ac = obj.ac?.[0];
    if (!ac) return { airborne: false };
    const alt = typeof ac.alt_baro === "number" ? ac.alt_baro : undefined;
    return { airborne: true, ...(alt !== undefined ? { altFt: alt } : {}), ...(typeof ac.gs === "number" ? { groundSpeedKt: ac.gs } : {}) };
  } catch { return { airborne: false }; }
}

// IATA airline code -> ICAO prefix for the callsign adsbdb/adsb.lol expect. Only the common ones a
// texting user names; an unknown IATA falls back to the IATA form (adsbdb accepts the IATA designator
// too, as verified against AA100). Not exhaustive — a miss still works via the IATA fallback.
const IATA_TO_ICAO: Record<string, string> = {
  AA: "AAL", UA: "UAL", DL: "DAL", WN: "SWA", B6: "JBU", AS: "ASA", NK: "NKS", F9: "FFT", HA: "HAL",
  BA: "BAW", VS: "VIR", LH: "DLH", AF: "AFR", KL: "KLM", EK: "UAE", QR: "QTR", SQ: "SIA", CX: "CPA",
  AC: "ACA", QF: "QFA", NH: "ANA", JL: "JAL", EI: "EIN", IB: "IBE", TK: "THY", EY: "ETD",
};

/** The adsbdb route URL for a flight designator. Tries the ICAO callsign form when we know the airline
 * (adsbdb keys on callsign), else the IATA designator (also accepted). Exported. */
export function adsbdbUrl(ref: FlightRef): string {
  const icao = IATA_TO_ICAO[ref.airlineCode];
  const callsign = icao ? `${icao}${ref.number}` : ref.iata;
  return `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`;
}

/** The adsb.lol live-position URL for a flight designator (same callsign form as adsbdb). Exported. */
export function adsbLiveUrl(ref: FlightRef): string {
  const icao = IATA_TO_ICAO[ref.airlineCode];
  const callsign = icao ? `${icao}${ref.number}` : ref.iata;
  return `https://api.adsb.lol/v2/callsign/${encodeURIComponent(callsign)}`;
}

// A live flight-tracker link for the rest (gate/scheduled times we can't get keyless) — flightaware's
// public page, no login needed to view.
export function trackerLink(ref: FlightRef): string {
  return `https://www.flightaware.com/live/flight/${encodeURIComponent(ref.iata)}`;
}

/** Format the flight answer honestly: the route we know + whether it's airborne right now + a tracker
 * link for gate/times we can't get keyless. Never invents a gate or an on-time claim. */
export function formatFlight(ref: FlightRef, route: FlightRoute | null, live: LivePosition): string {
  const head = route?.airline ? `${route.airline} ${ref.iata}` : `Flight ${ref.iata}`;
  const lines: string[] = [];
  if (route?.origin || route?.destination) {
    const o = route.origin ? `${route.origin.city ?? route.origin.iata ?? "?"}${route.origin.iata && route.origin.city ? ` (${route.origin.iata})` : ""}` : "?";
    const d = route.destination ? `${route.destination.city ?? route.destination.iata ?? "?"}${route.destination.iata && route.destination.city ? ` (${route.destination.iata})` : ""}` : "?";
    lines.push(`Route: ${o} → ${d}`);
  }
  if (live.airborne) {
    const bits = [live.altFt !== undefined ? `${live.altFt.toLocaleString()} ft` : null, live.groundSpeedKt !== undefined ? `${live.groundSpeedKt} kt` : null].filter(Boolean);
    lines.push(`✈️ In the air now${bits.length ? ` (${bits.join(", ")})` : ""}.`);
  } else {
    lines.push("Not airborne right now (scheduled, on the ground, or already landed).");
  }
  lines.push(`Live gate/times: ${trackerLink(ref)}`);
  return `${head}\n${lines.join("\n")}`;
}

/**
 * Fetch a flight's route + live position. `fetchText` is injected. Returns null when there's no route
 * AND no live data (unknown flight / both fetches failed) so the caller can fall back. A route-only or
 * live-only result still returns (partial is useful). Never throws.
 */
export async function getFlight(
  ref: FlightRef,
  fetchText: (url: string) => Promise<string>,
): Promise<{ ref: FlightRef; route: FlightRoute | null; live: LivePosition } | null> {
  let route: FlightRoute | null = null;
  let live: LivePosition = { airborne: false };
  try { route = parseAdsbdbRoute(await fetchText(adsbdbUrl(ref))); } catch { /* keep null */ }
  let liveOk = false;
  try { live = parseAdsbLive(await fetchText(adsbLiveUrl(ref))); liveOk = true; } catch { /* keep default */ }
  if (!route && !liveOk) return null; // nothing at all — let the caller fall back to web_search
  return { ref, route, live };
}
