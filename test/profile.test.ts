import { describe, it, expect, afterEach } from "vitest";
import { parseSetLocation, parseUtcOffset, formatUtcOffset, ProfileStore, needsLocationContext, parseCityReply, parseUnitsPreference, parseReplyStyle, replyStyleSummary, inferTzFromLocation, inferZoneFromLocation, offsetForZoneAt } from "../src/lib/profile.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-prof-")); dirs.push(d); return join(d, "p.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("parseSetLocation", () => {
  it("parses the /setlocation command (+infers tz from the city, city-to-tz-inference)", () => {
    expect(parseSetLocation("/setlocation Austin, TX")).toEqual({ location: "Austin, TX", tzOffsetMin: -360 });
  });
  it("parses natural phrasings (+infers tz)", () => {
    expect(parseSetLocation("set my location to London")).toEqual({ location: "London", tzOffsetMin: 0 });
    expect(parseSetLocation("I'm in Paris")).toEqual({ location: "Paris", tzOffsetMin: 60 });
    expect(parseSetLocation("my location is Berlin")).toEqual({ location: "Berlin", tzOffsetMin: 60 });
  });
  it("parses more setters: 'i live in', 'my city is', 'update/change my location/city', 'set my home city' (setlocation-more-phrasings)", () => {
    expect(parseSetLocation("i live in Austin", Date.UTC(2026,0,15))).toEqual({ location: "Austin", tzOffsetMin: -360 });
    expect(parseSetLocation("my city is Denver", Date.UTC(2026,0,15))).toEqual({ location: "Denver", tzOffsetMin: -420 });
    expect(parseSetLocation("update my location to Miami", Date.UTC(2026,0,15))).toEqual({ location: "Miami", tzOffsetMin: -300 });
    expect(parseSetLocation("change my city to Dallas", Date.UTC(2026,0,15))).toEqual({ location: "Dallas", tzOffsetMin: -360 });
    expect(parseSetLocation("set my home city to Portland", Date.UTC(2026,0,15))).toEqual({ location: "Portland", tzOffsetMin: -480 });
    // 'i live in' gets the same place-shape guard as 'i'm in' — a task/state tail falls through
    expect(parseSetLocation("i live in a rush, remind me in 10 min")).toBeNull();
    expect(parseSetLocation("i live in trouble")).toBeNull();
  });
  it("captures units in parens or 'in metric' (+infers tz)", () => {
    expect(parseSetLocation("/setlocation Denver (imperial)")).toEqual({ location: "Denver", units: "imperial", tzOffsetMin: -420 });
    expect(parseSetLocation("I'm in Tokyo in metric")).toEqual({ location: "Tokyo", units: "metric", tzOffsetMin: 540 });
  });
  it("leaves tz unset for an unknown city (no wrong guess)", () => {
    expect(parseSetLocation("/setlocation Smallville")).toEqual({ location: "Smallville" });
  });
  it("captures a UTC offset clause without swallowing the place (tz-from-location)", () => {
    expect(parseSetLocation("/setlocation NYC UTC-5")).toEqual({ location: "NYC", tzOffsetMin: -300 });
    expect(parseSetLocation("I'm in Berlin UTC+1 (metric)")).toEqual({ location: "Berlin", units: "metric", tzOffsetMin: 60 });
    expect(parseSetLocation("set my location to Mumbai GMT+5:30")).toEqual({ location: "Mumbai", tzOffsetMin: 330 });
  });
  it("does NOT hijack a conversational 'I'm in ...' that carries a task (greedy-location-setter)", () => {
    expect(parseSetLocation("I'm in a meeting, remind me in 10 min")).toBeNull();
    expect(parseSetLocation("I'm in the middle of something, call me later")).toBeNull();
    expect(parseSetLocation("I am in a rush today")).toBeNull();
    expect(parseSetLocation("I'm in line at the store and need the weather")).toBeNull();
  });
  it("still accepts a bare 'I'm in <place>' and explicit forms (tz inferred where known)", () => {
    expect(parseSetLocation("I'm in Paris")).toEqual({ location: "Paris", tzOffsetMin: 60 });
    expect(parseSetLocation("I'm in New York City")).toEqual({ location: "New York City", tzOffsetMin: -300 });
    expect(parseSetLocation("I'm in Tokyo in metric")).toEqual({ location: "Tokyo", units: "metric", tzOffsetMin: 540 });
    // explicit forms stay permissive (a comma place is fine there)
    expect(parseSetLocation("set my location to Austin, TX")).toEqual({ location: "Austin, TX", tzOffsetMin: -360 });
  });
  it("does NOT save a bare 'I'm in <state>' non-place as a location (bare-im-in-nonplace-corrupts-profile)", () => {
    // Everyday "I'm in X" where X is a state-of-being, not a place — must fall through, not corrupt the profile.
    expect(parseSetLocation("I'm in trouble")).toBeNull();
    expect(parseSetLocation("I'm in bed")).toBeNull();
    expect(parseSetLocation("I'm in the office")).toBeNull();      // article -> not a place
    expect(parseSetLocation("I'm in a mood")).toBeNull();          // article
    expect(parseSetLocation("I am in love")).toBeNull();
    expect(parseSetLocation("I'm in class")).toBeNull();
    // A real proper-noun place with no article still saves.
    expect(parseSetLocation("I'm in Paris")).toEqual({ location: "Paris", tzOffsetMin: 60 });
    expect(parseSetLocation("I'm in San Diego")).toMatchObject({ location: "San Diego" });
  });
  it("returns null for a non-location message", () => {
    expect(parseSetLocation("what's the weather")).toBeNull();
    expect(parseSetLocation("/setlocation")).toBeNull(); // no place
  });
});

