import { describe, it, expect } from "vitest";
import { resolveLeague, scoreboardUrl, parseScoreboard, filterByTeam, formatGame, formatScores, getScores } from "../src/lib/scores.js";

// Minimal ESPN cdn.espn.com scoreboard shape: content.sbData.events[].competitions[0].competitors[].
function board(events: unknown[]) {
  return JSON.stringify({ content: { sbData: { events } } });
}
const game = (opts: { home: string; away: string; hs?: string; as?: string; state?: string; detail?: string }) => ({
  status: { type: { state: opts.state ?? "post", shortDetail: opts.detail ?? "Final" } },
  competitions: [{
    competitors: [
      { homeAway: "home", score: opts.hs, team: { shortDisplayName: opts.home, displayName: opts.home, abbreviation: opts.home.slice(0, 3).toUpperCase() } },
      { homeAway: "away", score: opts.as, team: { shortDisplayName: opts.away, displayName: opts.away, abbreviation: opts.away.slice(0, 3).toUpperCase() } },
    ],
  }],
});

describe("resolveLeague", () => {
  it("resolves an explicit league word", () => {
    expect(resolveLeague("NBA scores")!.league).toBe("nba");
    expect(resolveLeague("premier league today")!.league).toBe("eng.1");
    expect(resolveLeague("college basketball")!.league).toBe("mens-college-basketball");
  });
  it("routes a known team to its league", () => {
    expect(resolveLeague("did the Lakers win")!.league).toBe("nba");
    expect(resolveLeague("man city score")!.league).toBe("eng.1");
    expect(resolveLeague("yankees game")!.league).toBe("mlb");
  });
  it("returns null for an unknown query", () => {
    expect(resolveLeague("underwater basket weaving")).toBeNull();
    expect(resolveLeague("")).toBeNull();
  });
  it("does NOT guess a sport for a cross-sport ambiguous team name (scores-ambiguous-team-wrong-sport)", () => {
    // "Giants" = SF (MLB) or NY (NFL); "Rangers" = Texas (MLB) / NY (NHL) / Rangers FC. A bare name must
    // NOT confidently answer one sport -> null so the agent asks which.
    expect(resolveLeague("did the giants win")).toBeNull();
    expect(resolveLeague("rangers score")).toBeNull();
    // but naming the league still resolves.
    expect(resolveLeague("giants NFL score")!.league).toBe("nfl");
    expect(resolveLeague("rangers NHL")!.league).toBe("nhl");
    expect(resolveLeague("rangers MLB game")!.league).toBe("mlb");
  });
});

describe("scoreboardUrl", () => {
  it("uses cdn.espn.com (tolerates a plain UA), soccer nests under soccer/<league>", () => {
    expect(scoreboardUrl({ sport: "basketball", league: "nba", name: "NBA" })).toBe("https://cdn.espn.com/core/nba/scoreboard?xhr=1");
    expect(scoreboardUrl({ sport: "soccer", league: "eng.1", name: "EPL" })).toBe("https://cdn.espn.com/core/soccer/eng.1/scoreboard?xhr=1");
  });
});

describe("parseScoreboard", () => {
  it("parses final + live + scheduled games", () => {
    const body = board([
      game({ home: "Celtics", away: "Lakers", hs: "98", as: "102", state: "post", detail: "Final" }),
      game({ home: "Heat", away: "Knicks", hs: "55", as: "60", state: "in", detail: "Q3 4:21" }),
      game({ home: "Suns", away: "Nuggets", state: "pre", detail: "10/3 - 7:00 PM EDT" }),
    ]);
    const g = parseScoreboard(body);
    expect(g).toHaveLength(3);
    expect(g[0]).toMatchObject({ home: "Celtics", away: "Lakers", homeScore: 98, awayScore: 102, state: "post" });
    expect(g[1]!.state).toBe("in");
    expect(g[2]!.state).toBe("pre");
    expect(g[2]!.homeScore).toBeUndefined();
  });
  it("returns [] on malformed input", () => {
    expect(parseScoreboard("not json")).toEqual([]);
    expect(parseScoreboard(JSON.stringify({ content: {} }))).toEqual([]);
  });
});

