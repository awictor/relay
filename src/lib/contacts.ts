// Contacts book (contacts-book-compose): compose (draft email/text) only worked if the user re-typed a
// raw address/number every time, so its highest-intent use — "text mom I'm late" — dead-ended asking
// for a number. A user saves a person once ("mom's number is 555-1234", "boss's email is b@co.com") and
// then "text mom ..." / "email my boss ..." drafts straight to the saved handle. Small atomic + corrupt-
// safe JSON store keyed by chatId, mirroring NotesStore. Pure parse helpers exported + unit-tested.
// Distinct from the deferred login/autofill VAULT (credentials): this is just a name -> email/phone book,
// and it's the natural feeder for a future confirm-to-send. Relay still never SENDS — it drafts.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";
import { stripTrailingCourtesy } from "./text-clean.js";

export interface Contact { name: string; email?: string; phone?: string; created: number; }
interface ChatContacts { chatId: number; contacts: Contact[] }

const MAX_CONTACTS_PER_CHAT = 100;
const MAX_NAME_LEN = 40;

const EMAIL_RE = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;
// A phone: 7+ digits, optional +, spaces/dashes/parens/dots allowed. Anchored loosely so it's pulled
// out of a sentence ("mom's number is (555) 123-4567").
const PHONE_RE = /\+?[0-9][0-9\s().-]{5,}[0-9]/;

/** Normalize a contact name for storage + lookup: lowercased, trimmed, strip a leading "my "/"the "
 * and a trailing possessive 's. So "my boss" / "boss's" / "Boss" key the same. Exported for tests. */
export function normalizeContactName(raw: string): string {
  return String(raw ?? "").toLowerCase()
    .replace(/^\s*(?:my|the)\s+/, "")
    .replace(/['']s\b/g, "")       // "mom's" -> "mom"
    .replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LEN);
}

export type SaveContact = { name: string; email?: string; phone?: string };

/**
 * Parse a "save a contact" command, or null. Handles:
 *   "save mom's number is 555-123-4567"      "mom's email is mom@x.com"
 *   "save my boss's email as boss@co.com"    "remember dave's number: 5551234567"
 *   "add contact Sam 555-0000"               "save contact mom mom@x.com"
 * Requires a person-ish subject + a phone/email value. Exported for tests.
 */