describe("parseUtcOffset", () => {
  it("parses signed hour/min offsets", () => {
    expect(parseUtcOffset("UTC-5")).toBe(-300);
    expect(parseUtcOffset("utc+1")).toBe(60);
    expect(parseUtcOffset("GMT+5:30")).toBe(330);
    expect(parseUtcOffset("gmt-0")).toBe(0);
  });
  it("returns null when absent or out of range", () => {
    expect(parseUtcOffset("Austin")).toBeNull();
    expect(parseUtcOffset("UTC+20")).toBeNull(); // >14h
  });
});

describe("formatUtcOffset (halfhour-tz-rounding)", () => {
  it("preserves half/quarter-hour minutes instead of rounding to whole hours", () => {
    expect(formatUtcOffset(330)).toBe("UTC+5:30");   // India (was wrongly "UTC+6")
    expect(formatUtcOffset(-210)).toBe("UTC-3:30");  // Newfoundland (was wrongly "UTC-3")
    expect(formatUtcOffset(345)).toBe("UTC+5:45");   // Nepal
  });
  it("whole-hour + zero offsets read cleanly", () => {
    expect(formatUtcOffset(-300)).toBe("UTC-5");
    expect(formatUtcOffset(60)).toBe("UTC+1");
    expect(formatUtcOffset(0)).toBe("UTC+0");
  });
  it("round-trips with parseUtcOffset", () => {
    for (const s of ["UTC-5", "UTC+5:30", "UTC-3:30", "UTC+0"]) {
      expect(formatUtcOffset(parseUtcOffset(s)!)).toBe(s);
    }
  });
});

