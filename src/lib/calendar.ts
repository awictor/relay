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
/** "YYYY-MM-DD" -> "YYYYMMDD" for an all-day VALUE=DATE field. */
function icsDate(date: string): string { return date.replace(/-/g, ""); }
/** Escape an iCalendar text value (RFC-5545: backslash, comma, semicolon, newline). */
function icsText(s: string): string {
  return String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** Build the raw .ics (VCALENDAR/VEVENT) text for an event. `nowMs` stamps DTSTAMP (injected so it's
 * deterministic). All-day (startDate) uses VALUE=DATE; a timed event uses a UTC DTSTART/DTEND. */
export function buildIcs(ev: CalEvent, nowMs: number): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Relay//EN", "BEGIN:VEVENT", `DTSTAMP:${icsStamp(nowMs)}`, `UID:relay-${nowMs}@relay`];
  if (ev.startDate) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(ev.startDate)}`);
  } else if (ev.startMs !== undefined) {
    lines.push(`DTSTART:${icsStamp(ev.startMs)}`);
    lines.push(`DTEND:${icsStamp(ev.startMs + (ev.durationMin ?? 60) * 60_000)}`);
  }
  lines.push(`SUMMARY:${icsText(ev.title)}`);
  if (ev.location) lines.push(`LOCATION:${icsText(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${icsText(ev.description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

/** A Google Calendar "create event" template URL — the one-tap add on mobile/desktop. Dates use the
 * GCal format (all-day: YYYYMMDD/YYYYMMDD; timed: the UTC stamps). */
export function gcalLink(ev: CalEvent): string {
  const p = new URLSearchParams({ action: "TEMPLATE", text: ev.title });
  if (ev.startDate) {
    const d = icsDate(ev.startDate);
    // GCal all-day end is exclusive (next day); keep it same-day single by +1.
    const end = icsDate(new Date(new Date(ev.startDate + "T00:00:00Z").getTime() + 86_400_000).toISOString().slice(0, 10));
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
