// Sports scores (sports-scores-tool): "did the Lakers win?", "Man City score?", "who's playing tonight?"
// is a top text-a-friend errand AND the SYSTEM_PROMPT already advertises "who won the game" — but there
// was no tool, so it fell to a slow web_search + a scrape of JS-only scoreboard shells (flaky/empty).
// This hits the keyless ESPN scoreboard JSON (cdn.espn.com, no signup) for today's games in a league,
// with the score + status, mirroring get_crypto/get_weather. Pure parse/format helpers exported +
// unit-tested; the network fetch is injected (guarded GET in prod, a fake in tests).

export interface GameScore {
  home: string; away: string;        // team display names (short)
  homeScore?: number; awayScore?: number;
  state: "pre" | "in" | "post";      // scheduled / live / final
  detail: string;                    // "Final", "Q3 4:21", "10/3 - 7:00 PM EDT"
}

// Common league words -> ESPN {sport, league} path. Keyed lowercased. A user says "NBA scores" or names
// a team ("Lakers") — the team map below routes a team to its league. Not exhaustive; a miss returns null
// and the caller falls back to web_search.
const LEAGUES: Record<string, { sport: string; league: string; name: string }> = {
  nba: { sport: "basketball", league: "nba", name: "NBA" },
  wnba: { sport: "basketball", league: "wnba", name: "WNBA" },
  "college basketball": { sport: "basketball", league: "mens-college-basketball", name: "NCAAM" },
  ncaab: { sport: "basketball", league: "mens-college-basketball", name: "NCAAM" },
  nfl: { sport: "football", league: "nfl", name: "NFL" },
  "college football": { sport: "football", league: "college-football", name: "NCAAF" },
  ncaaf: { sport: "football", league: "college-football", name: "NCAAF" },
  mlb: { sport: "baseball", league: "mlb", name: "MLB" },
  nhl: { sport: "hockey", league: "nhl", name: "NHL" },
  epl: { sport: "soccer", league: "eng.1", name: "Premier League" },
  "premier league": { sport: "soccer", league: "eng.1", name: "Premier League" },
  laliga: { sport: "soccer", league: "esp.1", name: "La Liga" },
  "la liga": { sport: "soccer", league: "esp.1", name: "La Liga" },
  "serie a": { sport: "soccer", league: "ita.1", name: "Serie A" },
  bundesliga: { sport: "soccer", league: "ger.1", name: "Bundesliga" },
  "ligue 1": { sport: "soccer", league: "fra.1", name: "Ligue 1" },
  ucl: { sport: "soccer", league: "uefa.champions", name: "Champions League" },
  "champions league": { sport: "soccer", league: "uefa.champions", name: "Champions League" },
  mls: { sport: "soccer", league: "usa.1", name: "MLS" },
};

// A few well-known teams -> their league word, so "did the Lakers win" routes to NBA without the user
// naming the league. Lowercased whole-word/substring match on the query. Small on purpose — the common
// asks — and a team not here still works if the user names the league ("nba scores").
// DELIBERATELY EXCLUDES cross-sport ambiguous names (scores-ambiguous-team-wrong-sport): "giants" (SF
// MLB vs NY NFL), "rangers" (Texas MLB vs NY NHL vs Rangers FC), "kings" (LA NHL vs Sacramento NBA),
// "cardinals" (MLB vs NFL), "panthers" (NFL vs NHL), "jets" (NFL vs NHL). Mapping one of those to a
// single league would confidently answer the wrong sport with no hedge — worse than not knowing. A bare
// ambiguous team returns null here (-> the agent asks which), while naming the league ("NY Giants NFL
// score") still resolves via the LEAGUES word-match above. Only UNAMBIGUOUS team names live here.
const TEAM_LEAGUE: Array<[RegExp, string]> = [
  [/\b(lakers|celtics|warriors|knicks|bulls|heat|nets|bucks|suns|nuggets|mavericks|mavs|clippers|sixers|76ers)\b/i, "nba"],
  [/\b(yankees|red sox|dodgers|mets|cubs|astros|braves|phillies)\b/i, "mlb"],
  [/\b(chiefs|eagles|cowboys|packers|49ers|niners|patriots|bills|ravens|steelers)\b/i, "nfl"],
  [/\b(man city|manchester city|man united|manchester united|liverpool|arsenal|chelsea|tottenham|spurs)\b/i, "epl"],
  [/\b(real madrid|barcelona|barca|atletico)\b/i, "laliga"],
  [/\b(bruins|maple leafs|oilers|canucks|penguins)\b/i, "nhl"],
];

export interface LeagueRef { sport: string; league: string; name: string; }

/** Resolve a free-text sports query to an ESPN league ref, or null. Tries an explicit league word first,
 * then a known team. Exported for tests. */
