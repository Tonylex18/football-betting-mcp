import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FootballDataService, OddsPapiService } from "../../infrastructure/services/liveSources.js";

/**
 * Daily slate: today's (or the next few days') fixtures in the chosen leagues,
 * with current-season stats, rule-based probabilities, bookmaker odds, edge,
 * and suggested 2-3 pick slips.
 *
 * Probabilities come from:
 *  - Strong home favourite rules: league base rates measured in our 2022/23 +
 *    2023/24 scan (favourite = 1.0+ points-per-game better, playing at home).
 *  - Goal markets: the home team's home rate and the away team's away rate this
 *    season, shrunk toward the league's current-season average.
 * These are estimates, not certainties. Always check team news before betting.
 */

type Comp = {
  name: string;
  country: string[];
  tournamentNames: string[];
  strongHomeWin: number;
  strongHomeNotLose: number;
};

// Base rates from scan-leagues (average of 2022/23 and 2023/24 where available).
const COMPS: Record<string, Comp> = {
  PPL: { name: "Primeira Liga", country: ["portugal"], tournamentNames: ["liga portugal", "primeira liga", "liga portugal betclic"], strongHomeWin: 0.863, strongHomeNotLose: 0.931 },
  DED: { name: "Eredivisie", country: ["netherlands"], tournamentNames: ["eredivisie"], strongHomeWin: 0.833, strongHomeNotLose: 0.972 },
  BL1: { name: "Bundesliga", country: ["germany"], tournamentNames: ["bundesliga"], strongHomeWin: 0.713, strongHomeNotLose: 0.927 },
  PL: { name: "Premier League", country: ["england"], tournamentNames: ["premier league"], strongHomeWin: 0.74, strongHomeNotLose: 0.947 },
  PD: { name: "La Liga", country: ["spain"], tournamentNames: ["laliga", "la liga"], strongHomeWin: 0.782, strongHomeNotLose: 0.959 },
  SA: { name: "Serie A", country: ["italy"], tournamentNames: ["serie a"], strongHomeWin: 0.657, strongHomeNotLose: 0.857 },
  FL1: { name: "Ligue 1", country: ["france"], tournamentNames: ["ligue 1"], strongHomeWin: 0.667, strongHomeNotLose: 0.833 },
  ELC: { name: "Championship", country: ["england"], tournamentNames: ["championship"], strongHomeWin: 0.794, strongHomeNotLose: 0.853 },
};
const DEFAULT_COMPS = ["PPL", "DED", "BL1", "PL"];

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;

/* ---------------- name matching ---------------- */

const STOP = new Set([
  "fc", "cf", "sc", "ac", "afc", "sv", "vfb", "vfl", "tsg", "bv", "fk", "sk", "cd", "ud", "rc", "rcd",
  "de", "da", "do", "the", "club", "futebol", "sad", "and", "hotspur", "albion", "town", "city", "united",
]);

function tokens(name: string): Set<string> {
  const clean = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ");
  const t = clean.split(/\s+/).filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w));
  return new Set(t.length ? t : clean.split(/\s+/).filter(Boolean));
}

function nameScore(a: string[], b: string[]): number {
  let best = 0;
  for (const x of a) {
    for (const y of b) {
      if (!x || !y) continue;
      const nx = x.toLowerCase();
      const ny = y.toLowerCase();
      if (nx === ny) return 1;
      const tx = tokens(x);
      const ty = tokens(y);
      let inter = 0;
      tx.forEach((w) => { if (ty.has(w)) inter++; });
      const union = new Set([...tx, ...ty]).size || 1;
      let s = inter / union;
      // containment: "PSV" vs "PSV Eindhoven"
      if (inter > 0 && (inter === tx.size || inter === ty.size)) s = Math.max(s, 0.75);
      best = Math.max(best, s);
    }
  }
  return best;
}

/* ---------------- season stats ---------------- */

type Side = { p: number; pts: number; gf: number; ga: number; o15: number; o25: number; btts: number };
const emptySide = (): Side => ({ p: 0, pts: 0, gf: 0, ga: 0, o15: 0, o25: 0, btts: 0 });