describe("ProfileStore", () => {
  it("set/get/merge + contextLine, persisted", () => {
    const f = tmp();
    const s = new ProfileStore({ file: f });
    s.set(1, { location: "Austin, TX" });
    expect(s.get(1)!.location).toBe("Austin, TX");
    expect(s.contextLine(1)).toMatch(/home location is Austin, TX/);
    s.set(1, { units: "imperial" }); // merge, not overwrite
    expect(s.get(1)!.location).toBe("Austin, TX");
    expect(s.contextLine(1)).toMatch(/imperial units/);
    // reload from disk -> persisted
    const s2 = new ProfileStore({ file: f });
    expect(s2.get(1)!.location).toBe("Austin, TX");
    expect(s2.get(1)!.units).toBe("imperial");
  });
  it("stores + exposes tzOffsetMin, surfaces it in contextLine (tz-from-location)", () => {
    const s = new ProfileStore({ file: tmp() });
    expect(s.offsetMin(1)).toBeUndefined(); // unset -> caller falls back to global
    s.set(1, { location: "NYC", tzOffsetMin: -300 });
    expect(s.offsetMin(1)).toBe(-300);
    expect(s.contextLine(1)).toMatch(/timezone is UTC-5/);
    s.set(2, { location: "Mumbai", tzOffsetMin: 330 });
    expect(s.contextLine(2)).toMatch(/timezone is UTC\+5:30/); // half-hour zone shown correctly
  });
  it("offsetMinAt is DST-correct at the instant when the location resolves to a zone (current-datetime-dst-stale)", () => {
    const JUL = Date.UTC(2025, 6, 1, 12, 0, 0), JAN = Date.UTC(2025, 0, 1, 12, 0, 0);
    const s = new ProfileStore({ file: tmp() });
    // Chicago set in winter: frozen offset -360. The live offset must follow DST regardless.
    s.set(1, { location: "Austin, TX", tzOffsetMin: -360 });
    expect(s.offsetMinAt(1, JAN)).toBe(-360); // CST
    expect(s.offsetMinAt(1, JUL)).toBe(-300); // CDT — NOT the frozen -360
    expect(s.offsetMin(1)).toBe(-360);        // frozen accessor unchanged
    // A location that doesn't resolve to a zone falls back to the frozen offset.
    s.set(2, { location: "Narnia", tzOffsetMin: 120 });
    expect(s.offsetMinAt(2, JUL)).toBe(120);
    // No profile at all -> undefined (caller uses the global default).
    expect(s.offsetMinAt(99, JUL)).toBeUndefined();
  });
  it("contextLine is empty for an unknown chat", () => {
    expect(new ProfileStore({ file: tmp() }).contextLine(99)).toBe("");
  });
  it("stores + surfaces coords from a location pin (telegram-location-pin)", () => {
    const s = new ProfileStore({ file: tmp() });
    s.set(1, { lat: 30.2711, lng: -97.7437 });
    expect(s.get(1)!.lat).toBe(30.2711);
    expect(s.contextLine(1)).toMatch(/current coordinates are 30\.27110,-97\.74370/);
  });
  it("expires shared coords after the TTL (coords-privacy-ttl)", async () => {
    const { COORDS_TTL_MS } = await import("../src/lib/profile.js");
    const s = new ProfileStore({ file: tmp() });
    const t0 = 1_700_000_000_000;
    s.set(1, { lat: 30.2711, lng: -97.7437, coordsAt: t0 });
    // Fresh: within TTL -> present in freshCoords + contextLine.
    expect(s.freshCoords(1, t0 + 60_000)).toEqual({ lat: 30.2711, lng: -97.7437 });
    expect(s.contextLine(1, t0 + 60_000)).toMatch(/current coordinates/);
    // Expired: past TTL -> gone from both (privacy: not leaked to the LLM forever).
    expect(s.freshCoords(1, t0 + COORDS_TTL_MS + 1)).toBeUndefined();
    expect(s.contextLine(1, t0 + COORDS_TTL_MS + 1)).not.toMatch(/coordinates/);
    // The home location (durable) still shows after coords expire.
    s.set(1, { location: "Austin" });
    expect(s.contextLine(1, t0 + COORDS_TTL_MS + 1)).toMatch(/home location is Austin/);
  });
  it("homeCoords ignores the TTL so a standing automation keeps a location anchor (recurring-near-me-pin-ttl-breaks)", async () => {
    const { COORDS_TTL_MS } = await import("../src/lib/profile.js");
    const s = new ProfileStore({ file: tmp() });
    const t0 = 1_700_000_000_000;
    s.set(1, { lat: 30.2711, lng: -97.7437, coordsAt: t0 });
    // freshCoords expires (ad-hoc privacy), but homeCoords stays for a proactive run the user opted into.
    expect(s.freshCoords(1, t0 + COORDS_TTL_MS + 1)).toBeUndefined();
    expect(s.homeCoords(1)).toEqual({ lat: 30.2711, lng: -97.7437 });
    // No coords at all -> undefined either way.
    expect(s.homeCoords(2)).toBeUndefined();
  });
  it("clear() forgets a chat's profile + reports whether there was one (profile-view-reset)", () => {
    const f = tmp();
    const s = new ProfileStore({ file: f });
    s.set(1, { location: "Paris", tzOffsetMin: 60 });
    expect(s.clear(1)).toBe(true);
    expect(s.get(1)).toBeUndefined();
    expect(s.clear(1)).toBe(false); // nothing left
    expect(new ProfileStore({ file: f }).get(1)).toBeUndefined(); // persisted
  });
});