export function parseSaveContact(text: string): SaveContact | null {
  const t = text.trim();
  // Must carry a contact/number/email cue so a plain "save X: task" recipe or "remember X" fact isn't hijacked.
  const email = t.match(EMAIL_RE)?.[0];
  const phone = t.match(PHONE_RE)?.[0]?.replace(/[\s().-]/g, "");
  if (!email && !phone) return null;

  // "<subject>'s (number|email|phone|cell|mobile) is/are/: <value>" — subject is the contact name.
  // NOTE: the possessive is (?:['']s)? — an apostrophe-s only. A bare `s?` here wrongly ate the stem "s"
  // of a name ending in s ("boss email ..." -> "bos"); normalizeContactName still strips a real "'s"
  // (save-contact-stem-s).
  let m = t.match(/^\s*(?:save\s+|add\s+|remember\s+)?(?:contact\s+)?(.+?)(?:['']s)?\s+(?:number|phone|cell|mobile|email|e-?mail|address)\s*(?:is|are|:|=|as)?\s*/i);
  if (m && m[1]) {
    const name = normalizeContactName(m[1]);
    if (name && !isValueWord(name)) return { name, ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
  }
  // "save contact <name> <value>" / "add contact <name> <value>" — name is the token(s) before the value.
  m = t.match(/^\s*(?:save|add)\s+(?:a\s+)?contact\s+(.+)$/i);
  if (m && m[1]) {
    // Strip the email/phone out of the tail to leave the name.
    let name = m[1];
    if (email) name = name.replace(email, "");
    if (phone) name = name.replace(PHONE_RE, "");
    name = normalizeContactName(name.replace(/\b(is|as|number|phone|email|:|=)\b/gi, ""));
    if (name && !isValueWord(name)) return { name, ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
  }
  return null;
}

/** Parse a person-anchored follow-up nudge (contact-followup-nudge), or null. Splits the CONTACT name
 * from the WHEN clause so the handler can resolve the saved contact + schedule a reminder that pings
 * with their details + a draft link. Forms:
 *   "follow up with Sarah in 3 days"    "follow up with my landlord tomorrow"
 *   "nudge me to reply to Sam on Friday"  "remind me to get back to mom next week"
 * Returns { name, when } — `when` is the raw time phrase (parsed downstream by the schedule parser). The
 * "reply to / get back to / follow up with" verb is required so a plain reminder isn't hijacked. */
export function parseFollowUp(text: string): { name: string; when: string } | null {
  // Drop a trailing courtesy so "follow up with Sarah in 3 days please" yields when="in 3 days", not
  // "in 3 days please" — the latter fails the schedule parser -> a valid follow-up dead-ends "unparsed"
  // (courtesy-tail bug class; the WHEN clause sits at the tail, exactly where the courtesy lands).
  const t = stripTrailingCourtesy(text.trim());
  // <lead> <contact> <when>. The when clause is a trailing time phrase (in N days / tomorrow / on Friday
  // / next week / at 3pm). Capture the contact between the verb and the when.
  const m = t.match(
    /^\s*(?:(?:can\s+you\s+)?(?:remind|nudge)\s+me\s+to\s+(?:reply\s+to|get\s+back\s+to|follow\s+up\s+with|message|text|email|call|ping|check\s+in\s+with)|follow\s+up\s+with|check\s+in\s+with|circle\s+back\s+(?:with|to))\s+(.+?)\s+((?:in\s+.+|tomorrow.*|tonight.*|on\s+.+|next\s+.+|this\s+.+|at\s+.+|by\s+.+))$/i,
  );
  if (!m) return null;
  const name = normalizeContactName(m[1]!.replace(/^(?:about|re:?)\s+/i, ""));
  const when = m[2]!.trim();
  if (!name || isValueWord(name) || !when) return null;
  return { name, when };
}

// A name that's really just a value/keyword (not a person) — guard against saving "email"/"number" as a contact.
function isValueWord(name: string): boolean {
  return /^(email|e-?mail|number|phone|cell|mobile|address|contact|a contact)$/i.test(name.trim());
}

/** Parse "forget <name>'s contact" / "delete contact <name>" -> the name, or null. Exported for tests. */
export function parseForgetContact(text: string): string | null {
  const t = text.trim();
  const m = t.match(/^\s*(?:forget|delete|remove)\s+(?:the\s+)?contact\s+(?:for\s+)?(.+?)\s*$/i)
    ?? t.match(/^\s*(?:forget|delete|remove)\s+(.+?)['']?s\s+contact\s*$/i)
    // "remove <name> from (my) contacts" / "delete <name> from contacts" (forget-contact-natural).
    ?? t.match(/^\s*(?:forget|delete|remove|drop)\s+(.+?)\s+from\s+(?:my\s+)?contacts?\s*$/i)
    // Bare "forget <name>" — the caller checks it against SAVED contacts + returns null (falls through)
    // when it isn't one, so an unrelated "forget X" isn't stolen (this parse is the broadest, checked
    // LAST in the handler after fact/place). Exclude the fact-forget lead words (everything/all/what/that/
    // the) so it never shadows parseForgetFact, and keep the name short (a person, not a sentence).
    ?? t.match(/^\s*(?:forget|delete)\s+(?!(?:everything|all|what|that|the)\b)([a-z][\w' -]{0,29}?)\s*$/i);
  if (!m) return null;
  const name = normalizeContactName(m[1]!);
  return name || null;
}

export class ContactStore {
  private file: string;
  private items: ChatContacts[] = [];
  private lastWriteOk = true;
  constructor(opts: { file: string }) { this.file = opts.file; this.load(); }

  private load(): void {
    const obj = readJsonSafe<{ items?: ChatContacts[] }>(this.file);
    if (obj && Array.isArray(obj.items)) this.items = obj.items.filter((c) => c && typeof c.chatId === "number" && Array.isArray(c.contacts));
  }
  private persist(): boolean { return (this.lastWriteOk = atomicWriteJson(this.file, { v: 1, items: this.items })); }
  /** Did the most recent write succeed? (persist-bool-all-stores) */
  lastSaveOk(): boolean { return this.lastWriteOk; }

  private forChat(chatId: number): ChatContacts {
    let c = this.items.find((x) => x.chatId === chatId);
    if (!c) { c = { chatId, contacts: [] }; this.items.push(c); }
    return c;
  }

  /** Save/merge a contact (a new email/phone updates the existing one by name). Returns the stored
   * contact, or null if the per-chat cap is hit on a NEW contact. */
  save(chatId: number, s: SaveContact, now: number): Contact | null {
    const name = normalizeContactName(s.name);
    if (!name) return null;
    const c = this.forChat(chatId);
    let existing = c.contacts.find((x) => x.name === name);
    if (!existing) {
      if (c.contacts.length >= MAX_CONTACTS_PER_CHAT) return null;
      existing = { name, created: now }; c.contacts.push(existing);
    }
    if (s.email) existing.email = s.email;
    if (s.phone) existing.phone = s.phone;
    this.persist();
    return existing;
  }

  /** Look up a contact by name (normalized exact, then a word-overlap fallback so "text my mom" finds
   * "mom"). Returns the contact or null. */
  get(chatId: number, name: string): Contact | null {
    const c = this.items.find((x) => x.chatId === chatId);
    if (!c) return null;
    const n = normalizeContactName(name);
    if (!n) return null;
    const exact = c.contacts.find((x) => x.name === n);
    if (exact) return exact;
    // Fuzzy: a contact matches only when EVERY word of its name appears in the query ("email the big
    // boss" -> "big boss"; "text mom" -> "mom"), so a SHORTER query can't drag in a longer contact —
    // "text mom" must NOT resolve to "mom's doctor" (contact-wrong-person-draft: a confident draft to the
    // wrong person is one tap from sending). And we only return on a UNIQUE match: if 2+ contacts match
    // (or none), return null so the caller asks which instead of guessing. A partial-word contact name
    // ("mom doctor") requires ALL its words present, so a bare "mom" query never selects it.
    const words = new Set(n.split(" "));
    const hits = c.contacts.filter((x) => x.name.split(" ").every((w) => words.has(w)));
    if (!hits.length) return null;
    if (hits.length === 1) return hits[0]!;
    // Multiple contacts' names are all-present in the query (e.g. query "email the big boss" matches both
    // "boss" and "big boss"). Prefer the MOST-specific — the one with the most name-words — but only when
    // that maximum is UNIQUE; a genuine tie (two equally-specific contacts) returns null so the caller
    // asks which rather than guessing (contact-wrong-person-draft).
    const maxWords = Math.max(...hits.map((x) => x.name.split(" ").length));
    const top = hits.filter((x) => x.name.split(" ").length === maxWords);
    return top.length === 1 ? top[0]! : null;
  }

  /** All contacts for a chat (for a "/contacts" list). */
  list(chatId: number): Contact[] { return this.items.find((x) => x.chatId === chatId)?.contacts ?? []; }

  /** Delete a contact by name. Returns true if one was removed. */
  forget(chatId: number, name: string): boolean {
    const c = this.items.find((x) => x.chatId === chatId);
    if (!c) return false;
    const n = normalizeContactName(name);
    const before = c.contacts.length;
    c.contacts = c.contacts.filter((x) => x.name !== n);
    const removed = c.contacts.length < before;
    if (removed) this.persist();
    return removed;
  }
}
