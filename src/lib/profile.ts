// Per-user profile (product-loop): home location + units, set once so location/unit-relative errands
// ("weather", "sushi near me", "how far to X") resolve without re-stating the city every message.
// Small persistent JSON store (atomic + corrupt-safe via safe-store), keyed by chatId. Free-infra.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

export interface Profile {
  chatId: number;
  location?: string;              // free-text home place, e.g. "Austin, TX"
  units?: "metric" | "imperial";  // preferred units
}

/** Parse a "set location" command -> { location, units? } or null if it isn't one.
 *   "/setlocation Austin, TX"        "set my location to London"
 *   "i'm in Paris"                   "my location is Berlin (metric)"
 * A trailing "(metric)"/"(imperial)" or "in metric/imperial" sets units. */
export function parseSetLocation(text: string): { location: string; units?: "metric" | "imperial" } | null {
  const t = text.trim();
  const m = t.match(/^\s*(?:\/setlocation|set\s+(?:my\s+)?location(?:\s+to)?|my\s+location\s+is|i(?:'m| am)\s+in)\s+(.+)$/i);
  if (!m) return null;
  let loc = m[1]!.trim();
  let units: "metric" | "imperial" | undefined;
  // Trailing units clause: "(metric)" / "[imperial]" / "in metric". Match the WHOLE clause (incl. a
  // leading "in" / bracket) so slicing at its start doesn't leave a dangling word on the location.
  const u = loc.match(/[\s([]*(?:in\s+)?[([]?\b(metric|imperial)\b[)\]]?\s*$/i);
  if (u) { units = u[1]!.toLowerCase() as "metric" | "imperial"; loc = loc.slice(0, u.index).trim(); }
  loc = loc.replace(/["']|[.,;]\s*$/g, "").trim().slice(0, 120);
  if (!loc) return null;
  return units ? { location: loc, units } : { location: loc };
}

export class ProfileStore {
  private file: string;
  private items: Profile[] = [];
  constructor(opts: { file: string }) { this.file = opts.file; this.load(); }

  private load(): void {
    const obj = readJsonSafe<{ items?: Profile[] }>(this.file);
    if (obj && Array.isArray(obj.items)) this.items = obj.items.filter((p) => p && typeof p.chatId === "number");
  }
  private persist(): void { atomicWriteJson(this.file, { v: 1, items: this.items }); }

  get(chatId: number): Profile | undefined { return this.items.find((p) => p.chatId === chatId); }

  /** Set/merge a chat's profile fields. Returns the updated record. */
  set(chatId: number, patch: Partial<Omit<Profile, "chatId">>): Profile {
    let p = this.items.find((x) => x.chatId === chatId);
    if (!p) { p = { chatId }; this.items.push(p); }
    if (patch.location !== undefined) p.location = patch.location;
    if (patch.units !== undefined) p.units = patch.units;
    this.persist();
    return p;
  }

  /** A one-line context string for the agent, or "" if nothing set. */
  contextLine(chatId: number): string {
    const p = this.get(chatId);
    if (!p) return "";
    const bits: string[] = [];
    if (p.location) bits.push(`home location is ${p.location}`);
    if (p.units) bits.push(`prefers ${p.units} units`);
    return bits.join("; ");
  }

  size(): number { return this.items.length; }
}
