import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FootballApiService } from "../../infrastructure/services/footballApiService.js";

/**
 * League scanning: profiles whole league-seasons so we can find which
 * competitions are most predictable for betting.
 *
 * One API request per league-season (all finished fixtures come back in one
 * call). Finished seasons are cached on disk by the API service, so a league
 * is only ever downloaded once.
 */

type Fixture = any;

const FINISHED = new Set(["FT", "AET", "PEN"]);
const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const r2 = (x: number) => Math.round(x * 100) / 100;

function profileLeague(fixtures: Fixture[]) {
  const played = fixtures
    .filter((f) => FINISHED.has(f.fixture.status.short) && f.goals.home != null && f.goals.away != null)
    .sort((a, b) => a.fixture.timestamp - b.fixture.timestamp);

  let hw = 0, dr = 0, aw = 0, goals = 0, btts = 0, o15 = 0, o25 = 0, o35 = 0, u25 = 0;
  let htDraw = 0, htFtSame = 0, htCounted = 0;

  // Pre-match strength proxy: points-per-game before kick-off, within the season.
  const table = new Map<number, { p: number; pts: number }>();
  const fav = {
    mild: { n: 0, win: 0, draw: 0, loss: 0 },   // PPG gap >= 0.5
    strong: { n: 0, win: 0, draw: 0, loss: 0 }, // PPG gap >= 1.0
    strongHome: { n: 0, win: 0, draw: 0, loss: 0 }, // strong favourite playing at home
  };
  const MIN_GAMES = 5;

  for (const f of played) {
    const h = f.teams.home.id;
    const a = f.teams.away.id;
    const hg = f.goals.home;
    const ag = f.goals.away;
    const tot = hg + ag;

    if (hg > ag) hw++;
    else if (hg === ag) dr++;
    else aw++;
    goals += tot;
    if (hg > 0 && ag > 0) btts++;
    if (tot > 1.5) o15++;
    if (tot > 2.5) o25++;
    else u25++;
    if (tot > 3.5) o35++;

    const ht = f.score?.halftime;
    if (ht && ht.home != null && ht.away != null) {
      htCounted++;
      if (ht.home === ht.away) htDraw++;
      const htRes = Math.sign(ht.home - ht.away);
      const ftRes = Math.sign(hg - ag);
      if (htRes === ftRes) htFtSame++;
    }

    const th = table.get(h) ?? { p: 0, pts: 0 };
    const ta = table.get(a) ?? { p: 0, pts: 0 };
    if (th.p >= MIN_GAMES && ta.p >= MIN_GAMES) {
      const gap = th.pts / th.p - ta.pts / ta.p;
      const favIsHome = gap > 0;
      const favGoals = favIsHome ? hg : ag;
      const dogGoals = favIsHome ? ag : hg;
      const outcome = favGoals > dogGoals ? "win" : favGoals === dogGoals ? "draw" : "loss";
      const abs = Math.abs(gap);
      if (abs >= 0.5) { fav.mild.n++; fav.mild[outcome]++; }
      if (abs >= 1.0) {
        fav.strong.n++; fav.strong[outcome]++;
        if (favIsHome) { fav.strongHome.n++; fav.strongHome[outcome]++; }
      }
    }

    const ptsH = hg > ag ? 3 : hg === ag ? 1 : 0;
    const ptsA = ag > hg ? 3 : hg === ag ? 1 : 0;
    table.set(h, { p: th.p + 1, pts: th.pts + ptsH });
    table.set(a, { p: ta.p + 1, pts: ta.pts + ptsA });
  }

  const n = played.length;
  const favOut = (b: { n: number; win: number; draw: number; loss: number }) => ({
    sample: b.n,
    winPct: pct(b.win, b.n),
    drawPct: pct(b.draw, b.n),
    upsetPct: pct(b.loss, b.n),
    notLosePct: pct(b.win + b.draw, b.n),
  });

  return {
    matches: n,
    results: { homeWinPct: pct(hw, n), drawPct: pct(dr, n), awayWinPct: pct(aw, n) },
    goals: {
      avgPerMatch: n ? r2(goals / n) : null,
      over1_5Pct: pct(o15, n),
      over2_5Pct: pct(o25, n),
      under2_5Pct: pct(u25, n),
      over3_5Pct: pct(o35, n),
      bttsPct: pct(btts, n),
    },
    halftime: { htDrawPct: pct(htDraw, htCounted), htResultHoldsAtFtPct: pct(htFtSame, htCounted) },
    favourites: {
      note: "Favourite = higher points-per-game before kick-off (both teams 5+ games played).",
      mildGap0_5: favOut(fav.mild),
      strongGap1_0: favOut(fav.strong),
      strongFavouriteAtHome: favOut(fav.strongHome),
    },
  };
}

export class LeagueScanController {
  constructor(private server: McpServer, private api: FootballApiService) {
    this.registerScanLeagues();
  }

  private registerScanLeagues(): void {
    this.server.tool(
      "scan-leagues",
      "Profile up to 6 league-seasons for betting predictability in one call: home/draw/away rates, goal markets " +
        "(over 1.5/2.5/3.5, BTTS), halftime patterns, and how reliably pre-match favourites win (upset rate). " +
        "One API request per league (cached on disk once the season is finished). " +
        "Common IDs: 39 EPL, 40 Championship, 140 La Liga, 135 Serie A, 78 Bundesliga, 61 Ligue 1, 88 Eredivisie, " +
        "94 Primeira Liga, 144 Belgium, 179 Scotland, 203 Turkey, 207 Switzerland, 218 Austria, 119 Denmark, " +
        "197 Greece, 106 Poland, 103 Norway, 113 Sweden, 253 MLS, 71 Brazil Serie A, 128 Argentina, 307 Saudi.",
      {
        leagueIds: z.array(z.number()).min(1).max(6).describe("League IDs to profile (max 6 per call)"),
        season: z.number().describe("Season start year, e.g. 2023 for 2023/24"),
      },
      async ({ leagueIds, season }) => {
        const out: any[] = [];
        for (const leagueId of leagueIds) {
          try {
            const data = await this.api.fetchFixturesQuery({
              league: leagueId,
              season,
              status: "FT-AET-PEN",
            });
            const fixtures: Fixture[] = data.response ?? [];
            const first = fixtures[0];
            out.push({
              leagueId,
              league: first ? `${first.league.name} (${first.league.country})` : "unknown",
              season,
              ...profileLeague(fixtures),
            });
          } catch (e: any) {
            out.push({ leagueId, season, error: e?.message ?? String(e) });
          }
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      }
    );
  }
}
