import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BallDontLieService, OddsPapiService, BASKETBALL_SPORT_ID } from "../../infrastructure/services/liveSources.js";

/**
 * NBA slate: tonight's games with a simple, transparent rating model,
 * calibrated against Pinnacle's fair odds.
 *
 * Model (per team): points for / against per game this season, blended with
 * last season's numbers (regressed 40% to the league mean) until ~10 games
 * are played. Expected margin = home rating - away rating + 2.5 home court,
 * minus 1.5 for a team on the second night of a back-to-back.
 *   P(home win)  = Phi(margin / 12.5)
 *   P(over line) = 1 - Phi((line - expected total) / 18)
 * Market odds are very efficient in the NBA, so the final probability is
 * 30% model / 70% Pinnacle fair price. Expect few qualifying picks.
 */

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r1 = (x: number) => Math.round(x * 10) / 10;

function erf(x: number) {
  // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
const Phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

const HCA = 2.5;
const MARGIN_SD = 12.5;
const TOTAL_SD = 18;
const PRIOR_GAMES = 10;
const MODEL_WEIGHT = 0.3;

type Agg = { n: number; pf: number; pa: number };

function aggregate(games: any[]) {
  const m = new Map<number, Agg>();
  let leaguePts = 0;
  let leagueN = 0;
  for (const g of games) {
    if (String(g.status) !== "Final" || g.postseason) continue;
    const h = g.home_team?.id;
    const v = g.visitor_team?.id;
    const hs = Number(g.home_team_score);
    const vs = Number(g.visitor_team_score);
    if (!h || !v || !hs || !vs) continue;
    const a = m.get(h) ?? { n: 0, pf: 0, pa: 0 };
    a.n++; a.pf += hs; a.pa += vs; m.set(h, a);
    const b = m.get(v) ?? { n: 0, pf: 0, pa: 0 };
    b.n++; b.pf += vs; b.pa += hs; m.set(v, b);
    leaguePts += hs + vs;
    leagueN += 2;
  }
  return { teams: m, leagueAvg: leagueN ? leaguePts / leagueN : 114 };
}

/* ---------- name matching (same idea as football) ---------- */
function toks(s: string) {
  return new Set(s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean));
}
function score(a: string[], b: string[]) {
  let best = 0;
  for (const x of a) for (const y of b) {
    if (!x || !y) continue;
    const tx = toks(x), ty = toks(y);
    let inter = 0; tx.forEach((w) => { if (ty.has(w)) inter++; });
    const u = new Set([...tx, ...ty]).size || 1;
    let s = inter / u;
    if (inter > 0 && (inter === tx.size || inter === ty.size)) s = Math.max(s, 0.75);
    best = Math.max(best, s);
  }
  return best;
}

/* ---------- odds parsing for basketball ---------- */
function fullGame(period: string) {
  const p = (period ?? "").toLowerCase();
  return !(p.startsWith("p") || p.includes("half") || p.includes("quarter") || /^q\d/.test(p));
}

function extractBasketball(bookmakerOdds: any, meta: Map<string, any>, slug: string) {
  const bo = bookmakerOdds?.[slug];
  if (!bo || bo.bookmakerIsActive === false) return null;
  const out: any = { ml: {}, totals: [] as any[] };
  for (const [mid, mk] of Object.entries<any>(bo.markets ?? {})) {
    const m = meta.get(String(mid));
    if (!m || !fullGame(m.period)) continue;
    const type = String(m.marketType ?? "").toLowerCase();
    const names: Record<string, string> = {};
    for (const o of m.outcomes ?? []) names[String(o.outcomeId)] = String(o.outcomeName ?? "").toLowerCase();
    const outs = Object.entries<any>(mk.outcomes ?? {}).map(([oid, oc]) => ({ name: names[oid] ?? "", p: oc?.players?.["0"] }));
    if (type === "moneyline" || type === "12" || (type === "1x2" && outs.length === 2)) {
      for (const o of outs) {
        const price = Number(o.p?.price);
        if (!price) continue;
        if (o.name === "1" || o.name === "home") out.ml.home = price;
        if (o.name === "2" || o.name === "away") out.ml.away = price;
      }
    } else if (type === "totals") {
      const over = outs.find((o) => o.name.startsWith("over"));
      const under = outs.find((o) => o.name.startsWith("under"));
      if (over?.p?.price && under?.p?.price) {
        out.totals.push({ line: Number(m.handicap), over: Number(over.p.price), under: Number(under.p.price), main: !!(over.p.mainLine ?? under.p.mainLine) });
      }
    }
  }
  return out;
}

export class BasketballSlateController {
  constructor(private server: McpServer, private bdl: BallDontLieService, private op: OddsPapiService) {
    this.registerSlate();
  }

