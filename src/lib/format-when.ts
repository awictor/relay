// Human-friendly "next fire" time for a schedule confirmation (product-loop). A user scheduling
// "every morning" / "at 8" can't otherwise see WHEN it'll fire, so a wrong/absent timezone offset
// sends the first one at the wrong hour and looks broken. We render the resolved instant in the
// user's own zone (their profile offset, else the global default) so a mismatch is caught up front.

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed 9:00am", or "Wed Nov 15, 9:00am" if it's more than ~6 days out. offsetMin = minutes east of
 * UTC the user's wall-clock is in. `now` anchors the relative day words. Pure + deterministic. */
export function formatWhen(whenMs: number, offsetMin: number, now: number): string {
  const u = new Date(whenMs + offsetMin * 60_000);
  let h = u.getUTCHours();
  const m = u.getUTCMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12; if (h === 0) h = 12;
  const time = `${h}:${String(m).padStart(2, "0")}${ampm}`;
  const dowNow = new Date(now + offsetMin * 60_000);
  const daysOut = Math.floor((Date.UTC(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()) -
    Date.UTC(dowNow.getUTCFullYear(), dowNow.getUTCMonth(), dowNow.getUTCDate())) / 86_400_000);
  if (daysOut === 0) return `today ${time}`;
  if (daysOut === 1) return `tomorrow ${time}`;
  const dow = DOW[u.getUTCDay()]!;
  if (daysOut > 1 && daysOut <= 6) return `${dow} ${time}`;
  return `${dow} ${MON[u.getUTCMonth()]} ${u.getUTCDate()}, ${time}`;
}