type TeamStats = { all: Side; home: Side; away: Side; form: string[] };

function addSide(s: Side, gf: number, ga: number) {
  s.p++;
  s.gf += gf;
  s.ga += ga;
  s.pts += gf > ga ? 3 : gf === ga ? 1 : 0;
  const t = gf + ga;
  if (t > 1.5) s.o15++;
  if (t > 2.5) s.o25++;
  if (gf > 0 && ga > 0) s.btts++;
}

function buildStats(matches: any[]) {
  const teams = new Map<number, TeamStats>();
  const league = emptySide();
  const finished = matches
    .filter((m) => m.status === "FINISHED" && m.score?.fullTime?.home != null)
    .sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate));
  const get = (id: number) => {
    let t = teams.get(id);
    if (!t) { t = { all: emptySide(), home: emptySide(), away: emptySide(), form: [] }; teams.set(id, t); }
    return t;
  };
  for (const m of finished) {
    const hg = m.score.fullTime.home;
    const ag = m.score.fullTime.away;
    const h = get(m.homeTeam.id);
    const a = get(m.awayTeam.id);
    addSide(h.all, hg, ag); addSide(h.home, hg, ag);
    addSide(a.all, ag, hg); addSide(a.away, ag, hg);
    h.form.push(hg > ag ? "W" : hg === ag ? "D" : "L");
    a.form.push(ag > hg ? "W" : hg === ag ? "D" : "L");
    addSide(league, hg, ag);
  }
  return { teams, league, finishedCount: finished.length };
}

const rate = (n: number, d: number) => (d ? n / d : 0);
/** Shrink a small-sample rate toward the league base. */
const shrink = (r: number, n: number, base: number, k = 6) =>
  Math.min(0.92, Math.max(0.08, (n * r + k * base) / (n + k))); // never claim near-certainty

/* ---------------- odds parsing ---------------- */

type MarketMeta = { name: string; handicap: number; type: string; period: string; outcomes: Record<string, string> };

/**
 * Classify by OddsPapi's marketType + period (verified against real responses):
 *   1x2 / fulltime            -> match result
 *   bothteamsscore / fulltime -> BTTS
 *   totals / fulltime         -> match goals over/under (NOT teamtotals-team1/2)
 *   double chance (by name)   -> 1X / X2
 */
function classifyMarket(m: MarketMeta): string | null {
  const type = (m.type ?? "").toLowerCase();
  const period = (m.period ?? "").toLowerCase();
  const name = (m.name ?? "").toLowerCase();
  if (period && period !== "fulltime") return null;
  if (type === "1x2") return "1x2";
  if (type === "bothteamsscore") return "btts";
  if (type === "totals" && [1.5, 2.5, 3.5].includes(m.handicap)) return "ou" + m.handicap;
  if (type.includes("doublechance") || name === "double chance" || name === "double chance full time") return "dc";
  return null;
}

/** Map a fixture's bookmakerOdds into {selectionKey: {slug: price}} */
function extractPrices(bookmakerOdds: any, meta: Map<string, MarketMeta>) {
  const out: Record<string, Record<string, number>> = {};
  for (const [slug, bo] of Object.entries<any>(bookmakerOdds ?? {})) {
    if (bo?.bookmakerIsActive === false || bo?.suspended) continue;
    for (const [marketId, mk] of Object.entries<any>(bo.markets ?? {})) {
      const mm = meta.get(String(marketId));
      if (!mm) continue;
      const kind = classifyMarket(mm);
      if (!kind) continue;
      for (const [outcomeId, oc] of Object.entries<any>(mk.outcomes ?? {})) {
        const player = oc?.players?.["0"];
        const price = Number(player?.price);
        if (!price || player?.active === false) continue;
        const oname = (mm.outcomes[String(outcomeId)] ?? "").toLowerCase();
        let sel: string | null = null;
        if (kind === "1x2") sel = oname === "1" ? "home" : oname === "x" ? "draw" : oname === "2" ? "away" : null;
        else if (kind === "dc") sel = oname.replace(/\s/g, "") === "1x" ? "home_or_draw" : oname.replace(/\s/g, "") === "x2" ? "away_or_draw" : null;
        else if (kind === "btts") sel = oname === "yes" ? "btts_yes" : oname === "no" ? "btts_no" : null;
        else if (kind.startsWith("ou")) {
          const side = oname.startsWith("over") ? "over" : oname.startsWith("under") ? "under" : null;
          sel = side ? `${side}_${kind.slice(2)}` : null;
        }
        if (!sel) continue;
        out[sel] = out[sel] ?? {};
        if (out[sel][slug] == null) out[sel][slug] = price;
      }
    }
  }
  return out;
}

