import { describe, it, expect, afterEach } from "vitest";
import { normalizeContactName, parseSaveContact, parseForgetContact, ContactStore } from "../src/lib/contacts.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), "relay-contacts-")); dirs.push(d); return join(d, "c.json"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d.replace(/\/c\.json$/, ""), { recursive: true, force: true }); });

describe("normalizeContactName", () => {
  it("strips my/the + possessive 's, lowercases", () => {
    expect(normalizeContactName("my boss")).toBe("boss");
    expect(normalizeContactName("Mom's")).toBe("mom");
    expect(normalizeContactName("the landlord")).toBe("landlord");
    expect(normalizeContactName("Dr. Smith")).toBe("dr. smith");
  });
});

describe("parseSaveContact", () => {
  it("parses '<name>'s number is <phone>'", () => {
    expect(parseSaveContact("save mom's number is 555-123-4567")).toEqual({ name: "mom", phone: "5551234567" });
    expect(parseSaveContact("dave's cell is (555) 987 6543")).toEqual({ name: "dave", phone: "5559876543" });
  });
  it("parses '<name>'s email is <email>'", () => {
    expect(parseSaveContact("my boss's email is boss@co.com")).toEqual({ name: "boss", email: "boss@co.com" });
  });
  it("parses 'save contact <name> <value>'", () => {
    expect(parseSaveContact("save contact Sam sam@x.com")).toEqual({ name: "sam", email: "sam@x.com" });
    expect(parseSaveContact("add contact mom 5550001111")).toEqual({ name: "mom", phone: "5550001111" });
  });
  it("returns null when there's no phone/email, or the name is a value word", () => {
    expect(parseSaveContact("save the world")).toBeNull();
    expect(parseSaveContact("remember I'm vegetarian")).toBeNull();
    expect(parseSaveContact("email is boss@co.com")).toBeNull(); // "email" isn't a person
  });
});

describe("parseForgetContact", () => {
  it("parses delete/forget contact phrasings", () => {
    expect(parseForgetContact("forget mom's contact")).toBe("mom");
    expect(parseForgetContact("delete contact for dave")).toBe("dave");
    expect(parseForgetContact("remove the contact for my boss")).toBe("boss");
  });
  it("returns null for a non-forget message", () => {
    expect(parseForgetContact("what's on my list")).toBeNull();
  });
});

describe("ContactStore", () => {
  it("saves, resolves by exact + fuzzy name, and merges a second handle", () => {
    const s = new ContactStore({ file: tmp() });
    s.save(1, { name: "mom", phone: "5551234567" }, 0);
    expect(s.get(1, "mom")!.phone).toBe("5551234567");
    // fuzzy: "text my mom tonight" -> mom
    expect(s.get(1, "text my mom tonight")?.name).toBe("mom");
    // merge an email onto the same contact
    s.save(1, { name: "mom", email: "mom@x.com" }, 1);
    const m = s.get(1, "mom")!;
    expect(m.phone).toBe("5551234567");
    expect(m.email).toBe("mom@x.com");
  });
  it("keeps contacts separate per chat", () => {
    const s = new ContactStore({ file: tmp() });
    s.save(1, { name: "mom", phone: "111" }, 0);
    s.save(2, { name: "mom", phone: "222" }, 0);
    expect(s.get(1, "mom")!.phone).toBe("111");
    expect(s.get(2, "mom")!.phone).toBe("222");
  });
  it("forgets a contact", () => {
    const s = new ContactStore({ file: tmp() });
    s.save(1, { name: "mom", phone: "111" }, 0);
    expect(s.forget(1, "mom")).toBe(true);
    expect(s.get(1, "mom")).toBeNull();
    expect(s.forget(1, "nobody")).toBe(false);
  });
  it("persists across instances + reports lastSaveOk", () => {
    const f = tmp();
    const s = new ContactStore({ file: f });
    s.save(1, { name: "boss", email: "b@co.com" }, 0);
    expect(s.lastSaveOk()).toBe(true);
    expect(new ContactStore({ file: f }).get(1, "boss")!.email).toBe("b@co.com");
  });
  it("prefers the longest-name match on fuzzy overlap", () => {
    const s = new ContactStore({ file: tmp() });
    s.save(1, { name: "boss", email: "boss@x.com" }, 0);
    s.save(1, { name: "big boss", email: "bigboss@x.com" }, 0);
    expect(s.get(1, "email the big boss")!.name).toBe("big boss");
  });
});
