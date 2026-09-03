// Rows-to-CSV (csv-export-compare): the compare/extract tools produce a JSON array of uniform objects
// (one row per URL), but pasted in chat it's a truncated blob the user can't sort or keep. This turns
// that array into a proper CSV document (sent via the existing sendDocument path) — keepable, sortable,
// shareable. Pure; no I/O.

/** RFC-4180 escape: wrap in double-quotes + double any inner quote when the value contains a comma,
 * quote, or newline. null/undefined -> empty cell. Objects -> compact JSON so nested data survives. */
function csvCell(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) s = "";
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  // CSV formula-injection guard: cells come from arbitrary scraped pages (untrusted). A value starting
  // with = + - @ (or a tab/CR that Excel treats as a formula lead) executes as a formula on open in
  // Excel/Sheets. Prefix a single quote to neutralize it — BUT don't corrupt a legitimate negative
  // number (e.g. "-5.2", "-1,000.00"), which is a normal data value that must stay sortable/summable.
  const isPlainNumber = /^-?\d[\d,]*(\.\d+)?$/.test(s);
  if (/^[=+\-@\t\r]/.test(s) && !isPlainNumber) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize an array of row objects to CSV. The header is the UNION of all rows' keys (in first-seen
 * order) so a row missing a field still lines up. Returns "" for an empty/invalid array. Pure; exported
 * for tests.
 */
export function rowsToCsv(rows: unknown): string {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      for (const k of Object.keys(row)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  if (!cols.length) return "";
  const lines = [cols.map(csvCell).join(",")];
  for (const row of rows) {
    const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    lines.push(cols.map((c) => csvCell(r[c])).join(","));
  }
  return lines.join("\r\n");
}
