// Contacts book (contacts-book-compose): compose (draft email/text) only worked if the user re-typed a
// raw address/number every time, so its highest-intent use — "text mom I'm late" — dead-ended asking
// for a number. A user saves a person once ("mom's number is 555-1234", "boss's email is b@co.com") and
// then "text mom ..." / "email my boss ..." drafts straight to the saved handle. Small atomic + corrupt-
// safe JSON store keyed by chatId, mirroring NotesStore. Pure parse helpers exported + unit-tested.
// Distinct from the deferred login/autofill VAULT (credentials): this is just a name -> email/phone book,
// and it's the natural feeder for a future confirm-to-send. Relay still never SENDS — it drafts.
import { atomicWriteJson, readJsonSafe } from "./safe-store.js";

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
  let m = t.match(/^\s*(?:save\s+|add\s+|remember\s+)?(?:contact\s+)?(.+?)['']?s?\s+(?:number|phone|cell|mobile|email|e-?mail|address)\s*(?:is|are|:|=|as)?\s*/i);
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

// A name that's really just a value/keyword (not a person) — guard against saving "email"/"number" as a contact.
function isValueWord(name: string): boolean {
  return /^(email|e-?mail|number|phone|cell|mobile|address|contact|a contact)$/i.test(name.trim());
}

/** Parse "forget <name>'s contact" / "delete contact <name>" -> the name, or null. Exported for tests. */
export function parseForgetContact(text: string): string | null {
  const m = text.trim().match(/^\s*(?:forget|delete|remove)\s+(?:the\s+)?contact\s+(?:for\s+)?(.+?)\s*$/i)
    ?? text.trim().match(/^\s*(?:forget|delete|remove)\s+(.+?)['']?s\s+contact\s*$/i);
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
    // Word-overlap: the query contains the contact's name as a whole word (or vice-versa) — "email my
    // boss the update" -> "boss". Pick the longest-name match to prefer "big boss" over "boss".
    const words = new Set(n.split(" "));
    const hits = c.contacts.filter((x) => x.name.split(" ").some((w) => words.has(w)));
    if (!hits.length) return null;
    return hits.sort((a, b) => b.name.length - a.name.length)[0]!;
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
