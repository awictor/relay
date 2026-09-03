import { describe, it, expect } from "vitest";
import { mailtoLink, smsLink, formatDraft } from "../src/lib/compose.js";

describe("mailtoLink (draft-to-send-composer)", () => {
  it("builds a mailto with encoded subject + body", () => {
    const link = mailtoLink({ kind: "email", to: "bob@example.com", subject: "Re: rent", body: "Hi Bob,\nThanks!" });
    expect(link).toBe("mailto:bob@example.com?subject=Re%3A%20rent&body=Hi%20Bob%2C%0AThanks!");
  });
  it("omits an invalid address but keeps subject/body", () => {
    const link = mailtoLink({ kind: "email", to: "not an email", subject: "Hi", body: "x" });
    expect(link).toBe("mailto:?subject=Hi&body=x");
  });
});

describe("smsLink", () => {
  it("builds an sms link, stripping phone formatting", () => {
    expect(smsLink({ kind: "message", to: "+1 (512) 555-1212", body: "on my way" })).toBe("sms:+15125551212?body=on%20my%20way");
  });
  it("omits a non-phone recipient", () => {
    expect(smsLink({ kind: "message", to: "bob", body: "hi" })).toBe("sms:?body=hi");
  });
});

describe("formatDraft", () => {
  it("renders an email copy block + tap-to-send link", () => {
    const out = formatDraft({ kind: "email", to: "bob@x.com", subject: "Rent", body: "Hi Bob," });
    expect(out).toMatch(/✉️ Draft email/);
    expect(out).toMatch(/To: bob@x\.com/);
    expect(out).toMatch(/Subject: Rent/);
    expect(out).toMatch(/Hi Bob,/);
    expect(out).toMatch(/Tap to send: mailto:bob@x\.com\?subject=Rent/);
  });
  it("renders a message draft with an sms link", () => {
    const out = formatDraft({ kind: "message", to: "+15125551212", body: "running late" });
    expect(out).toMatch(/💬 Draft message/);
    expect(out).toMatch(/Tap to send: sms:\+15125551212\?body=running%20late/);
  });
});
