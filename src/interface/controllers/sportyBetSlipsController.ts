import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OddsPapiService } from "../../infrastructure/services/liveSources.js";
import {
  MarketMeta, r2, r3, poissonPmf, totalFromOver, fitRates, everLeadsProb, drawWithoutLeadingProb,
} from "./dailySlateController.js";

/**
 * SportyBet-style slips across many leagues, priced from Pinnacle (the sharpest book on OddsPapi's free plan).
 *
 * Each day:
 *   - Streak slip: 2+ legs, combined odds about 2 (1.8 - 2.25), the highest chance of winning.
 *   - Big slip:    about 10 odds (8 - 13) from different leagues, legs 72%+, the highest chance for that price.
 *
 * Markets (as on SportyBet):
 *   1X2 - 1UP  : team to win, paid early as soon as it leads by a goal
 *   DC - 1UP   : team or draw, paid early as soon as the team leads by a goal
 *   Double Chance (1X, X2, 12), team Over 0.5, match Over 1.5
 *
 * Probabilities are Pinnacle's de-vigged prices; the 1UP chances come from a Poisson goal model fitted to
 * Pinnacle's 1X2 and total-goals prices. SportyBet prices are estimates (SportyBet is not on the free plan).
 */

// Leagues SportyBet carries widely, in priority order. Matched against OddsPapi category + tournament names.
const LEAGUES: { country: string; names: RegExp }[] = [
  { country: "", names: /^uefa (champions|europa|conference) league$/ }, // midweek nights
  { country: "england", names: /^(premier league|championship|league one)$/ },
  { country: "spain", names: /^(laliga|la liga|laliga 2|laliga hypermotion|segunda division)$/ },
  { country: "italy", names: /^(serie a|serie b)$/ },
  { country: "germany", names: /^(bundesliga|2\. bundesliga)$/ },
  { country: "france", names: /^(ligue 1|ligue 2)$/ },
  { country: "netherlands", names: /^(eredivisie|eerste divisie)$/ },
  { country: "portugal", names: /^(liga portugal|primeira liga|liga portugal betclic|liga portugal 2)$/ },
  { country: "belgium", names: /^(pro league|jupiler pro league|first division a)$/ },
  { country: "turkey", names: /^(super lig|süper lig|trendyol super lig)$/ },
  { country: "saudi", names: /(pro league|professional league|saudi league)/ },
  { country: "denmark", names: /^(superliga|superligaen|1st division)$/ },
  { country: "romania", names: /^(liga 1|superliga|liga i)$/ },
  { country: "scotland", names: /^(premiership)$/ },
  { country: "austria", names: /^(bundesliga)$/ },
  { country: "switzerland", names: /^(super league)$/ },
  { country: "greece", names: /^(super league|super league 1)$/ },
  { country: "poland", names: /^(ekstraklasa)$/ },
  { country: "czech", names: /(first league|chance liga|1\. liga)/ },
  { country: "croatia", names: /(hnl|supersport hnl|1\. hnl)/ },
  { country: "norway", names: /^(eliteserien)$/ },
  { country: "sweden", names: /^(allsvenskan)$/ },
  { country: "latvia", names: /(virsliga|higher league)/ },
  { country: "estonia", names: /(meistriliiga|premium liiga)/ },
  { country: "usa", names: /^(mls|major league soccer)$/ },
  { country: "brazil", names: /^(serie a|brasileiro serie a|brasileirao serie a)$/ },
  { country: "argentina", names: /(liga profesional|primera division)/ },
  { country: "japan", names: /^(j1 league|j\.league)$/ },
  { country: "korea", names: /^(k league 1|k-league 1)$/ },
  { country: "australia", names: /^(a-league|a-league men)$/ },
];

const BAD = /(women|u\d\d|youth|reserve|cup|friendl|play-?off|qualif)/;

