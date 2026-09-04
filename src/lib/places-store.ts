// Saved named places (saved-named-places): the profile stores exactly ONE home location, so "coffee
// near work", "weather at the gym", "directions to mom's" re-ask the city every time. This is a per-chat
// alias -> place store ("my work is 500 5th Ave", "save gym: Gold's on Main") injected into the agent's
// context like notes/profile, so the LLM substitutes the alias for its address when it calls
// weather/find_nearby/directions. Small atomic + corrupt-safe JSON store (safe-store). Mirrors NotesStore.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";
import { stripTrailingCourtesy } from "./text-clean.js";

export interface Place {
  name: string;     // the alias, lowercased ("work", "gym", "mom's")
  address: string;  // the free-text place/address to resolve ("500 5th Ave, NYC")
  created: number;
}
interface ChatPlaces { chatId: number; places: Place[] }

const MAX_PLACES_PER_CHAT = 20;
const MAX_NAME_LEN = 30;
const MAX_ADDRESS_LEN = 200;

// Alias words that would collide with a real errand / the existing single "home location" — a place
// literally named "home" is fine to save, but we DON'T let it shadow anything since resolution is by
// exact alias only. No reserved words needed; the parser is shape-gated below.

/** Parse a "save a place" command -> {name, address}, or null if it isn't one. Forms:
 *   "my work is 500 5th Ave"            "work is at 500 5th Ave"
 *   "save gym: Gold's on Main St"       "save my gym as Gold's on Main"
 *   "set home to 12 Oak Rd"             "remember my office is 1 Loop, Cupertino"
 * Deliberately requires a SHORT alias (<=3 words) + a non-trivial address, so a normal sentence
 * ("my flight is delayed") isn't captured as a place. */
export function parseSavePlace(text: string): { name: string; address: string } | null {
  const t = text.trim();
  // "save <name>: <address>" / "save my <name> as <address>"
  let m = t.match(/^\s*save\s+(?:my\s+)?([\w' -]{1,30}?)\s*(?::|as)\s+(.+)$/i);
  // "my <name> is [at] <address>" / "set my <name> to <address>" / "remember my <name> is <address>"
  if (!m) m = t.match(/^\s*(?:remember\s+|set\s+)?my\s+([\w' -]{1,30}?)\s+(?:is|=)\s+(?:at\s+)?(.+)$/i);
  if (!m) m = t.match(/^\s*set\s+(?:my\s+)?([\w' -]{1,30}?)\s+to\s+(.+)$/i);
  if (!m) m = t.match(/^\s*([\w' -]{1,30}?)\s+is\s+at\s+(.+)$/i);
  if (!m) return null;
  const name = normalizePlaceName(m[1]!);
  // Drop a trailing courtesy so "save gym: Gold's on Main please" stores "Gold's on Main" — a "please"
  // baked into the address breaks geocoding for "near me"/directions later (courtesy-tail bug class).
  let address = stripTrailingCourtesy(m[2]!.trim().replace(/^["']|["']$/g, "").replace(/[.;]\s*$/, "").trim()).slice(0, MAX_ADDRESS_LEN);
  if (!name || name.split(/\s+/).length > 3) return null;   // alias must be short (work / the gym / mom's)
  // The address must look like a place, not a status/opinion — needs a digit (street number) OR >=2
  // words with a capital-ish token, and be long enough. Guards against "my day is great".
  if (address.length < 4) return null;
  const looksPlace = /\d/.test(address) || address.split(/\s+/).length >= 2;
  if (!looksPlace) return null;
  return { name, address };
}

/** Parse a "forget <name>" place command -> the alias, or null. Scoped to place phrasing so it doesn't
 * collide with /forget <recipe> or forget-a-fact. "forget my work address" / "forget the gym place". */
export function parseForgetPlace(text: string): string | null {
  const m = text.trim().match(/^\s*forget\s+(?:my\s+|the\s+)?([\w' -]{1,30}?)\s+(?:place|address|location|spot)\b/i);
  if (!m) return null;
  const name = normalizePlaceName(m[1]!);
  return name || null;
}

/** True if the WHOLE message asks to list saved places ("what places do you have", "my saved places"). */
export function isListPlacesRequest(text: string): boolean {
  return /^\s*(?:what|which|list)\s+(?:my\s+|saved\s+)*(?:places|addresses|locations)\b.*\??\s*$/i.test(text.trim())
    || /^\s*my\s+(?:saved\s+)?(?:places|addresses|locations)\s*\??\s*$/i.test(text.trim());
}

function normalizePlaceName(s: string): string {
  return s.trim().toLowerCase().replace(/^(?:the)\s+/i, "").replace(/\s+/g, " ").slice(0, MAX_NAME_LEN);
}

export class PlacesStore {
  private file: string;
  private items: ChatPlaces[] = [];
  constructor(opts: { file: string }) { this.file = opts.file; this.load(); }

  private load(): void {
    const obj = readJsonSafe<{ items?: ChatPlaces[] }>(this.file);
    if (obj && Array.isArray(obj.items)) {
      this.items = obj.items.filter((c) => c && typeof c.chatId === "number" && Array.isArray(c.places));
    }
  }
  private lastWriteOk = true;
  lastSaveOk(): boolean { return this.lastWriteOk; }
  private persist(): boolean { return (this.lastWriteOk = atomicWriteJson(this.file, { v: 1, items: this.items })); }

  private forChat(chatId: number): ChatPlaces {
    let c = this.items.find((x) => x.chatId === chatId);
    if (!c) { c = { chatId, places: [] }; this.items.push(c); }
    return c;
  }

  list(chatId: number): Place[] { return this.items.find((c) => c.chatId === chatId)?.places ?? []; }

  /** Save/overwrite an alias. Re-saving the same name UPDATES its address (a user correcting "work").
   * At the cap, drops the OLDEST alias to make room. Returns the stored place + saved (disk) flag. */
  save(chatId: number, name: string, address: string, now: number): { place: Place; saved: boolean } {
    const c = this.forChat(chatId);
    const norm = name.trim().toLowerCase();
    const existing = c.places.find((p) => p.name === norm);
    let place: Place;
    if (existing) { existing.address = address; place = existing; }
    else {
      place = { name: norm, address, created: now };
      c.places.push(place);
      if (c.places.length > MAX_PLACES_PER_CHAT) c.places.splice(0, c.places.length - MAX_PLACES_PER_CHAT);
    }
    const saved = this.persist();
    return { place, saved };
  }

  /** Resolve an alias to its address (exact, case-insensitive), or null. */
  resolve(chatId: number, name: string): string | null {
    const norm = name.trim().toLowerCase();
    return this.items.find((c) => c.chatId === chatId)?.places.find((p) => p.name === norm)?.address ?? null;
  }

  /** Forget an alias. Returns true if one was removed. */
  forget(chatId: number, name: string): boolean {
    const c = this.items.find((x) => x.chatId === chatId);
    if (!c) return false;
    const norm = name.trim().toLowerCase();
    const before = c.places.length;
    c.places = c.places.filter((p) => p.name !== norm);
    if (c.places.length !== before) { this.persist(); return true; }
    return false;
  }

  /** A context string injecting the saved aliases so the agent substitutes them for the address when a
   * user names one ("weather at the gym" -> resolve "gym"), or "" if none. */
  contextLine(chatId: number): string {
    const places = this.list(chatId);
    if (!places.length) return "";
    return `the user's saved places (use the address when they name one): ${places.map((p) => `${p.name} = ${p.address}`).join("; ")}`;
  }

  size(): number { return this.items.reduce((a, c) => a + c.places.length, 0); }
}
