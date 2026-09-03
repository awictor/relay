// Draft-to-send composer (draft-to-send-composer): Relay is deliberately read-only (it won't log in,
// pay, or hit "send" — see safety.ts). But an errand that dead-ends at "here's what I found" is half a
// job. This composes the artifact the USER sends: an email/message drafted by the agent, returned as a
// clean copy block PLUS a mailto:/sms:/tel: deep link so sending is one tap — Relay never sends it, so
// the DANGEROUS_ACTION guard is untouched. Pure formatting; the agent writes the draft text.

export interface Draft {
  kind: "email" | "message";   // email -> mailto: link; message/text -> sms: link
  to?: string;                 // recipient: an email address, or a phone number for a message
  subject?: string;            // email subject
  body: string;                // the drafted message text (the agent wrote it)
}

/** RFC-3986 encode a mailto/sms query component (spaces -> %20, not +). */
function enc(s: string): string { return encodeURIComponent(s).replace(/%20/g, "%20"); }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s().-]{5,}$/;

/** Build a mailto: link from an email draft (recipient optional; subject+body as query). */
export function mailtoLink(d: Draft): string {
  const addr = d.to && EMAIL_RE.test(d.to.trim()) ? d.to.trim() : "";
  const params: string[] = [];
  if (d.subject) params.push(`subject=${enc(d.subject)}`);
  if (d.body) params.push(`body=${enc(d.body)}`);
  return `mailto:${addr}${params.length ? "?" + params.join("&") : ""}`;
}

/** Build an sms: link from a message draft (number optional; body as the `body` query). */
export function smsLink(d: Draft): string {
  const num = d.to && PHONE_RE.test(d.to.trim()) ? d.to.trim().replace(/[\s().-]/g, "") : "";
  return `sms:${num}${d.body ? `?body=${enc(d.body)}` : ""}`;
}

/**
 * Render a draft into a user-facing artifact: a labeled copy block (subject + body) followed by the
 * one-tap deep link. The user reviews + sends; Relay never does. Pure; exported for tests.
 */
export function formatDraft(d: Draft): string {
  const lines: string[] = [];
  // Only show a "To:" line when the recipient is VALID for the kind — otherwise the deep link is built
  // with a blank address (tapping opens an unaddressed draft), so echoing "To: john at x.com" would
  // mislead the user into thinking it's addressed (compose-invalid-recipient). Flag the bad value instead.
  const validTo = d.to ? (d.kind === "email" ? EMAIL_RE.test(d.to.trim()) : PHONE_RE.test(d.to.trim())) : false;
  const toLine = validTo ? `To: ${d.to}` : (d.to ? `(Couldn't parse "${d.to}" as ${d.kind === "email" ? "an email address" : "a phone number"} — add the recipient yourself.)` : "");
  if (d.kind === "email") {
    lines.push("✉️ Draft email (review + send):");
    if (toLine) lines.push(toLine);
    if (d.subject) lines.push(`Subject: ${d.subject}`);
    lines.push("");
    lines.push(d.body);
    lines.push("");
    lines.push(`Tap to send: ${mailtoLink(d)}`);
  } else {
    lines.push("💬 Draft message (review + send):");
    if (toLine) lines.push(toLine);
    lines.push("");
    lines.push(d.body);
    lines.push("");
    lines.push(`Tap to send: ${smsLink(d)}`);
  }
  return lines.join("\n");
}