/* ---------------- controller ---------------- */

export class DailySlateController {
  constructor(private server: McpServer, private fd: FootballDataService, private op: OddsPapiService) {
    this.registerSlate();
    this.registerTable();
    this.registerBookmakers();
    this.registerInspectOdds();
  }

  private registerInspectOdds(): void {
    this.server.tool(
      "inspect-odds-markets",
      "Debug view of how OddsPapi labels markets for one fixture: every market's id, name, handicap, type, period and " +
        "outcome names with prices, per bookmaker. Uses cached odds when available. Use it to verify market mapping.",
      {
        competition: z.string().describe("Competition code whose tournament to inspect, e.g. DED"),
        bookmaker: z.string().describe("Bookmaker slug, e.g. pinnacle or sportybet"),
        match: z.string().optional().describe("Part of a team name to pick the fixture (default: first fixture)"),
        filter: z.string().optional().describe("Only markets whose name contains this text, e.g. 'over'"),
      },
      async ({ competition, bookmaker, match, filter }) => {
        const code = competition.toUpperCase();
        const tmap = await this.resolveTournaments([code]);
        const tId = tmap[code];
        if (!tId) throw new Error(`No OddsPapi tournament found for ${code}`);
        const metaList: any[] = await this.op.markets();
        const meta = new Map<string, any>();
        for (const m of metaList ?? []) meta.set(String(m.marketId), m);
        const odds: any[] = await this.op.oddsByTournaments([tId], bookmaker);
        const sample = odds.find((o) => {
          if (!match) return true;
          const q = match.toLowerCase();
          return JSON.stringify(o).toLowerCase().includes(q);
        }) ?? odds[0];
        if (!sample) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ tournamentId: tId, fixtures: 0, note: "No odds returned for this bookmaker" }) }] };
        }
        const books = Object.keys(sample.bookmakerOdds ?? {});
        const rows: any[] = [];
        for (const [slug, bo] of Object.entries<any>(sample.bookmakerOdds ?? {})) {
          for (const [mid, mk] of Object.entries<any>(bo.markets ?? {})) {
            const m = meta.get(String(mid));
            const name = String(m?.marketName ?? "(unknown market id)");
            if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;
            const outs: any[] = [];
            for (const [oid, oc] of Object.entries<any>(mk.outcomes ?? {})) {
              const metaOut = (m?.outcomes ?? []).find((x: any) => String(x.outcomeId) === String(oid));
              outs.push({ outcomeId: oid, name: metaOut?.outcomeName ?? null, bookmakerOutcomeId: oc?.players?.["0"]?.bookmakerOutcomeId ?? null, price: oc?.players?.["0"]?.price ?? null });
            }
            rows.push({ slug, marketId: mid, name, handicap: m?.handicap, type: m?.marketType, period: m?.period, playerProp: m?.playerProp, classifiedAs: m ? classifyMarket({ name, handicap: Number(m.handicap ?? 0), type: String(m.marketType ?? ""), period: String(m.period ?? ""), outcomes: {} }) : null, outcomes: outs });
          }
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              tournamentId: tId,
              fixturesWithOdds: odds.length,
              fixtureId: sample.fixtureId,
              participants: [sample.participant1Id, sample.participant2Id],
              bookmakersInResponse: books,
              markets: rows.slice(0, 80),
            }),
          }],
        };
      }
    );
  }

  private async resolveTournaments(codes: string[]) {
    const list: any[] = await this.op.tournaments();
    const out: Record<string, number> = {};
    for (const code of codes) {
      const c = COMPS[code];
      const cands = list.filter((t) => {
        const cat = `${t.categorySlug ?? ""} ${t.categoryName ?? ""}`.toLowerCase();
        return c.country.some((k) => cat.includes(k));
      });
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
      let hit = cands.find((t) => c.tournamentNames.includes(norm(t.tournamentName ?? "")));
      if (!hit) {
        const containing = cands
          .filter((t) => c.tournamentNames.some((n) => norm(t.tournamentName ?? "").includes(n)))
          .filter((t) => !/\b(2|ii|women|u\d+|youth|cup|play)/i.test(t.tournamentName ?? ""))
          .sort((a, b) => (a.tournamentName ?? "").length - (b.tournamentName ?? "").length);
        hit = containing[0];
      }
      if (hit) out[code] = hit.tournamentId;
    }
    return out;
  }

  private registerSlate(): void {
    this.server.tool(
      "get-daily-slate",
      "Betting slate for today or any upcoming day(s) (startDate + days) from CURRENT-season data: upcoming fixtures in the chosen leagues with live table form, " +
        "rule-based win/goal probabilities, bookmaker odds (OddsPapi), edge per selection, and suggested 2-3 pick slips " +
        "around the target odds. Default leagues: PPL (Portugal), DED (Netherlands), BL1 (Germany), PL (England). " +
        "Also available: PD, SA, FL1, ELC. Uses ~1 football-data request per league plus 2-3 OddsPapi requests (cached). " +
        "Always check team news/injuries for the picked matches before betting.",
      {
        days: z.number().min(1).max(7).optional().describe("How many days to cover from the start date (default 1, max 7)"),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First day to cover, YYYY-MM-DD (default today)"),
        competitions: z.array(z.string()).optional().describe("football-data.org codes, e.g. ['PPL','DED']"),
        bookmakers: z.string().optional().describe("OddsPapi bookmaker slugs, comma-separated, max 3 (one request each). First one is used for edge. Default sportybet,pinnacle"),
        minSlipOdds: z.number().optional().describe("Minimum combined slip odds (default 2.0)"),
        maxSlipOdds: z.number().optional().describe("Maximum combined slip odds (default 3.2)"),
        withOdds: z.boolean().optional().describe("Fetch bookmaker odds (default true). Set false to save OddsPapi quota."),
      },
      async ({ days, startDate, competitions, bookmakers, minSlipOdds, maxSlipOdds, withOdds }) => {
        const nDays = days ?? 1;
        const codes = (competitions?.length ? competitions : DEFAULT_COMPS).map((c) => c.toUpperCase()).filter((c) => COMPS[c]);
        const start = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + nDays * 24 * 3600 * 1000);
        const now = Date.now();
        const notes: string[] = [];

        /* 1. current-season stats + upcoming fixtures */
        type Cand = any;
        const matchesOut: any[] = [];
        for (const code of codes) {
          let data: any;
          try {
            data = await this.fd.seasonMatches(code);
          } catch (e: any) {
            notes.push(`${code}: ${e?.message ?? e}`);
            continue;
          }
          const all: any[] = data.matches ?? [];
          const { teams, league, finishedCount } = buildStats(all);
          const base = {
            o15: rate(league.o15, league.p),
            o25: rate(league.o25, league.p),
            btts: rate(league.btts, league.p),
          };
          const upcoming = all.filter((m) => {
            const t = Date.parse(m.utcDate);
            return (m.status === "SCHEDULED" || m.status === "TIMED") && t >= Math.max(start.getTime(), now - 3600 * 1000) && t < end.getTime();
          });
          for (const m of upcoming) {
            const h = teams.get(m.homeTeam.id);
            const a = teams.get(m.awayTeam.id);
            const entry: any = {
              competition: code,
              league: COMPS[code].name,
              kickoffUtc: m.utcDate,
              home: m.homeTeam.shortName ?? m.homeTeam.name,
              away: m.awayTeam.shortName ?? m.awayTeam.name,
              _names: { home: [m.homeTeam.name, m.homeTeam.shortName, m.homeTeam.tla], away: [m.awayTeam.name, m.awayTeam.shortName, m.awayTeam.tla] },
              selections: [] as Cand[],
            };
            if (!h || !a || h.all.p < 5 || a.all.p < 5) {
              entry.note = "Too few games played this season for reliable rules.";
              matchesOut.push(entry);
              continue;
            }
            const ppgH = h.all.pts / h.all.p;
            const ppgA = a.all.pts / a.all.p;
            const gap = ppgH - ppgA;
            entry.form = {
              home: { ppg: r2(ppgH), homePpg: h.home.p ? r2(h.home.pts / h.home.p) : null, last6: h.form.slice(-6).reverse().join(""), gfPerGame: r2(h.all.gf / h.all.p), gaPerGame: r2(h.all.ga / h.all.p) },
              away: { ppg: r2(ppgA), awayPpg: a.away.p ? r2(a.away.pts / a.away.p) : null, last6: a.form.slice(-6).reverse().join(""), gfPerGame: r2(a.all.gf / a.all.p), gaPerGame: r2(a.all.ga / a.all.p) },
              ppgGap: r2(gap),
            };

            if (gap >= 1.0) {
              entry.selections.push({ key: "home", label: `${entry.home} to win`, prob: COMPS[code].strongHomeWin, why: `Strong home favourite (PPG gap ${r2(gap)}); league base rate` });
              entry.selections.push({ key: "home_or_draw", label: `${entry.home} or draw (1X)`, prob: COMPS[code].strongHomeNotLose, why: `Strong home favourite not losing; league base rate` });
            } else if (gap >= 0.5) {
              entry.note = `Mild home favourite (PPG gap ${r2(gap)}) - no strong 1X2 rule.`;
            } else if (gap <= -1.0) {
              entry.note = `Strong AWAY favourite (PPG gap ${r2(gap)}) - away favourites are less reliable; not rated.`;
            }

            const nGoal = Math.min(h.home.p, a.away.p);
            const pO15 = shrink((rate(h.home.o15, h.home.p) + rate(a.away.o15, a.away.p)) / 2, nGoal, base.o15);
            const pO25 = shrink((rate(h.home.o25, h.home.p) + rate(a.away.o25, a.away.p)) / 2, nGoal, base.o25);
            const pBtts = shrink((rate(h.home.btts, h.home.p) + rate(a.away.btts, a.away.p)) / 2, nGoal, base.btts);
            const goalWhy = `home team at home + away team away this season (n=${nGoal}), shrunk to league avg`;
            if (pO15 >= 0.7) entry.selections.push({ key: "over_1.5", label: "Over 1.5 goals", prob: pO15, why: goalWhy });
            if (pO25 >= 0.58) entry.selections.push({ key: "over_2.5", label: "Over 2.5 goals", prob: pO25, why: goalWhy });
            if (pO25 <= 0.4) entry.selections.push({ key: "under_2.5", label: "Under 2.5 goals", prob: 1 - pO25, why: goalWhy });
            if (pBtts >= 0.6) entry.selections.push({ key: "btts_yes", label: "Both teams to score", prob: pBtts, why: goalWhy });
            if (pBtts <= 0.4) entry.selections.push({ key: "btts_no", label: "BTTS - No", prob: 1 - pBtts, why: goalWhy });
            matchesOut.push(entry);
          }
          notes.push(`${code}: ${finishedCount} finished matches this season used for stats; ${upcoming.length} fixtures in window.`);
        }

        /* 2. odds */
        const books = (bookmakers ?? this.op.defaultBookmakers).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3);
        const primary = books[0];
        if ((withOdds ?? true) && this.op.configured && matchesOut.length) {
          try {
            const tmap = await this.resolveTournaments(codes);
            const ids = Object.values(tmap);
            notes.push(`OddsPapi tournaments: ${JSON.stringify(tmap)}`);
            if (ids.length) {
              const metaList: any[] = await this.op.markets();
              const meta = new Map<string, MarketMeta>();
              for (const m of metaList ?? []) {
                const outcomes: Record<string, string> = {};
                for (const o of m.outcomes ?? []) outcomes[String(o.outcomeId)] = String(o.outcomeName ?? "");
                meta.set(String(m.marketId), { name: String(m.marketName ?? ""), handicap: Number(m.handicap ?? 0), type: String(m.marketType ?? ""), period: String(m.period ?? ""), outcomes });
              }
              const fixtures: any[] = await this.op.fixtures(
                new Date(start.getTime()).toISOString().slice(0, 19) + "Z",
                new Date(end.getTime()).toISOString().slice(0, 19) + "Z"
              );
              const fxById = new Map<string, any>();
              for (const f of fixtures ?? []) if (ids.includes(f.tournamentId)) fxById.set(String(f.fixtureId), f);
              // One request per bookmaker; merge bookmakerOdds per fixture.
              const oddsById = new Map<string, any>();
              for (const book of books) {
                try {
                  const odds: any[] = await this.op.oddsByTournaments(ids, book);
                  for (const o of odds ?? []) {
                    const key = String(o.fixtureId);
                    const prev = oddsById.get(key);
                    if (prev) prev.bookmakerOdds = { ...prev.bookmakerOdds, ...(o.bookmakerOdds ?? {}) };
                    else oddsById.set(key, { ...o, bookmakerOdds: { ...(o.bookmakerOdds ?? {}) } });
                  }
                } catch (e: any) {
                  notes.push(`Odds for ${book} unavailable: ${e?.message ?? e}`);
                }
              }

              for (const entry of matchesOut) {
                const tId = tmap[entry.competition];
                const ko = Date.parse(entry.kickoffUtc);
                let best: any = null;
                let bestScore = 0;
                fxById.forEach((f) => {
                  if (f.tournamentId !== tId) return;
                  if (Math.abs(Date.parse(f.startTime) - ko) > 3 * 3600 * 1000) return;
                  const sh = nameScore(entry._names.home.filter(Boolean), [f.participant1Name, f.participant1ShortName, f.participant1Abbr].filter(Boolean));
                  const sa = nameScore(entry._names.away.filter(Boolean), [f.participant2Name, f.participant2ShortName, f.participant2Abbr].filter(Boolean));
                  const s = sh + sa;
                  if (sh >= 0.3 && sa >= 0.3 && s > bestScore) { bestScore = s; best = f; }
                });
                if (!best) { entry.oddsNote = "No odds match found"; continue; }
                const o = oddsById.get(String(best.fixtureId));
                if (!o) { entry.oddsNote = "Fixture found but no odds yet"; continue; }
                const prices = extractPrices(o.bookmakerOdds, meta);
                entry.oddsFixtureId = best.fixtureId;
                for (const s of entry.selections) {
                  const p = prices[s.key];
                  if (!p) continue;
                  s.prices = p;
                  s.price = p[primary] ?? Math.max(...Object.values(p));
                  s.priceFrom = p[primary] ? primary : Object.keys(p).find((k) => p[k] === s.price);
                  s.impliedProb = r3(1 / s.price);
                  s.edge = r3(s.prob * s.price - 1);
                  // No real pre-match edge is this big: treat as a mis-mapped market.
                  if (s.edge > 0.4) s.suspectPrice = true;
                }
              }
            }
          } catch (e: any) {
            notes.push(`Odds unavailable: ${e?.message ?? e}`);
          }
        } else if (!this.op.configured) {
          notes.push("ODDSPAPI_KEY not set - showing probabilities without odds.");
        }

        /* 3. slips */
        const pool: any[] = [];
        matchesOut.forEach((m, mi) => {
          for (const s of m.selections) {
            s.prob = r3(s.prob);
            s.minOdds = Math.ceil((1.05 / s.prob) * 100) / 100; // take only at or above this price
            if (s.price && s.edge > 0 && !s.suspectPrice) pool.push({ mi, match: `${m.home} v ${m.away}`, kickoffUtc: m.kickoffUtc, label: s.label, prob: s.prob, price: s.price, priceFrom: s.priceFrom, minOdds: s.minOdds, edge: s.edge });
          }
        });
        pool.sort((a, b) => b.edge - a.edge);
        const top = pool.slice(0, 14);
        const lo = minSlipOdds ?? 2.0;
        const hi = maxSlipOdds ?? 3.2;
        const slips: any[] = [];
        const consider = (legs: any[]) => {
          if (new Set(legs.map((l) => l.mi)).size !== legs.length) return;
          const odds = legs.reduce((x, l) => x * l.price, 1);
          if (odds < lo || odds > hi) return;
          const prob = legs.reduce((x, l) => x * l.prob, 1);
          slips.push({ legs: legs.map(({ mi, ...rest }) => rest), combinedOdds: r2(odds), estWinProb: r3(prob), expectedValue: r3(prob * odds - 1) });
        };
        for (let i = 0; i < top.length; i++)
          for (let j = i + 1; j < top.length; j++) {
            consider([top[i], top[j]]);
            for (let k = j + 1; k < top.length; k++) consider([top[i], top[j], top[k]]);
          }
        slips.sort((a, b) => b.expectedValue - a.expectedValue || b.estWinProb - a.estWinProb);

        for (const m of matchesOut) delete m._names;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              window: { from: start.toISOString(), to: end.toISOString() },
              primaryBookmaker: primary,
              suggestedSlips: slips.slice(0, 3),
              valueSelections: pool.slice(0, 10).map(({ mi, ...r }) => r),
              matches: matchesOut,
              notes,
              caution: "Probabilities are rule-based estimates. Check injuries, suspensions and lineups before betting. Stake small and fixed.",
            }),
          }],
        };
      }
    );
  }

  private registerTable(): void {
    this.server.tool(
      "get-current-table",
      "Current-season league table from football-data.org (overall), with points-per-game and form. " +
        "Codes: PPL, DED, BL1, PL, PD, SA, FL1, ELC, BSA, CL.",
      { competition: z.string().describe("Competition code, e.g. PPL") },
      async ({ competition }) => {
        const data = await this.fd.standings(competition.toUpperCase());
        const total = (data.standings ?? []).find((s: any) => s.type === "TOTAL") ?? data.standings?.[0];
        const rows = (total?.table ?? []).map((r: any) => ({
          pos: r.position,
          team: r.team.shortName ?? r.team.name,
          played: r.playedGames,
          pts: r.points,
          ppg: r.playedGames ? r2(r.points / r.playedGames) : null,
          gd: r.goalDifference,
          form: r.form,
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify({ competition: data.competition?.name, season: data.season?.startDate, rows }) }] };
      }
    );
  }

  private registerBookmakers(): void {
    this.server.tool(
      "list-odds-bookmakers",
      "Bookmakers available on OddsPapi with their slugs (use the slug in ODDSPAPI_BOOKMAKERS or get-daily-slate). " +
        "Pass a search term such as 'sporty' to filter.",
      { search: z.string().optional().describe("Filter by name, e.g. 'sporty'") },
      async ({ search }) => {
        const list: any[] = await this.op.bookmakers();
        const q = search?.toLowerCase();
        const rows = (list ?? [])
          .filter((b) => !q || `${b.bookmakerName} ${b.slug}`.toLowerCase().includes(q))
          .map((b) => ({ name: b.bookmakerName, slug: b.slug }));
        return { content: [{ type: "text" as const, text: JSON.stringify({ count: rows.length, bookmakers: rows.slice(0, 200) }) }] };
      }
    );
  }
}