  private async nbaTournamentId(): Promise<number | null> {
    const list: any[] = await this.op.tournaments(BASKETBALL_SPORT_ID);
    const hit = (list ?? []).find((t) => String(t.tournamentName ?? "").trim().toLowerCase() === "nba")
      ?? (list ?? []).find((t) => /^nba\b/i.test(String(t.tournamentName ?? "")) && !/summer|preseason|g league|cup/i.test(String(t.tournamentName ?? "")));
    return hit?.tournamentId ?? null;
  }

  private registerSlate(): void {
    this.server.tool(
      "get-basketball-slate",
      "NBA picks for the next N hours (default 24h from now; NBA tips off roughly 00:00-05:00 Lagos time). " +
        "Rating model from this season's results (balldontlie) blended with last season early on, plus back-to-back " +
        "fatigue, calibrated 30/70 against Pinnacle fair odds (OddsPapi). Returns moneyline and main-line total picks " +
        "with our probability, Pinnacle price, edge and minimum SportyBet odds. First run downloads last season in chunks; " +
        "if it reports 'warming up', run it again.",
      {
        hours: z.number().min(6).max(72).optional().describe("Look-ahead window in hours from now (default 24)"),
        bookmaker: z.string().optional().describe("OddsPapi bookmaker for prices (default pinnacle)"),
      },
      async ({ hours, bookmaker }) => {
        const notes: string[] = [];
        const now = new Date();
        const end = new Date(now.getTime() + (hours ?? 24) * 3600 * 1000);
        const season = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1; // NBA season label = start year
        const seasonStart = `${season}-10-01`;

        // 1. Prior season (chunked, permanent cache)
        const prior = await this.bdl.priorSeason(season - 1, 3);
        if (!prior.complete) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ status: "warming up", note: `Downloaded ${prior.games.length} games of last season so far (free plan is 5 requests/minute). Run again to continue.` }) }] };
        }
        const P = aggregate(prior.games);

        // 2. Current season finished + upcoming
        const cur = await this.bdl.currentSeason(season, seasonStart, end.toISOString().slice(0, 10));
        const C = aggregate(cur);
        const upcoming = cur.filter((g) => {
          if (String(g.status) === "Final") return false;
          const t = Date.parse(g.datetime ?? g.date);
          return t >= now.getTime() - 3600 * 1000 && t <= end.getTime();
        });
        notes.push(`Season ${season}-${String(season + 1).slice(2)}: ${[...C.teams.values()].reduce((a, b) => a + b.n, 0) / 2} finished games; ${upcoming.length} games in window.`);

        // last game date per team for back-to-back detection
        const lastPlayed = new Map<number, number>();
        for (const g of cur) {
          if (String(g.status) !== "Final") continue;
          const t = Date.parse(g.datetime ?? g.date);
          for (const id of [g.home_team?.id, g.visitor_team?.id]) if (id) lastPlayed.set(id, Math.max(lastPlayed.get(id) ?? 0, t));
        }

        const leagueAvg = C.leagueAvg && C.teams.size >= 20 ? C.leagueAvg : P.leagueAvg;
        const rate = (id: number) => {
          const c = C.teams.get(id) ?? { n: 0, pf: 0, pa: 0 };
          const p = P.teams.get(id);
          const pOff = p ? leagueAvg + 0.6 * (p.pf / p.n - P.leagueAvg) : leagueAvg;
          const pDef = p ? leagueAvg + 0.6 * (p.pa / p.n - P.leagueAvg) : leagueAvg;
          const off = (c.pf + PRIOR_GAMES * pOff) / (c.n + PRIOR_GAMES);
          const def = (c.pa + PRIOR_GAMES * pDef) / (c.n + PRIOR_GAMES);
          return { off, def, net: off - def, games: c.n };
        };

        // 3. Odds
        const book = bookmaker ?? "pinnacle";
        let oddsList: any[] = [];
        let fixtures: any[] = [];
        let meta = new Map<string, any>();
        try {
          const tId = await this.nbaTournamentId();
          if (!tId) notes.push("NBA tournament not found on OddsPapi.");
          else if (upcoming.length) {
            const ml: any[] = await this.op.markets();
            for (const m of ml ?? []) meta.set(String(m.marketId), m);
            fixtures = (await this.op.fixtures(now.toISOString().slice(0, 19) + "Z", end.toISOString().slice(0, 19) + "Z", BASKETBALL_SPORT_ID)) ?? [];
            fixtures = fixtures.filter((f) => f.tournamentId === tId);
            oddsList = (await this.op.oddsByTournaments([tId], book)) ?? [];
          }
        } catch (e: any) {
          notes.push(`Odds unavailable: ${e?.message ?? e}`);
        }
        const oddsById = new Map<string, any>();
        for (const o of oddsList) oddsById.set(String(o.fixtureId), o);

        // 4. Rate each game
        const games: any[] = [];
        const picks: any[] = [];
        for (const g of upcoming) {
          const H = g.home_team, V = g.visitor_team;
          const tip = Date.parse(g.datetime ?? g.date);
          const h = rate(H.id), v = rate(V.id);
          const b2bH = (lastPlayed.get(H.id) ?? 0) > tip - 30 * 3600 * 1000;
          const b2bV = (lastPlayed.get(V.id) ?? 0) > tip - 30 * 3600 * 1000;
          const margin = h.net - v.net + HCA - (b2bH ? 1.5 : 0) + (b2bV ? 1.5 : 0);
          const expTotal = (h.off + v.def) / 2 + (v.off + h.def) / 2;
          const pHome = Phi(margin / MARGIN_SD);

          const entry: any = {
            tipoffUtc: g.datetime ?? g.date,
            home: H.full_name, away: V.full_name,
            model: { expMarginHome: r1(margin), expTotal: r1(expTotal), pHomeWin: r3(pHome), gamesPlayed: { home: h.games, away: v.games }, backToBack: { home: b2bH, away: b2bV } },
            selections: [] as any[],
          };

          // match odds fixture
          let best: any = null, bestS = 0;
          for (const f of fixtures) {
            if (Math.abs(Date.parse(f.startTime) - tip) > 4 * 3600 * 1000) continue;
            const s1 = score([H.full_name, H.name, H.abbreviation], [f.participant1Name, f.participant1ShortName, f.participant1Abbr].filter(Boolean));
            const s2 = score([V.full_name, V.name, V.abbreviation], [f.participant2Name, f.participant2ShortName, f.participant2Abbr].filter(Boolean));
            if (s1 >= 0.3 && s2 >= 0.3 && s1 + s2 > bestS) { bestS = s1 + s2; best = f; }
          }
          const od = best ? oddsById.get(String(best.fixtureId)) : null;
          const px = od ? extractBasketball(od.bookmakerOdds, meta, book) : null;
          if (!px) entry.oddsNote = best ? "No odds yet" : "No odds match found";

          const add = (label: string, model: number, price?: number, fairMkt?: number) => {
            const prob = fairMkt != null ? MODEL_WEIGHT * model + (1 - MODEL_WEIGHT) * fairMkt : model;
            const sel: any = { label, modelProb: r3(model), marketProb: fairMkt != null ? r3(fairMkt) : null, prob: r3(prob), minOdds: Math.ceil((1.05 / prob) * 100) / 100 };
            if (price) {
              sel.price = price;
              sel.edge = r3(prob * price - 1);
              if (sel.edge > 0.25) sel.suspectPrice = true;
            }
            entry.selections.push(sel);
            if (sel.edge > 0 && !sel.suspectPrice) picks.push({ game: `${V.full_name} @ ${H.full_name}`, tipoffUtc: entry.tipoffUtc, ...sel });
          };

          if (px?.ml?.home && px?.ml?.away) {
            const ih = 1 / px.ml.home, ia = 1 / px.ml.away;
            const fh = ih / (ih + ia);
            add(`${H.full_name} to win`, pHome, px.ml.home, fh);
            add(`${V.full_name} to win`, 1 - pHome, px.ml.away, 1 - fh);
          } else {
            add(`${H.full_name} to win`, pHome);
            add(`${V.full_name} to win`, 1 - pHome);
          }
          // Main line = the most balanced half-point line (whole numbers can push).
          const halfLines = (px?.totals ?? []).filter((t: any) => Math.abs(t.line % 1) === 0.5);
          const main = (halfLines.length ? halfLines : px?.totals ?? [])
            .slice()
            .sort((a: any, b: any) => Math.abs(a.over - a.under) - Math.abs(b.over - b.under))[0];
          if (main) {
            const pOver = 1 - Phi((main.line - expTotal) / TOTAL_SD);
            const io = 1 / main.over, iu = 1 / main.under;
            const fo = io / (io + iu);
            add(`Over ${main.line} points`, pOver, main.over, fo);
            add(`Under ${main.line} points`, 1 - pOver, main.under, 1 - fo);
          }
          games.push(entry);
        }

        picks.sort((a, b) => b.edge - a.edge);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              window: { from: now.toISOString(), to: end.toISOString() },
              bookmaker: book,
              valuePicks: picks.slice(0, 8),
              games,
              notes,
              method: "Ratings from points for/against (this season + regressed last season), +2.5 home court, -1.5 back-to-back. Final prob = 30% model + 70% Pinnacle fair odds.",
              caution: "NBA odds are very efficient; edges are small and rest/injury news moves lines. Check the injury report before betting.",
            }),
          }],
        };
      }
    );
  }
}