describe("filterByTeam", () => {
  const games = parseScoreboard(board([
    game({ home: "Celtics", away: "Lakers", hs: "98", as: "102" }),
    game({ home: "Heat", away: "Knicks", hs: "55", as: "60" }),
  ]));
  it("narrows to a named team", () => {
    const only = filterByTeam(games, "did the lakers win");
    expect(only).toHaveLength(1);
    expect(only[0]!.away).toBe("Lakers");
  });
  it("returns all games when no team is named (league-wide ask)", () => {
    expect(filterByTeam(games, "nba scores")).toHaveLength(2);
  });
});

describe("formatGame / formatScores", () => {
  it("formats final, live, and scheduled", () => {
    expect(formatGame({ home: "Celtics", away: "Lakers", homeScore: 98, awayScore: 102, state: "post", detail: "Final" }))
      .toBe("Lakers 102, Celtics 98 (Final)");
    expect(formatGame({ home: "Heat", away: "Knicks", homeScore: 55, awayScore: 60, state: "in", detail: "Q3 4:21" }))
      .toBe("Knicks 60, Heat 55 (Q3 4:21)");
    expect(formatGame({ home: "Suns", away: "Nuggets", state: "pre", detail: "10/3 - 7:00 PM EDT" }))
      .toBe("Nuggets @ Suns — 10/3 - 7:00 PM EDT");
  });
  it("formatScores caps + notes none", () => {
    expect(formatScores("NBA", [])).toMatch(/No NBA games/);
    const many = Array.from({ length: 10 }, (_, i) => ({ home: `H${i}`, away: `A${i}`, homeScore: 1, awayScore: 2, state: "post" as const, detail: "Final" }));
    const out = formatScores("NBA", many);
    expect(out).toMatch(/…and 2 more/);
  });
});

describe("getScores", () => {
  it("resolves the league, fetches, parses, and filters to the team", async () => {
    let seen = "";
    const r = await getScores("did the Lakers win", async (u) => {
      seen = u;
      return board([game({ home: "Celtics", away: "Lakers", hs: "98", as: "102" }), game({ home: "Heat", away: "Knicks", hs: "1", as: "2" })]);
    });
    expect(seen).toContain("/nba/scoreboard");
    expect(r!.leagueName).toBe("NBA");
    expect(r!.games).toHaveLength(1); // filtered to Lakers
  });
  it("returns null for an unresolvable league (caller falls back to web_search)", async () => {
    expect(await getScores("cricket in mumbai", async () => board([]))).toBeNull();
  });
  it("returns null on a fetch throw", async () => {
    expect(await getScores("nba scores", async () => { throw new Error("net"); })).toBeNull();
  });
  it("flags teamNotPlaying (empty games) when the named team has no game today, NOT the whole slate (scores-team-not-playing-dumps-slate)", async () => {
    // Lakers asked, but tonight's slate is Celtics/Heat only -> must NOT dump those as the answer.
    const r = await getScores("did the Lakers win", async () =>
      board([game({ home: "Celtics", away: "Heat", hs: "98", as: "90" })]));
    expect(r!.teamNotPlaying).toBe(true);
    expect(r!.games).toHaveLength(0);
  });
  it("flags teamNotPlaying even when the query ALSO names the league (scores-team-not-playing-with-league-word)", async () => {
    // "did the Lakers win, NBA scores?" resolves the league via the LEAGUES word, but still names a team.
    const r = await getScores("did the Lakers win, NBA scores?", async () =>
      board([game({ home: "Celtics", away: "Heat", hs: "98", as: "90" })]));
    expect(r!.teamNotPlaying).toBe(true);
    expect(r!.games).toHaveLength(0);
  });

  it("a league-wide ask (no team) still returns the whole slate", async () => {
    const r = await getScores("NBA scores", async () =>
      board([game({ home: "Celtics", away: "Heat", hs: "98", as: "90" }), game({ home: "Suns", away: "Kings", hs: "1", as: "2" })]));
    expect(r!.teamNotPlaying).toBeUndefined();
    expect(r!.games).toHaveLength(2);
  });
});