export function resolveLeague(query: string): LeagueRef | null {
  const q = String(query ?? "").toLowerCase().trim();
  if (!q) return null;
  // Longest league key first so "college basketball" wins over "basketball" substrings.
  for (const key of Object.keys(LEAGUES).sort((a, b) => b.length - a.length)) {
    if (q.includes(key)) return LEAGUES[key]!;
  }
  for (const [re, leagueWord] of TEAM_LEAGUE) {
    if (re.test(q)) return LEAGUES[leagueWord]!;
  }
  return null;
}

/** The keyless ESPN scoreboard URL for a league (cdn.espn.com tolerates a plain UA + datacenter IPs,
 * unlike site.api.espn.com which 403s). Exported for tests. */
export function scoreboardUrl(ref: LeagueRef): string {
  return `https://cdn.espn.com/core/${ref.league === "eng.1" || ref.sport === "soccer" ? `soccer/${ref.league}` : ref.league}/scoreboard?xhr=1`;
}

/** Parse an ESPN scoreboard response into a list of games, or [] on any failure. Exported for tests. */
export function parseScoreboard(body: string): GameScore[] {
  try {
    const obj = JSON.parse(body) as {
      content?: { sbData?: { events?: Array<{
        status?: { type?: { state?: string; shortDetail?: string } };
        competitions?: Array<{ competitors?: Array<{ homeAway?: string; score?: string; team?: { displayName?: string; shortDisplayName?: string; abbreviation?: string } }> }>;
      }> } };
    };
    const events = obj.content?.sbData?.events ?? [];
    const out: GameScore[] = [];
    for (const e of events) {
      const comp = e.competitions?.[0];
      const cs = comp?.competitors ?? [];
      const home = cs.find((c) => c.homeAway === "home") ?? cs[0];
      const away = cs.find((c) => c.homeAway === "away") ?? cs[1];
      if (!home?.team || !away?.team) continue;
      const nm = (t: NonNullable<typeof home>["team"]) => t?.shortDisplayName || t?.displayName || t?.abbreviation || "?";
      const rawState = e.status?.type?.state;
      const state: GameScore["state"] = rawState === "in" ? "in" : rawState === "post" ? "post" : "pre";
      const hs = home.score !== undefined ? Number(home.score) : undefined;
      const as = away.score !== undefined ? Number(away.score) : undefined;
      out.push({
        home: nm(home.team), away: nm(away.team),
        ...(Number.isFinite(hs) ? { homeScore: hs } : {}),
        ...(Number.isFinite(as) ? { awayScore: as } : {}),
        state,
        detail: e.status?.type?.shortDetail ?? (state === "post" ? "Final" : ""),
      });
    }
    return out;
  } catch { return []; }
}

/** Filter games to those involving a named team (substring on either side), or all if no team named. */
export function filterByTeam(games: GameScore[], query: string): GameScore[] {
  const q = String(query ?? "").toLowerCase();
  // Pull the salient team token(s) out of the query by matching any game's team names against it.
  const hits = games.filter((g) => q.includes(g.home.toLowerCase()) || q.includes(g.away.toLowerCase())
    || g.home.toLowerCase().split(/\s+/).some((w) => w.length > 3 && q.includes(w))
    || g.away.toLowerCase().split(/\s+/).some((w) => w.length > 3 && q.includes(w)));
  return hits.length ? hits : games;
}

/** Format a game line: "Lakers 102, Celtics 98 (Final)" / "Heat @ Knicks — 10/3 7:00 PM". */
export function formatGame(g: GameScore): string {
  if (g.state === "pre") return `${g.away} @ ${g.home} — ${g.detail}`.trim();
  const score = `${g.away} ${g.awayScore ?? 0}, ${g.home} ${g.homeScore ?? 0}`;
  const tag = g.state === "post" ? (g.detail || "Final") : g.detail || "live";
  return `${score} (${tag})`;
}

/** Format a league's games into a short message, capped. */
export function formatScores(leagueName: string, games: GameScore[]): string {
  if (!games.length) return `No ${leagueName} games found for today.`;
  const shown = games.slice(0, 8).map((g) => `• ${formatGame(g)}`);
  const more = games.length > shown.length ? `\n…and ${games.length - shown.length} more` : "";
  return `${leagueName} — today:\n${shown.join("\n")}${more}`;
}

/**
 * Fetch scores for a sports query. `fetchText` is injected. Resolves the league (from a league word or a
 * team), fetches the keyless scoreboard, parses + filters to the named team when one is given. Returns
 * null when the league can't be resolved / fetch fails — the caller falls back to web_search.
 */
export async function getScores(
  query: string,
  fetchText: (url: string) => Promise<string>,
): Promise<{ leagueName: string; games: GameScore[] } | null> {
  const ref = resolveLeague(query);
  if (!ref) return null;
  try {
    const games = parseScoreboard(await fetchText(scoreboardUrl(ref)));
    return { leagueName: ref.name, games: filterByTeam(games, query) };
  } catch { return null; }
}
