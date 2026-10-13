import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FootballApiService } from "../../infrastructure/services/footballApiService.js";

/**
 * Betting-analysis tools layered on top of API-Football.
 *
 * Design notes:
 * - Every tool returns compact JSON so Claude can reason over many matches
 *   without hitting context limits.
 * - Form / H2H tools compute the betting-relevant rates (BTTS, over 2.5,
 *   clean sheets, etc.) on the server, so the numbers are exact rather than
 *   estimated by the model.
 */

type Fixture = any;

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const FINISHED = new Set(["FT", "AET", "PEN"]);

function compactFixture(f: Fixture) {
  return {
    fixtureId: f.fixture.id,
    date: f.fixture.date,
    status: f.fixture.status.short,
    league: { id: f.league.id, name: f.league.name, season: f.league.season, round: f.league.round },
    home: { id: f.teams.home.id, name: f.teams.home.name },
    away: { id: f.teams.away.id, name: f.teams.away.name },
    goals: f.goals,
    halftime: f.score?.halftime,
  };
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

/** Summarise a list of finished fixtures from one team's point of view. */
function teamFormSummary(teamId: number, fixtures: Fixture[]) {
  const played = fixtures.filter((f) => FINISHED.has(f.fixture.status.short));
  let w = 0, d = 0, l = 0, gf = 0, ga = 0, btts = 0, o15 = 0, o25 = 0, o35 = 0;
  let cleanSheets = 0, failedToScore = 0, htLeading = 0;
  const sequence: string[] = [];

  for (const f of played) {
    const isHome = f.teams.home.id === teamId;
    const forG = (isHome ? f.goals.home : f.goals.away) ?? 0;
    const agG = (isHome ? f.goals.away : f.goals.home) ?? 0;
    const total = forG + agG;
    gf += forG;
    ga += agG;
    if (forG > agG) { w++; sequence.push("W"); }
    else if (forG === agG) { d++; sequence.push("D"); }
    else { l++; sequence.push("L"); }
    if (forG > 0 && agG > 0) btts++;
    if (total > 1.5) o15++;
    if (total > 2.5) o25++;
    if (total > 3.5) o35++;
    if (agG === 0) cleanSheets++;
    if (forG === 0) failedToScore++;
    const ht = f.score?.halftime;
    if (ht && ht.home != null && ht.away != null) {
      const htFor = isHome ? ht.home : ht.away;
      const htAg = isHome ? ht.away : ht.home;
      if (htFor > htAg) htLeading++;
    }
  }

  const n = played.length;
  return {
    matches: n,
    record: { won: w, drawn: d, lost: l },
    formMostRecentFirst: sequence.join(""),
    goals: {
      scored: gf,
      conceded: ga,
      avgScored: n ? Math.round((gf / n) * 100) / 100 : null,
      avgConceded: n ? Math.round((ga / n) * 100) / 100 : null,
      avgTotal: n ? Math.round(((gf + ga) / n) * 100) / 100 : null,
    },
    ratesPercent: {
      win: pct(w, n),
      draw: pct(d, n),
      loss: pct(l, n),
      btts: pct(btts, n),
      over1_5: pct(o15, n),
      over2_5: pct(o25, n),
      over3_5: pct(o35, n),
      cleanSheet: pct(cleanSheets, n),
      failedToScore: pct(failedToScore, n),
      leadingAtHalftime: pct(htLeading, n),
    },
  };
}

export class BettingToolsController {
  constructor(private server: McpServer, private api: FootballApiService) {
    this.registerPredictions();
    this.registerOdds();
    this.registerListBookmakers();
    this.registerListBetTypes();
    this.registerLeagueFixtures();
    this.registerTeamForm();
    this.registerHeadToHeadSummary();
    this.registerMatchPreview();
  }

  /** ---- get-predictions ---- */
  private registerPredictions(): void {
    this.server.tool(
      "get-predictions",
      "API-Football's own prediction for a fixture: likely winner, win/draw/loss percentages, advice, " +
        "under/over and goals guidance, plus side-by-side team comparison (form, attack, defence, H2H, goals). " +
        "Works for upcoming fixtures. Treat it as one input, not a guarantee.",
      { fixtureId: z.number().describe("Fixture ID") },
      async ({ fixtureId }) => {
        const data = await this.api.fetchPredictions(fixtureId);
        const r = data.response?.[0];
        if (!r) throw new Error(`No prediction available for fixture ${fixtureId}.`);
        return ok({
          fixtureId,
          league: { id: r.league.id, name: r.league.name, season: r.league.season },
          home: { id: r.teams.home.id, name: r.teams.home.name, last5: r.teams.home.last_5 },
          away: { id: r.teams.away.id, name: r.teams.away.name, last5: r.teams.away.last_5 },
          prediction: {
            winner: r.predictions.winner,
            winOrDraw: r.predictions.win_or_draw,
            underOver: r.predictions.under_over,
            goals: r.predictions.goals,
            advice: r.predictions.advice,
            percent: r.predictions.percent,
          },
          comparison: r.comparison,
        });
      }
    );
  }

  /** ---- get-odds ---- */
  private registerOdds(): void {
    this.server.tool(
      "get-odds",
      "Pre-match bookmaker odds for a fixture (1X2, over/under, BTTS, double chance, correct score, etc.). " +
        "Odds are usually available 1-14 days before kick-off and kept for about 7 days after. " +
        "Filter by bookmakerId and/or betId to keep the response small (see list-bookmakers / list-bet-types).",
      {
        fixtureId: z.number().describe("Fixture ID"),
        bookmakerId: z.number().optional().describe("Bookmaker ID (optional)"),
        betId: z.number().optional().describe("Bet type ID, e.g. 1 = Match Winner (optional)"),
      },
      async ({ fixtureId, bookmakerId, betId }) => {
        const params: Record<string, string | number> = { fixture: fixtureId };
        if (bookmakerId) params.bookmaker = bookmakerId;
        if (betId) params.bet = betId;
        const data = await this.api.fetchOdds(params);
        const r = data.response?.[0];
        if (!r) {
          throw new Error(
            `No odds found for fixture ${fixtureId}. Odds only exist from ~14 days before kick-off ` +
              `until ~7 days after, and not every league is covered.`
          );
        }
        return ok({
          fixtureId,
          updated: r.update,
          bookmakers: r.bookmakers.map((b: any) => ({
            id: b.id,
            name: b.name,
            bets: b.bets.map((bet: any) => ({
              id: bet.id,
              name: bet.name,
              values: bet.values.map((v: any) => ({ value: v.value, odd: v.odd })),
            })),
          })),
        });
      }
    );
  }

  /** ---- list-bookmakers ---- */
  private registerListBookmakers(): void {
    this.server.tool(
      "list-bookmakers",
      "List all bookmakers available in API-Football with their IDs.",
      {},
      async () => {
        const data = await this.api.fetchOddsBookmakers();
        return ok(data.response.map((b: any) => ({ id: b.id, name: b.name })));
      }
    );
  }

  /** ---- list-bet-types ---- */
  private registerListBetTypes(): void {
    this.server.tool(
      "list-bet-types",
      "List all bet types (markets) available for odds, with their IDs.",
      {},
      async () => {
        const data = await this.api.fetchOddsBets();
        return ok(data.response.map((b: any) => ({ id: b.id, name: b.name })));
      }
    );
  }

  /** ---- get-league-fixtures ---- */
  private registerLeagueFixtures(): void {
    this.server.tool(
      "get-league-fixtures",
      "Fixtures for a league and season, optionally filtered by status (e.g. 'NS' not started, 'FT' finished, " +
        "'FT-AET-PEN' all finished), round, or date range. Use this to find upcoming matches to analyse or " +
        "to pull a full season of results for backtesting.",
      {
        leagueId: z.number().describe("League ID (e.g. 39 = Premier League)"),
        season: z.number().describe("Season start year (e.g. 2024 for 2024/25)"),
        status: z.string().optional().describe("Status filter, e.g. 'NS' or 'FT-AET-PEN' (optional)"),
        round: z.string().optional().describe("Round name, e.g. 'Regular Season - 10' (optional)"),
        from: z.string().regex(/\d{4}-\d{2}-\d{2}/).optional().describe("Start date YYYY-MM-DD (optional)"),
        to: z.string().regex(/\d{4}-\d{2}-\d{2}/).optional().describe("End date YYYY-MM-DD (optional)"),
      },
      async ({ leagueId, season, status, round, from, to }) => {
        const params: Record<string, string | number> = { league: leagueId, season };
        if (status) params.status = status;
        if (round) params.round = round;
        if (from) params.from = from;
        if (to) params.to = to;
        const data = await this.api.fetchFixturesQuery(params);
        const fixtures = (data.response ?? []).map(compactFixture);
        return ok({ leagueId, season, count: fixtures.length, fixtures });
      }
    );
  }

  /** ---- get-team-form ---- */
  private registerTeamForm(): void {
    this.server.tool(
      "get-team-form",
      "A team's recent form with betting rates computed exactly: W/D/L, goals for/against averages, " +
        "BTTS %, over 1.5/2.5/3.5 %, clean sheet %, failed-to-score %, leading-at-halftime %. " +
        "Pass a season to analyse that season's finished matches (free plans only cover some past seasons); " +
        "split by venue with venue='home' or 'away'.",
      {
        teamId: z.number().describe("Team ID"),
        season: z.number().describe("Season start year"),
        leagueId: z.number().optional().describe("Restrict to one league (optional)"),
        lastN: z.number().min(1).max(50).optional().describe("Use only the most recent N finished matches (default 10)"),
        venue: z.enum(["all", "home", "away"]).optional().describe("Venue split (default all)"),
      },
      async ({ teamId, season, leagueId, lastN, venue }) => {
        const params: Record<string, string | number> = {
          team: teamId,
          season,
          status: "FT-AET-PEN",
        };
        if (leagueId) params.league = leagueId;
        const data = await this.api.fetchFixturesQuery(params);
        let fixtures: Fixture[] = data.response ?? [];
        const v = venue ?? "all";
        if (v === "home") fixtures = fixtures.filter((f) => f.teams.home.id === teamId);
        if (v === "away") fixtures = fixtures.filter((f) => f.teams.away.id === teamId);
        fixtures.sort((a, b) => b.fixture.timestamp - a.fixture.timestamp);
        const n = lastN ?? 10;
        const recent = fixtures.slice(0, n);
        return ok({
          teamId,
          season,
          leagueId: leagueId ?? null,
          venue: v,
          summary: teamFormSummary(teamId, recent),
          matches: recent.map(compactFixture),
        });
      }
    );
  }

  /** ---- get-h2h-summary ---- */
  private registerHeadToHeadSummary(): void {
    this.server.tool(
      "get-h2h-summary",
      "Head-to-head between two teams with computed stats from team 1's point of view " +
        "(W/D/L, goal averages, BTTS %, over 2.5 %, etc.) plus the match list.",
      {
        teamId1: z.number().describe("First team ID (stats are from this team's view)"),
        teamId2: z.number().describe("Second team ID"),
        lastN: z.number().min(1).max(30).optional().describe("Number of most recent meetings (default 10)"),
      },
      async ({ teamId1, teamId2, lastN }) => {
        const n = lastN ?? 10;
        const data = await this.api.fetchHeadToHeadQuery(teamId1, teamId2);
        const all: Fixture[] = (data.response ?? [])
          .filter((f: Fixture) => FINISHED.has(f.fixture.status.short))
          .sort((a: Fixture, b: Fixture) => b.fixture.timestamp - a.fixture.timestamp)
          .slice(0, n);
        return ok({
          teamId1,
          teamId2,
          summary: teamFormSummary(teamId1, all),
          matches: all.map(compactFixture),
        });
      }
    );
  }

  /** ---- get-match-preview ---- */
  private registerMatchPreview(): void {
    this.server.tool(
      "get-match-preview",
      "One-call pre-match pack for a fixture: fixture details, API prediction, both teams' season form " +
        "(overall plus home team at home / away team away), and recent H2H. Odds are fetched separately " +
        "with get-odds. Uses several API requests, so prefer it for matches you actually want to analyse.",
      { fixtureId: z.number().describe("Fixture ID") },
      async ({ fixtureId }) => {
        const fx = await this.api.fetchFixturesQuery({ id: fixtureId });
        const f = fx.response?.[0];
        if (!f) throw new Error(`Fixture ${fixtureId} not found.`);
        const homeId = f.teams.home.id;
        const awayId = f.teams.away.id;
        const season = f.league.season;
        const leagueId = f.league.id;

        const safe = async <R>(fn: () => Promise<R>): Promise<R | { error: string }> => {
          try {
            return await fn();
          } catch (e: any) {
            return { error: e?.message ?? String(e) };
          }
        };

        const formFor = async (teamId: number) => {
          const d = await this.api.fetchFixturesQuery({
            team: teamId,
            season,
            league: leagueId,
            status: "FT-AET-PEN",
          });
          const list: Fixture[] = (d.response ?? []).sort(
            (a: Fixture, b: Fixture) => b.fixture.timestamp - a.fixture.timestamp
          );
          return list;
        };

        const [pred, homeList, awayList, h2h] = await Promise.all([
          safe(() => this.api.fetchPredictions(fixtureId)),
          safe(() => formFor(homeId)),
          safe(() => formFor(awayId)),
          safe(() => this.api.fetchHeadToHeadQuery(homeId, awayId)),
        ]);

        const p: any = (pred as any)?.response?.[0];
        const formPack = (teamId: number, list: any, side: "home" | "away") => {
          if (!Array.isArray(list)) return list;
          const venueList = list.filter((x: Fixture) =>
            side === "home" ? x.teams.home.id === teamId : x.teams.away.id === teamId
          );
          return {
            last10: teamFormSummary(teamId, list.slice(0, 10)),
            season: teamFormSummary(teamId, list),
            [side === "home" ? "atHome" : "away"]: teamFormSummary(teamId, venueList),
          };
        };

        const h2hList: Fixture[] = Array.isArray((h2h as any)?.response)
          ? (h2h as any).response
              .filter((x: Fixture) => FINISHED.has(x.fixture.status.short))
              .sort((a: Fixture, b: Fixture) => b.fixture.timestamp - a.fixture.timestamp)
              .slice(0, 10)
          : [];

        return ok({
          fixture: compactFixture(f),
          venue: f.fixture.venue?.name,
          referee: f.fixture.referee,
          prediction: p
            ? {
                winner: p.predictions.winner,
                advice: p.predictions.advice,
                underOver: p.predictions.under_over,
                goals: p.predictions.goals,
                percent: p.predictions.percent,
                comparison: p.comparison,
              }
            : (pred as any)?.error ?? "No prediction available",
          homeForm: formPack(homeId, homeList, "home"),
          awayForm: formPack(awayId, awayList, "away"),
          h2h: (h2h as any)?.error
            ? (h2h as any).error
            : { summaryFromHomeView: teamFormSummary(homeId, h2hList), matches: h2hList.map(compactFixture) },
        });
      }
    );
  }
}