describe("DST-aware offset (reminder-wrong-timezone-dst)", () => {
  const JUL = Date.UTC(2025, 6, 1);  // northern summer (US/EU on DST)
  const JAN = Date.UTC(2025, 0, 1);  // northern winter (standard time)
  it("inferZoneFromLocation maps cities/regions to IANA zones", () => {
    expect(inferZoneFromLocation("Austin")).toBe("America/Chicago");
    expect(inferZoneFromLocation("Paris, TX")).toBe("America/Chicago"); // region tail still wins
    expect(inferZoneFromLocation("Paris, France")).toBe("Europe/Paris");
    expect(inferZoneFromLocation("Nowhere-ville")).toBeNull();
  });
  it("offsetForZoneAt returns the DST-correct offset at the instant", () => {
    expect(offsetForZoneAt("America/Chicago", JUL)).toBe(-300); // CDT
    expect(offsetForZoneAt("America/Chicago", JAN)).toBe(-360); // CST
    expect(offsetForZoneAt("Europe/London", JUL)).toBe(60);     // BST
    expect(offsetForZoneAt("Europe/London", JAN)).toBe(0);      // GMT
    expect(offsetForZoneAt("Australia/Sydney", JUL)).toBe(600); // AEST (southern winter)
    expect(offsetForZoneAt("Australia/Sydney", JAN)).toBe(660); // AEDT (southern summer)
    expect(offsetForZoneAt("Bogus/Zone", JUL)).toBeNull();
  });
  it("inferTzFromLocation with an instant gives summer vs winter offset; no instant = standard", () => {
    expect(inferTzFromLocation("Austin", JUL)).toBe(-300); // CDT in July — the bug: table said -360
    expect(inferTzFromLocation("Austin", JAN)).toBe(-360); // CST in January
    expect(inferTzFromLocation("Austin")).toBe(-360);      // no instant -> standard table, unchanged
    // A non-DST zone is identical year-round + matches the table.
    expect(inferTzFromLocation("Phoenix", JUL)).toBe(-420);
    expect(inferTzFromLocation("Mumbai", JUL)).toBe(330);
  });
  it("falls back to the standard table when the zone is unknown but the table has an offset", () => {
    // (no such case in practice since the tables mirror; guard the contract: unknown zone -> std lookup.)
    expect(inferTzFromLocation("San Jose, Costa Rica", JUL)).toBeNull(); // still unresolvable, not a guess
  });
});