type Leg = {
  mi: number;
  tournamentId: number;
  competition: string; // "OP:<tournament name>" for the tracker
  league: string; // country, league
  home: string;
  away: string;
  kickoffUtc: string;
  kickoffLagos: string;
  key: string;
  label: string;
  market: string; // SportyBet market name
  tap: string; // what to tap
  prob: number;
  price: number; // estimated SportyBet price
  minOdds: number;
};

function classify(m: MarketMeta): string | null {
  const type = (m.type ?? "").toLowerCase();
  const period = (m.period ?? "").toLowerCase();
  if (period && period !== "fulltime") return null;
  if (type === "1x2") return "1x2";
  if (type === "totals" && [1.5, 2.5].includes(m.handicap)) return "ou" + m.handicap;
  if (type === "teamtotals-team1" && m.handicap === 0.5) return "tt1";
  if (type === "teamtotals-team2" && m.handicap === 0.5) return "tt2";
  return null;
}

/** Pinnacle prices for one fixture: {home, draw, away, over_1.5, under_1.5, over_2.5, under_2.5, home_over_0.5, ...} */
function pinnaclePrices(bookmakerOdds: any, meta: Map<string, MarketMeta>) {
  const out: Record<string, number> = {};
  const bo = bookmakerOdds?.pinnacle ?? Object.values<any>(bookmakerOdds ?? {})[0];
  if (!bo || bo.bookmakerIsActive === false) return out;
  for (const [marketId, mk] of Object.entries<any>(bo.markets ?? {})) {
    const mm = meta.get(String(marketId));
    if (!mm) continue;
    const kind = classify(mm);
    if (!kind) continue;
    for (const [outcomeId, oc] of Object.entries<any>(mk.outcomes ?? {})) {
      const pl = oc?.players?.["0"];
      const price = Number(pl?.price);
      if (!price || pl?.active === false) continue;
      const on = (mm.outcomes[String(outcomeId)] ?? "").toLowerCase();
      let sel: string | null = null;
      if (kind === "1x2") sel = on === "1" ? "home" : on === "x" ? "draw" : on === "2" ? "away" : null;
      else {
        const side = on.startsWith("over") ? "over" : on.startsWith("under") ? "under" : null;
        if (!side) continue;
        if (kind.startsWith("ou")) sel = `${side}_${kind.slice(2)}`;
        else sel = `${kind === "tt1" ? "home" : "away"}_${side}_0.5`;
      }
      if (sel && out[sel] == null) out[sel] = price;
    }
  }
  return out;
}

function devig(prices: number[]) {
  const inv = prices.map((p) => 1 / p);
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => x / s);
}

