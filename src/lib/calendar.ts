// Calendar export (ics-calendar-export): a found event/deadline/reminder dead-ended at text. This turns
// it into an add-to-calendar artifact — an .ics VEVENT (as a data: URL) plus a Google Calendar
// template link — so the errand ends in the user's real calendar. Like the composer, Relay produces
// the artifact; the user imports it (never touches their account). Pure formatting; agent supplies the
// event fields. Times are handled as either an all-day date (YYYY-MM-DD) or a UTC instant (epoch ms).

export interface CalEvent {
  title: string;
  startMs?: number;    // event start as epoch ms (a timed event) — rendered as a UTC stamp
  startDate?: string;  // OR an all-day date "YYYY-MM-DD" (no time)
  durationMin?: number; // timed event length (default 60); ignored for all-day
  location?: string;
  description?: string;
}

/** Format epoch ms as an iCalendar UTC timestamp: 20240601T130000Z. */
function icsStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
/** A strict YYYY-MM-DD date, or null. Rejects unpadded ("2026-6-3") / non-ISO ("June 3") input so a
 * malformed all-day date can't produce a broken .ics or throw in gcalLink. Exported for tests. */
export function normalizeIsoDate(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  // Round-trip guard: rejects impossible dates (2026-02-31 -> normalizes to Mar 3, not equal).
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== `${y}-${mo}-${d}` ? null : `${y}-${mo}-${d}`;
}
/** "YYYY-MM-DD" -> "YYYYMMDD" for an all-day VALUE=DATE field. */
function icsDate(date: string): string { return date.replace(/-/g, ""); }
/** Escape an iCalendar text value (RFC-5545: backslash, comma, semicolon, newline). */
function icsText(s: string): string {
  return String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** Fold a content line to RFC-5545's 75-OCTET limit (ics-line-fold): a longer SUMMARY/DESCRIPTION/LOCATION
 * emits one >75-char line, which strict importers (Apple Calendar, some Outlook) reject or truncate — so a
 * long event silently fails to import. Continuation lines start with a single space; we measure BYTES
 * (UTF-8) so a multi-byte char isn't split at a boundary that overflows an octet count. */
function foldIcsLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "", curBytes = 0, first = true;
  for (const ch of line) {          // iterate by code point, not char, so a surrogate pair stays intact
    const chBytes = enc.encode(ch).length;
    // First line caps at 75; continuation lines carry a leading space, so their content caps at 74.
    const cap = first ? 75 : 74;
    if (curBytes + chBytes > cap) { out.push(first ? cur : " " + cur); first = false; cur = ""; curBytes = 0; }
    cur += ch; curBytes += chBytes;
  }
  if (cur) out.push(first ? cur : " " + cur);
  return out.join("\r\n");
}

/** Build the raw .ics (VCALENDAR/VEVENT) text for an event. `nowMs` stamps DTSTAMP (injected so it's
 * deterministic). All-day (startDate) uses VALUE=DATE; a timed event uses a UTC DTSTART/DTEND. */
export function buildIcs(ev: CalEvent, nowMs: number): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Relay//EN", "BEGIN:VEVENT", `DTSTAMP:${icsStamp(nowMs)}`, `UID:relay-${nowMs}@relay`];
  const isoDate = normalizeIsoDate(ev.startDate);
  if (isoDate) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(isoDate)}`);
  } else if (ev.startMs !== undefined) {
    lines.push(`DTSTART:${icsStamp(ev.startMs)}`);
    lines.push(`DTEND:${icsStamp(ev.startMs + (ev.durationMin ?? 60) * 60_000)}`);
  }
  lines.push(`SUMMARY:${icsText(ev.title)}`);
  if (ev.location) lines.push(`LOCATION:${icsText(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${icsText(ev.description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  // Fold every content line to the 75-octet cap (ics-line-fold) so a long summary/description imports
  // cleanly into strict calendar apps instead of being rejected/truncated.
  return lines.map(foldIcsLine).join("\r\n");
}

/** A Google Calendar "create event" template URL — the one-tap add on mobile/desktop. Dates use the
 * GCal format (all-day: YYYYMMDD/YYYYMMDD; timed: the UTC stamps). */
export function gcalLink(ev: CalEvent): string {
  const p = new URLSearchParams({ action: "TEMPLATE", text: ev.title });
  const isoDate = normalizeIsoDate(ev.startDate);
  if (isoDate) {
    const d = icsDate(isoDate);
    // GCal all-day end is exclusive (next day); keep it same-day single by +1.
    const end = icsDate(new Date(new Date(isoDate + "T00:00:00Z").getTime() + 86_400_000).toISOString().slice(0, 10));
    p.set("dates", `${d}/${end}`);
  } else if (ev.startMs !== undefined) {
    p.set("dates", `${icsStamp(ev.startMs)}/${icsStamp(ev.startMs + (ev.durationMin ?? 60) * 60_000)}`);
  }
  if (ev.location) p.set("location", ev.location);
  if (ev.description) p.set("details", ev.description);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

/** Render the user-facing artifact: a title/when line, the Google-cal one-tap link, and the raw .ics
 * as a data: URL (for calendar apps that import a file). Pure; exported for tests. */
export function formatCalendar(ev: CalEvent, nowMs: number): string {
  const ics = buildIcs(ev, nowMs);
  const dataUrl = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
  const when = ev.startDate ? ev.startDate : ev.startMs !== undefined ? new Date(ev.startMs).toUTCString() : "(no time set)";
  return [
    `📅 ${ev.title} — ${when}`,
    ev.location ? `Where: ${ev.location}` : "",
    `Add to Google Calendar: ${gcalLink(ev)}`,
    `Or import (.ics): ${dataUrl}`,
  ].filter(Boolean).join("\n");
}