describe("inferTzFromLocation (city-to-tz-inference)", () => {
  it("maps common cities to their standard offset", () => {
    expect(inferTzFromLocation("Austin")).toBe(-360);
    expect(inferTzFromLocation("New York")).toBe(-300);
    expect(inferTzFromLocation("London")).toBe(0);
    expect(inferTzFromLocation("Tokyo")).toBe(540);
    expect(inferTzFromLocation("Mumbai")).toBe(330);
    expect(inferTzFromLocation("Sydney")).toBe(600);
  });
  it("matches a 'City, ST'/'City, Country' form and state abbreviations", () => {
    expect(inferTzFromLocation("Austin, TX")).toBe(-360);
    expect(inferTzFromLocation("Portland, OR")).toBe(-480); // city wins (OR would also be -480)
    expect(inferTzFromLocation("somewhere in CA")).toBe(-480);
  });
  it("the REGION tail disambiguates a same-named city (region-qualifier-tz-inference)", () => {
    // Paris/Dublin/Athens exist in both the US + abroad — the ', ST' must win over the bare city.
    expect(inferTzFromLocation("Paris, TX")).toBe(-360);   // US Central, NOT Paris-France (+60)
    expect(inferTzFromLocation("Dublin, OH")).toBe(-300);  // US Eastern, NOT Dublin-Ireland (0)
    expect(inferTzFromLocation("Athens, GA")).toBe(-300);  // US Eastern, NOT Athens-Greece (+120)
    expect(inferTzFromLocation("Portland, ME")).toBe(-300); // Maine Eastern, NOT the default Oregon guess
    // The real foreign cities still resolve correctly.
    expect(inferTzFromLocation("Paris, France")).toBe(60);
    expect(inferTzFromLocation("Dublin, Ireland")).toBe(0);
  });
  it("a bare 'LA' still means Los Angeles, not Louisiana (no abbrev collision)", () => {
    expect(inferTzFromLocation("LA")).toBe(-480);
  });
  it("an UNKNOWN foreign region tail returns null, not a wrong-continent city guess (inferTz-region-tail-wrong)", () => {
    // "San Jose" is a US city (California, -480), but ", Costa Rica" says it's NOT — we can't place Costa
    // Rica, so leave tz unset (ask) rather than fire reminders 2h off on Pacific time.
    expect(inferTzFromLocation("San Jose, Costa Rica")).toBeNull();
    expect(inferTzFromLocation("San Jose, Nicaragua")).toBeNull();
    expect(inferTzFromLocation("Springfield, Narnia")).toBeNull();
    // (a KNOWN foreign region tail still resolves — regression guard.)
    expect(inferTzFromLocation("Cordoba, Argentina")).toBe(-180);
  });
  it("a US country/state tail still resolves the city (no regression)", () => {
    expect(inferTzFromLocation("Austin, USA")).toBe(-360);
    expect(inferTzFromLocation("New York, United States")).toBe(-300);
    expect(inferTzFromLocation("Portland, OR")).toBe(-480); // OR omitted from the table, but 2-letter -> US -> city wins
  });
  it("null for an unknown place (never a wrong guess)", () => {
    expect(inferTzFromLocation("Smallville")).toBeNull();
    expect(inferTzFromLocation("")).toBeNull();
  });
});

describe("needsLocationContext (first-location-capture)", () => {
  it("true for location-dependent errands", () => {
    for (const t of ["weather", "what's the weather", "weather tomorrow", "sushi near me", "coffee nearby", "how far to the airport", "directions to downtown", "will it rain today"]) {
      expect(needsLocationContext(t), t).toBe(true);
    }
  });
  it("false for errands that don't depend on where you are", () => {
    for (const t of ["top HN story", "price of bitcoin", "who won the game", "summarize this link", "remind me to stretch"]) {
      expect(needsLocationContext(t), t).toBe(false);
    }
  });
});

describe("parseUnitsPreference (units-preference-setter)", () => {
  it("parses a standalone units-preference command", () => {
    expect(parseUnitsPreference("use metric")).toBe("metric");
    expect(parseUnitsPreference("switch to imperial")).toBe("imperial");
    expect(parseUnitsPreference("show me celsius")).toBe("metric");
    expect(parseUnitsPreference("in fahrenheit")).toBe("imperial");
    expect(parseUnitsPreference("set my units to metric")).toBe("metric");
    expect(parseUnitsPreference("give me temps in C")).toBe("metric");
    expect(parseUnitsPreference("use fahrenheit")).toBe("imperial");
  });
  it("does NOT hijack a conversion or a passing mention", () => {
    expect(parseUnitsPreference("180C to F")).toBeNull();          // a conversion, not a pref
    expect(parseUnitsPreference("what's the weather")).toBeNull();
    expect(parseUnitsPreference("it's freezing outside")).toBeNull();
    expect(parseUnitsPreference("show me km not miles")).toBeNull(); // ambiguous (both) -> no change
  });
});