const lagosTime = (iso: string) =>
  new Date(Date.parse(iso) + 3600 * 1000).toISOString().slice(11, 16);

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export class SportyBetSlipsController {
  constructor(private server: McpServer, private op: OddsPapiService) {
    this.register();
  }

  private register(): void {
    this.server.tool(
      "get-sportybet-slips",
      "Build today's two SportyBet slips from many leagues: a streak slip of about 2 odds (2+ legs, highest chance) and " +
        "a big slip of about 10 odds from different leagues. Uses 1X2-1UP, DC-1UP, Double Chance, team Over 0.5 and " +
        "Over 1.5, priced from Pinnacle. Each leg has league, SportyBet market, tap, estimate and min odds. " +
        "Costs about 1 OddsPapi request per 5 leagues (maxRequests).",
      {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Lagos date, default today"),
        streakMin: z.number().optional().describe("Streak slip minimum odds (default 1.8)"),
        streakMax: z.number().optional().describe("Streak slip maximum odds (default 2.25)"),
        bigTarget: z.number().optional().describe("Big slip target odds (default 10)"),
        bigMax: z.number().optional().describe("Big slip maximum odds (default 13)"),
        minLegProb: z.number().optional().describe("Lowest chance allowed for any leg (default 0.72)"),
        maxRequests: z.number().min(1).max(8).optional().describe("Odds requests to spend, 5 leagues each (default 4)"),
      },
      async ({ date, streakMin, streakMax, bigTarget, bigMax, minLegProb, maxRequests }) => {
        const notes: string[] = [];
        const lagosToday = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
        const day = date ?? lagosToday;
        const dayStart = Date.parse(day + "T00:00:00+01:00");
        const from = new Date(Math.max(dayStart, Date.now() + 10 * 60 * 1000));
        const to = new Date(dayStart + 24 * 3600 * 1000 - 60 * 1000);
        if (from >= to) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ note: "That day is over." }) }] };
        }

        // 1. tournaments with fixtures today
        const tlist: any[] = (await this.op.tournaments()) ?? [];
        const tinfo = new Map<number, { name: string; country: string; prio: number }>();
        for (const t of tlist) {
          const cat = `${t.categorySlug ?? ""} ${t.categoryName ?? ""}`.toLowerCase();
          const tname = String(t.tournamentName ?? "").toLowerCase().trim();
          if (BAD.test(tname)) continue;
          const idx = LEAGUES.findIndex((l) => cat.includes(l.country) && l.names.test(tname));
          if (idx >= 0) tinfo.set(t.tournamentId, { name: String(t.tournamentName), country: String(t.categoryName ?? LEAGUES[idx].country), prio: idx });
        }
        const fixtures: any[] = ((await this.op.fixtures(from.toISOString().slice(0, 19) + "Z", to.toISOString().slice(0, 19) + "Z")) ?? [])
          .filter((f: any) => tinfo.has(f.tournamentId) && Date.parse(f.startTime) >= from.getTime() && Date.parse(f.startTime) <= to.getTime());
        const count = new Map<number, number>();
        for (const f of fixtures) count.set(f.tournamentId, (count.get(f.tournamentId) ?? 0) + 1);
        const reqs = maxRequests ?? 4;
        const chosen = [...count.keys()]
          .sort((a, b) => tinfo.get(a)!.prio - tinfo.get(b)!.prio || count.get(b)! - count.get(a)!)
          .slice(0, reqs * 5);
        const skipped = [...count.keys()].filter((id) => !chosen.includes(id)).map((id) => tinfo.get(id)!.name);
        if (skipped.length) notes.push(`Leagues with games today left out to save the odds quota: ${skipped.join(", ")}`);
        if (!chosen.length) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ day, note: "No fixtures with odds left today in the covered leagues.", notes }) }] };
        }

        // 2. odds
        const metaList: any[] = (await this.op.markets()) ?? [];
        const meta = new Map<string, MarketMeta>();
        for (const m of metaList) {
          const outcomes: Record<string, string> = {};
          for (const o of m.outcomes ?? []) outcomes[String(o.outcomeId)] = String(o.outcomeName ?? "");
          meta.set(String(m.marketId), { name: String(m.marketName ?? ""), handicap: Number(m.handicap ?? 0), type: String(m.marketType ?? ""), period: String(m.period ?? ""), outcomes });
        }
        const odds: any[] = [];
        for (let i = 0; i < chosen.length; i += 5) {
          try {
            odds.push(...((await this.op.oddsByTournaments(chosen.slice(i, i + 5), "pinnacle")) ?? []));
          } catch (e: any) {
            notes.push(`Odds request failed: ${e?.message ?? e}`);
          }
        }
        const oddsById = new Map<string, any>(odds.map((o) => [String(o.fixtureId), o]));

        // 3. candidate legs
        const minP = minLegProb ?? 0.72;
        const cands: Leg[] = [];
        const games: any[] = [];
        fixtures
          .filter((f) => chosen.includes(f.tournamentId))
          .forEach((f, mi) => {
            const o = oddsById.get(String(f.fixtureId));
            if (!o) return;
            const pr = pinnaclePrices(o.bookmakerOdds, meta);
            if (!(pr.home > 1 && pr.draw > 1 && pr.away > 1)) return;
            const [fh, fd, fa] = devig([pr.home, pr.draw, pr.away]);
            const line = pr["over_2.5"] && pr["under_2.5"] ? 2.5 : pr["over_1.5"] && pr["under_1.5"] ? 1.5 : null;
            const fOver = line ? devig([pr[`over_${line}`], pr[`under_${line}`]])[0] : null;
            const T = line && fOver ? totalFromOver(line, fOver) : 2.6;
            const { lh, la } = fitRates(T, fh, fa);
            const ti = tinfo.get(f.tournamentId)!;
            const home = String(f.participant1Name);
            const away = String(f.participant2Name);
            const base = {
              mi,
              tournamentId: f.tournamentId,
              competition: `OP:${ti.name}`,
              league: `${titleCase(ti.country)}, ${ti.name}`,
              home, away,
              kickoffUtc: String(f.startTime),
              kickoffLagos: lagosTime(String(f.startTime)),
            };
            const add = (key: string, label: string, market: string, tap: string, prob: number, price: number) => {
              if (prob < minP || price < 1.03) return;
              // minOdds: SportyBet should show about our price; 5%+ lower usually means news (injury, line-up) - skip then.
              cands.push({ ...base, key, label, market, tap, prob: r3(prob), price: r2(price), minOdds: Math.floor(price * 0.95 * 100) / 100 });
            };
            games.push({ match: `${home} v ${away}`, league: base.league, kickoffLagos: base.kickoffLagos, fair: { home: r3(fh), draw: r3(fd), away: r3(fa) }, expGoals: { home: r2(lh), away: r2(la) } });

            for (const side of ["home", "away"] as const) {
              const fWin = side === "home" ? fh : fa;
              if (fWin < 0.45) continue;
              const team = side === "home" ? home : away;
              const [lf, lo] = side === "home" ? [lh, la] : [la, lh];
              const lead = everLeadsProb(lf, lo) - 0.01; // small safety margin
              const drawNoLead = drawWithoutLeadingProb(lf, lo);
              const winPrice = side === "home" ? pr.home : pr.away;
              const dcFair = side === "home" ? fh + fd : fa + fd;
              // SportyBet's 1UP prices sit a little under its normal prices (about 7% under Pinnacle).
              add(`${side}_1up`, `${team} to win (1UP)`, "1X2 - 1UP", side === "home" ? "Home" : "Away", lead, winPrice * 0.93);
              add(`${side}_or_draw_1up`, `${team} or draw (1UP)`, "DC - 1UP", side === "home" ? "Home or Draw" : "Draw or Away", lead + drawNoLead, (1 / dcFair) * 0.91); // calibrated: SportyBet 1.11 / 1.16 vs our 1.13 / 1.19 on 20 Oct
              add(`${side}_or_draw`, `${team} or draw`, "Double Chance", side === "home" ? "Home or Draw" : "Draw or Away", dcFair - 0.01, (1 / dcFair) * 0.94);
              const tt = pr[`${side}_over_0.5`] && pr[`${side}_under_0.5`] ? devig([pr[`${side}_over_0.5`], pr[`${side}_under_0.5`]])[0] : 1 - poissonPmf(0, lf);
              add(`${side}_over_0.5`, `${team} to score (Over 0.5)`, `${team} Over/Under`, "Over 0.5", tt - 0.01, (1 / tt) * 0.94);
            }
            add("home_or_away", "Either team to win (12)", "Double Chance", "Home or Away", 1 - fd - 0.01, (1 / (1 - fd)) * 0.94);
            if (pr["over_1.5"] && pr["under_1.5"]) {
              const p15 = devig([pr["over_1.5"], pr["under_1.5"]])[0];
              add("over_1.5", "Over 1.5 goals", "Over/Under", "Over 1.5", p15 - 0.01, pr["over_1.5"] * 0.96);
            }
          });

        // Per match keep only the legs that are not dominated (higher chance and higher price beats both).
        const byMatch = new Map<number, Leg[]>();
        for (const c of cands) byMatch.set(c.mi, [...(byMatch.get(c.mi) ?? []), c]);
        const pool: Leg[] = [];
        byMatch.forEach((legs) => {
          for (const l of legs) {
            if (legs.some((o) => o !== l && o.prob >= l.prob && o.price >= l.price && (o.prob > l.prob || o.price > l.price))) continue;
            pool.push(l);
          }
        });

        // 4a. streak slip: exhaustive search, highest chance with odds in range, 2-4 legs, one per match.
        const sMin = streakMin ?? 1.8;
        const sMax = streakMax ?? 2.25;
        const sPool = [...pool].sort((a, b) => b.prob - a.prob).slice(0, 40);
        let best: { legs: Leg[]; odds: number; prob: number } | null = null;
        const search = (start: number, legs: Leg[], odds: number, prob: number) => {
          if (best && prob <= best.prob) return;
          if (legs.length >= 2 && odds >= sMin && odds <= sMax) { best = { legs: [...legs], odds, prob }; return; }
          if (legs.length >= 4 || odds > sMax) return;
          for (let i = start; i < sPool.length; i++) {
            const l = sPool[i];
            if (legs.some((x) => x.mi === l.mi)) continue;
            legs.push(l);
            search(i + 1, legs, odds * l.price, prob * l.prob);
            legs.pop();
          }
        };
        search(0, [], 1, 1);
        const streak = best as { legs: Leg[]; odds: number; prob: number } | null;

        // 4b. big slip: greedy by least chance lost per unit of log-odds, different leagues (max 2 per league).
        const target = bigTarget ?? 10;
        const cap = bigMax ?? 13;
        const used = new Set<number>((streak?.legs ?? []).map((l) => l.mi));
        const bPool = pool
          .filter((l) => !used.has(l.mi))
          .sort((a, b) => Math.log(b.prob) / Math.log(b.price) - Math.log(a.prob) / Math.log(a.price));
        const big: Leg[] = [];
        const perLeague = new Map<number, number>();
        let bOdds = 1;
        for (const l of bPool) {
          if (bOdds >= target) break;
          if (big.some((x) => x.mi === l.mi)) continue;
          if ((perLeague.get(l.tournamentId) ?? 0) >= 2) continue;
          if (bOdds * l.price > cap) continue;
          big.push(l);
          perLeague.set(l.tournamentId, (perLeague.get(l.tournamentId) ?? 0) + 1);
          bOdds *= l.price;
        }
        const bProb = big.reduce((x, l) => x * l.prob, 1);

        const strip = ({ mi, tournamentId, ...r }: Leg) => r;
        const out = {
          day,
          streakSlip: streak
            ? { bookable: true, combinedOdds: r2(streak.odds), estWinProb: r3(streak.prob), legs: streak.legs.sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc)).map(strip) }
            : { bookable: false, note: `No 2-4 leg combination of ${Math.round(minP * 100)}%+ legs lands between ${sMin} and ${sMax} today.` },
          bigSlip: big.length >= 2 && bOdds >= target * 0.8
            ? { bookable: true, combinedOdds: r2(bOdds), estWinProb: r3(bProb), legs: big.sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc)).map(strip) }
            : { bookable: false, combinedOdds: r2(bOdds), note: `Not enough safe legs left today to reach about ${target} odds.` },
          prices: "SportyBet prices are estimates from Pinnacle. If SportyBet shows a leg below its minOdds, something has changed (team news): leave that slip out today. The slip total on SportyBet will differ a little.",
          gamesPriced: games.length,
          leagues: chosen.map((id) => tinfo.get(id)!.name),
          notes,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      }
    );
  }
}
