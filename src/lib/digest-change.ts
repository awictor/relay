// Digest smart-ordering change detection (digest-smart-ordering): remembers each digest member's last
// value and reports whether it changed materially since the previous run, so the runner can float
// changed members to the top of a briefing. Numeric members (a price, a count) use a relative deadband
// so a sub-cent tick doesn't count as "changed"; non-numeric members (a headline, a forecast) compare
// normalized text so pure phrasing drift doesn't false-fire. In-memory + persisted by the caller via
// the injected load/save; time not needed (comparison is value-vs-value). Pure logic, unit-testable.

import { extractValue, normalizeForCompare } from "./alerts.js";

// Relative deadband for a numeric member (fraction of the previous value). A move smaller than this
// isn't "changed". Env-tunable; mirrors the alert deadband intent.
const CHANGE_PCT = Math.max(0, Number(process.env.RELAY_DIGEST_CHANGE_PCT) || 1) / 100; // default 1%

/** Did `body` change materially vs `prev`? First run (prev undefined) is NOT a change (nothing to compare
 * — don't mark every member ✦ on the first briefing). Numeric: relative deadband. Text: normalized compare.
 * `member` (the digest member name, e.g. "btc") is passed to extractValue as an entity hint so a
 * multi-number reply compares the number nearest the watched entity. Exported for tests. */
export function digestMemberChanged(prev: string | undefined, body: string, member?: string): boolean {
  if (prev === undefined) return false;
  // Use extractValue, NOT firstNumber (digest-change-tracks-wrong-number): the first number in a member
  // reply is often a %/count/time ("BTC up 2.5% at 68000" -> firstNumber grabs 2.5, the percent), so a
  // real price move read as UNCHANGED and a "quiet unless changed" digest wrongly stayed silent / mis-
  // floated ✦. extractValue prefers a currency/decimal/largest value + excludes a bare percent — the same
  // salient-value logic alerts already use — so the deadband compares the number the member actually tracks.
  const pn = extractValue(prev, member), bn = extractValue(body, member);
  if (pn !== null && bn !== null) {
    if (pn === 0) return bn !== 0;
    return Math.abs(bn - pn) / Math.abs(pn) >= CHANGE_PCT;
  }
  return normalizeForCompare(prev) !== normalizeForCompare(body);
}

/** Per-(chat,digest,member) last-value store with change detection. `load`/`save` persist the flat map
 * (caller supplies a JSON-backed store); an in-memory Map is the default. Keyed so two digests + two
 * chats never collide. `changed()` records the new value AND returns whether it moved. */
export class DigestChangeStore {
  private map: Map<string, string>;
  constructor(private persist?: (obj: Record<string, string>) => void, initial?: Record<string, string>) {
    this.map = new Map(Object.entries(initial ?? {}));
  }
  private key(chatId: number, digest: string, member: string): string {
    return `${chatId} ${digest.toLowerCase()} ${member.toLowerCase()}`;
  }
  /** Record `body` as this member's latest value; return whether it changed vs the stored previous. */
  changed(chatId: number, digest: string, member: string, body: string): boolean {
    const k = this.key(chatId, digest, member);
    const prev = this.map.get(k);
    const did = digestMemberChanged(prev, body, member);
    this.map.set(k, body);
    if (this.persist) this.persist(Object.fromEntries(this.map));
    return did;
  }
  /** Has ANY member of this (chat,digest) been recorded before? Lets the caller tell a first run (should
   * still send) from a genuine no-change (digest-skip-unchanged). */
  seenBefore(chatId: number, digest: string): boolean {
    const prefix = `${chatId} ${digest.toLowerCase()} `;
    for (const k of this.map.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }
  /** Snapshot for persistence/inspection. */
  snapshot(): Record<string, string> { return Object.fromEntries(this.map); }
}