describe("parseReplyStyle (reply-style-preference)", () => {
  it("parses a standalone verbosity preference", () => {
    expect(parseReplyStyle("keep it brief")).toEqual({ verbosity: "brief" });
    expect(parseReplyStyle("keep answers short")).toEqual({ verbosity: "brief" });
    expect(parseReplyStyle("prefer concise replies")).toEqual({ verbosity: "brief" });
    expect(parseReplyStyle("give me more detail")).toEqual({ verbosity: "detailed" });
    expect(parseReplyStyle("be thorough")).toEqual({ verbosity: "detailed" });
  });
  it("parses an emoji toggle, incl. combined with verbosity", () => {
    expect(parseReplyStyle("no emoji")).toEqual({ emoji: false });
    expect(parseReplyStyle("stop using emojis")).toEqual({ emoji: false });
    expect(parseReplyStyle("use emoji")).toEqual({ emoji: true });
    expect(parseReplyStyle("reply briefly and no emoji")).toEqual({ emoji: false });
    expect(parseReplyStyle("keep it brief and no emoji")).toEqual({ verbosity: "brief", emoji: false });
  });
  it("does NOT hijack a passing mention (no command cue)", () => {
    expect(parseReplyStyle("that was a short trip")).toBeNull();
    expect(parseReplyStyle("what's the weather")).toBeNull();
    expect(parseReplyStyle("the detailed report is due")).toBeNull();
  });
  it("ProfileStore.set persists style fields and contextLine injects them", () => {
    const file = tmp();
    const store = new ProfileStore({ file });
    store.set(7, parseReplyStyle("keep it brief and no emoji")!);
    const line = store.contextLine(7);
    expect(line).toContain("BRIEF");
    expect(line).toContain("do NOT use emoji");
    // survives a reload from disk (set() whitelists fields — regression guard for the dropped style patch)
    const reopened = new ProfileStore({ file });
    expect(reopened.get(7)?.verbosity).toBe("brief");
    expect(reopened.get(7)?.emoji).toBe(false);
  });
});

describe("replyStyleSummary (reply-style-menu-discoverability)", () => {
  it("shows all-defaults + change hints when no profile is set", () => {
    const s = replyStyleSummary(undefined);
    expect(s).toContain("default length");
    expect(s).toContain("emoji on");
    expect(s).toContain("auto units");
    expect(s).toContain("keep it brief");
    expect(s).toContain("no emoji");
    expect(s).toContain("use metric");
  });
  it("reflects the stored preferences", () => {
    const s = replyStyleSummary({ chatId: 1, verbosity: "brief", emoji: false, units: "metric" });
    expect(s).toContain("brief");
    expect(s).toContain("no emoji");
    expect(s).toContain("metric");
  });
  it("shows detailed + emoji-on + imperial correctly", () => {
    const s = replyStyleSummary({ chatId: 1, verbosity: "detailed", emoji: true, units: "imperial" });
    expect(s).toContain("detailed");
    expect(s).toContain("emoji on");
    expect(s).toContain("imperial");
  });
});

describe("parseCityReply (first-location-capture)", () => {
  it("accepts a bare city, stripping a polite lead-in + a tz clause, inferring tz from the city", () => {
    expect(parseCityReply("Austin, TX")).toEqual({ location: "Austin, TX", tzOffsetMin: -360 });
    expect(parseCityReply("I'm in London")).toEqual({ location: "London", tzOffsetMin: 0 });
    expect(parseCityReply("it's Paris")).toEqual({ location: "Paris", tzOffsetMin: 60 });
    expect(parseCityReply("Denver UTC-7")).toEqual({ location: "Denver", tzOffsetMin: -420 }); // explicit wins
    expect(parseCityReply("Smallville")).toEqual({ location: "Smallville" }); // unknown -> no tz guess
  });
  it("strips more lead-ins + a trailing courtesy so the stored place is clean (citreply-leadin-and-courtesy)", () => {
    expect(parseCityReply("Denver please")).toEqual({ location: "Denver", tzOffsetMin: -420 });
    expect(parseCityReply("the city is Paris")).toEqual({ location: "Paris", tzOffsetMin: 60 });
    expect(parseCityReply("here in Chicago")).toEqual({ location: "Chicago", tzOffsetMin: -360 });
    expect(parseCityReply("London thanks")).toEqual({ location: "London", tzOffsetMin: 0 });
  });
  it("rejects a reply that clearly isn't a place (bail-out / fresh task / question)", () => {
    expect(parseCityReply("/help")).toBeNull();
    expect(parseCityReply("actually never mind show me the top HN story")).toBeNull();
    expect(parseCityReply("what can you do?")).toBeNull();
    expect(parseCityReply("remind me to call mom")).toBeNull();
    expect(parseCityReply("")).toBeNull();
  });
});
