// Chart-a-watch (chart-it-tool): a watch/alert accumulates a numeric series (watch-time-series), but the
// only payoff was a one-line text trend. "chart btc" / "graph my btc watch this week" now renders that
// series as a texted line-chart IMAGE via the keyless quickchart.io renderer (no signup) — the natural
// visual payoff for data Relay already stores, and a free-infra edge no vendor-browser competitor
// matches. Pure helpers (parse + URL build); the PNG fetch is injected + sent via the existing sendPhoto
// path. Distinct from watchTrend (text): this is explicitly asked as a chart/graph/plot.

/** Parse a "chart <name>" request into the watch name + optional lookback window (ms), or null when it
 * isn't a chart ask. Requires an explicit chart/graph/plot/visualize word so "how has btc moved" (the
 * TEXT trend) still routes to watchTrend. Handles "chart btc", "graph my btc watch", "plot eth this
 * week", "chart of gold over the last month". Exported for tests. */
export function parseChartRequest(text: string, now: number): { name: string; sinceMs?: number } | null {
  const t = text.trim();
  if (!/\b(chart|graph|plot|visuali[sz]e)\b/i.test(t)) return null;
  const DAY = 86_400_000;
  const windowMs = /\btoday\b/i.test(t) ? DAY
    : /\bthis week\b|\bpast week\b|\blast (?:7 days|week)\b/i.test(t) ? 7 * DAY
    : /\bthis month\b|\bpast month\b|\blast (?:30 days|month)\b/i.test(t) ? 30 * DAY
    : undefined;
  const m =
    t.match(/^\s*(?:chart|graph|plot|visuali[sz]e)\s+(?:me\s+|us\s+)?(?:the\s+)?(?:my\s+)?(.+?)\s*$/i)
    || t.match(/^\s*(?:show|give)\s+(?:me\s+|us\s+)?(?:a\s+)?(?:chart|graph|plot)\s+(?:of|for)\s+(.+?)\s*$/i)
    // Noun-FIRST: "btc chart" / "my weight graph" — the trailing chart/graph word (chart-noun-first),
    // a natural ordering the verb-first patterns above missed.
    || t.match(/^\s*(?:my\s+|the\s+)?(.+?)\s+(?:chart|graph|plot)(?:\s+(?:this week|this month|today|over time|so far|lately|recently))?\s*$/i);
  if (!m) return null;
  let name = m[1]!
    .replace(/\b(chart|graph|plot|visuali[sz]e)\b/gi, "")
    .replace(/\b(this week|this month|today|over time|so far|lately|recently|watch|of|for)\b/gi, "")
    .replace(/\bover the (?:last|past)\s+\w+\b/gi, "")
    .replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 60);
  if (!name) return null;
  return windowMs !== undefined ? { name, sinceMs: now - windowMs } : { name };
}

// A short date/time label for a point, given the whole span. Sub-2-day span -> HH:MM, else M/D.
function pointLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  if (spanMs < 2 * 86_400_000) return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** Build a keyless quickchart.io line-chart URL from a numeric series, or null if <2 points (nothing to
 * plot). Labels are derived from timestamps; the dataset is labeled with `name`. Exported for tests. */
export function chartUrl(name: string, points: Array<{ t: number; v: number }>, sinceMs?: number): string | null {
  const pts = (sinceMs !== undefined ? points.filter((p) => p.t >= sinceMs) : points).slice().sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const spanMs = pts[pts.length - 1]!.t - pts[0]!.t;
  const config = {
    type: "line",
    data: {
      labels: pts.map((p) => pointLabel(p.t, spanMs)),
      datasets: [{ label: name, data: pts.map((p) => p.v), fill: false, borderColor: "#2563eb", tension: 0.2 }],
    },
    options: { plugins: { legend: { display: true } }, scales: { y: { beginAtZero: false } } },
  };
  // quickchart.io renders a Chart.js config passed as the `c` query param. w/h keep it phone-friendly.
  return `https://quickchart.io/chart?w=600&h=360&devicePixelRatio=1&c=${encodeURIComponent(JSON.stringify(config))}`;
}

/**
 * Render a watch's series to a PNG. `points` is the stored series; `fetchBytes` is injected (a guarded
 * GET returning bytes in prod, a fake in tests). Returns the PNG bytes, or null when there's nothing to
 * plot / the render fails (caller falls back to the text trend). Exported for the handler wiring.
 */
export async function renderChart(
  name: string,
  points: Array<{ t: number; v: number }>,
  fetchBytes: (url: string) => Promise<Uint8Array>,
  sinceMs?: number,
): Promise<Uint8Array | null> {
  const url = chartUrl(name, points, sinceMs);
  if (!url) return null;
  try {
    const bytes = await fetchBytes(url);
    // A valid PNG starts with the 8-byte signature; anything else (an error page) -> null.
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return bytes;
    return null;
  } catch { return null; }
}
