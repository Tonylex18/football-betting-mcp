import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FootballApiService } from "../../infrastructure/services/footballApiService.js";
import { FootballDataService, OddsPapiService } from "../../infrastructure/services/liveSources.js";

/**
 * European cups (Europa League + Conference League).
 *
 * Teams are grouped by the strength of their domestic league:
 *   T1 = England, Spain, Italy, Germany, France
 *   T2 = Portugal, Netherlands, Belgium, Turkey, Scotland, Austria, Czechia,
 *        Switzerland, Greece, Denmark
 *   T3 = everyone else
 * scan-euro-cups measures, on past seasons, how each tier matchup (e.g. a T1
 * team at home to a T3 team) actually ends. get-euro-slate applies those
 * measured rates to today's cup fixtures and calibrates against Pinnacle.
 */

const T1 = [39, 140, 135, 78, 61];
const T2 = [94, 88, 144, 203, 179, 218, 345, 207, 197, 119];
const CUPS: Record<number, string> = { 3: "Europa League", 848: "Conference League" };
const DIR = nodePath.join(os.homedir(), ".mcp-football-cache");
const RULES_FILE = nodePath.join(DIR, "euro-rules.json");
const TIERS_FILE = nodePath.join(DIR, "euro-tiers.json");
const FINISHED = new Set(["FT", "AET", "PEN"]);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function norm(s: string) {
  return (s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\b(fc|cf|sc|ac|afc|sv|fk|sk|nk|bk|if|ik|ks|cd|ud|rc|club|de|the|and)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

type Bucket = { n: number; hw: number; d: number; aw: number; o25: number; btts: number };
const emptyB = (): Bucket => ({ n: 0, hw: 0, d: 0, aw: 0, o25: 0, btts: 0 });

export class EuroCupsController {
  constructor(
    private server: McpServer,
    private api: FootballApiService,
    private fd: FootballDataService,
    private op: OddsPapiService
  ) {
    this.registerScan();
    this.registerSlate();
  }

  /** Fetch with a per-call budget of uncached requests so the tool never times out. */
  private budgeted() {
    let used = 0;
    const max = 8;
    return async (path: string, params: Record<string, string | number>) => {
      // FootballApiService serves finished seasons from disk without network.
      if (used >= max) throw new Error("__BUDGET__");
      const before = Date.now();
      const data = await this.api.get(path, params);
      if (Date.now() - before > 150) used++; // took real network time
      return data;
    };
  }

  private registerScan(): void {
    this.server.tool(
      "scan-euro-cups",
      "Backtest Europa League + Conference League seasons: how tier matchups end (home/draw/away, over 2.5, BTTS), " +
        "where tiers come from the strength of each team's domestic league. Downloads team lists and cup fixtures in " +
        "chunks (free plan limits); if it says 'warming up', call it again. Saves the measured rules for get-euro-slate.",
      { seasons: z.array(z.number()).optional().describe("Season start years (default [2022, 2023, 2024])") },
      async ({ seasons }) => {
        const yrs = seasons?.length ? seasons : [2022, 2023, 2024];
        const get = this.budgeted();
        const tierOf = new Map<number, number>();
        const nameTier: Record<string, number> = {};
        try {
          for (const y of yrs) {
            for (const [tier, list] of [[1, T1], [2, T2]] as const) {
              for (const lg of list) {
                const d = await get("/teams", { league: lg, season: y });
                for (const t of d.response ?? []) {
                  if (!tierOf.has(t.team.id) || tierOf.get(t.team.id)! > tier) tierOf.set(t.team.id, tier);
                  if (y === yrs[yrs.length - 1]) nameTier[norm(t.team.name)] = tier;
                }
              }
            }
          }
          const buckets: Record<string, Bucket> = {};
          const byStage: Record<string, Bucket> = {};
          for (const y of yrs) {
            for (const cup of Object.keys(CUPS).map(Number)) {
              const d = await get("/fixtures", { league: cup, season: y });
              for (const f of d.response ?? []) {
                if (!FINISHED.has(f.fixture.status.short)) continue;
                const hg = f.score?.fulltime?.home, ag = f.score?.fulltime?.away;
                if (hg == null || ag == null) continue;
                const th = tierOf.get(f.teams.home.id) ?? 3;
                const ta = tierOf.get(f.teams.away.id) ?? 3;
                const key = `T${th}vT${ta}`;
                const qual = /qualif|play-off|preliminary/i.test(String(f.league.round ?? ""));
                for (const [store, k] of [[buckets, key], [byStage, `${key}:${qual ? "qualifying" : "main"}`]] as const) {
                  const b = (store[k] = store[k] ?? emptyB());
                  b.n++;
                  if (hg > ag) b.hw++; else if (hg === ag) b.d++; else b.aw++;
                  if (hg + ag > 2.5) b.o25++;
                  if (hg > 0 && ag > 0) b.btts++;
                }
              }
            }
          }
          const fmt = (b: Bucket) => ({ matches: b.n, homeWin: pct(b.hw, b.n), draw: pct(b.d, b.n), awayWin: pct(b.aw, b.n), over2_5: pct(b.o25, b.n), btts: pct(b.btts, b.n) });
          const rules: any = {};
          for (const [k, b] of Object.entries(buckets)) rules[k] = { n: b.n, home: b.hw / b.n, draw: b.d / b.n, away: b.aw / b.n, over_2_5: b.o25 / b.n, btts: b.btts / b.n };
          fs.mkdirSync(DIR, { recursive: true });
          fs.writeFileSync(RULES_FILE, JSON.stringify({ seasons: yrs, rules }));
          fs.writeFileSync(TIERS_FILE, JSON.stringify(nameTier));
          const out: any = {};
          for (const k of Object.keys(buckets).sort()) out[k] = fmt(buckets[k]);
          const stage: any = {};
          for (const k of Object.keys(byStage).sort()) stage[k] = fmt(byStage[k]);
          return { content: [{ type: "text" as const, text: JSON.stringify({ seasons: yrs, tierMatchups: out, byStage: stage, note: "T1 = big five leagues, T2 = next ten, T3 = rest. Key T1vT3 = T1 team at home to a T3 team. Rules saved for get-euro-slate." }) }] };
        } catch (e: any) {
          if (e?.message === "__BUDGET__") {
            return { content: [{ type: "text" as const, text: JSON.stringify({ status: "warming up", note: "Downloaded the next chunk of team lists / cup fixtures (free plan: 10 requests/minute). Call scan-euro-cups again." }) }] };
          }
          throw e;
        }
      }
    );
  }

  private registerSlate(): void {
    this.server.tool(
      "get-euro-slate",
      "Europa League + Conference League picks for a day: today's cup fixtures and Pinnacle odds from OddsPapi, each team's " +
        "tier from its domestic league, the measured base rate for that tier matchup (from scan-euro-cups), calibrated " +
        "50/50 (results) or 35/65 (goals) against Pinnacle's fair odds. Returns selections with prob, price, edge, minOdds. " +
        "Run scan-euro-cups once first.",
      {
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Day to cover, YYYY-MM-DD (default today)"),
        days: z.number().min(1).max(3).optional().describe("Days to cover (default 1)"),
      },
      async ({ startDate, days }) => {
        let rulesDoc: any;
        let nameTier: Record<string, number> = {};
        try {
          rulesDoc = JSON.parse(fs.readFileSync(RULES_FILE, "utf8"));
          nameTier = JSON.parse(fs.readFileSync(TIERS_FILE, "utf8"));
        } catch {
          throw new Error("No European cup rules yet. Run scan-euro-cups first.");
        }
        const notes: string[] = [];
        // Current-season team lists for the leagues football-data covers (fresher than API-Football's past seasons)
        const fdTier: Record<string, number> = { PL: 1, PD: 1, SA: 1, BL1: 1, FL1: 1, DED: 2, PPL: 2 };
        for (const [code, tier] of Object.entries(fdTier)) {
          try {
            const d = await this.fd.standings(code);
            const tbl = (d.standings ?? []).find((s: any) => s.type === "TOTAL")?.table ?? [];
            for (const r of tbl) for (const n of [r.team?.name, r.team?.shortName]) if (n) nameTier[norm(n)] = tier;
          } catch (e: any) {
            notes.push(`${code} team list: ${e?.message ?? e}`);
          }
        }
        const tierFor = (names: (string | undefined)[]) => {
          for (const n of names) {
            const k = norm(n ?? "");
            if (!k) continue;
            if (nameTier[k]) return nameTier[k];
            for (const [kk, t] of Object.entries(nameTier)) if (kk.length >= 4 && (kk.includes(k) || k.includes(kk))) return t;
          }
          return 3;
        };

        const start = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + (days ?? 1) * 24 * 3600 * 1000);

        const tlist: any[] = await this.op.tournaments();
        const cupT = (tlist ?? []).filter((t) => /^uefa (europa|conference) league$/i.test(String(t.tournamentName ?? "").trim()));
        if (!cupT.length) throw new Error("Europa/Conference League not found on OddsPapi.");
        const ids = cupT.map((t) => t.tournamentId);
        const nameOfT = new Map(cupT.map((t) => [t.tournamentId, t.tournamentName]));

        const metaList: any[] = await this.op.markets();
        const meta = new Map<string, any>();
        for (const m of metaList ?? []) meta.set(String(m.marketId), m);
        const fixtures: any[] = ((await this.op.fixtures(start.toISOString().slice(0, 19) + "Z", end.toISOString().slice(0, 19) + "Z")) ?? []).filter((f: any) => ids.includes(f.tournamentId));
        const odds: any[] = fixtures.length ? (await this.op.oddsByTournaments(ids, "pinnacle")) ?? [] : [];
        const oddsById = new Map(odds.map((o) => [String(o.fixtureId), o]));

        const priceOf = (o: any, type: string, handicap: number | null, outcome: string) => {
          const bo = o?.bookmakerOdds?.pinnacle;
          if (!bo) return undefined;
          for (const [mid, mk] of Object.entries<any>(bo.markets ?? {})) {
            const m = meta.get(String(mid));
            if (!m || String(m.period ?? "").toLowerCase() !== "fulltime" || String(m.marketType ?? "").toLowerCase() !== type) continue;
            if (handicap != null && Number(m.handicap) !== handicap) continue;
            for (const [oid, oc] of Object.entries<any>(mk.outcomes ?? {})) {
              const on = (m.outcomes ?? []).find((x: any) => String(x.outcomeId) === String(oid))?.outcomeName;
              if (String(on ?? "").toLowerCase() === outcome) return Number(oc?.players?.["0"]?.price) || undefined;
            }
          }
          return undefined;
        };
        const fair = (ps: (number | undefined)[]) => {
          if (!ps.every((p) => p && p > 1)) return null;
          const inv = ps.map((p) => 1 / (p as number));
          const s = inv.reduce((a, b) => a + b, 0);
          return inv.map((x) => x / s);
        };

        const games: any[] = [];
        const picks: any[] = [];
        for (const f of fixtures) {
          const th = tierFor([f.participant1Name, f.participant1ShortName]);
          const ta = tierFor([f.participant2Name, f.participant2ShortName]);
          const key = `T${th}vT${ta}`;
          const rule = rulesDoc.rules[key];
          const o = oddsById.get(String(f.fixtureId));
          const p1 = priceOf(o, "1x2", null, "1"), px = priceOf(o, "1x2", null, "x"), p2 = priceOf(o, "1x2", null, "2");
          const po = priceOf(o, "totals", 2.5, "over"), pu = priceOf(o, "totals", 2.5, "under");
          const by = priceOf(o, "bothteamsscore", null, "yes"), bn = priceOf(o, "bothteamsscore", null, "no");
          const f1x2 = fair([p1, px, p2]);
          const fou = fair([po, pu]);
          const fbt = fair([by, bn]);
          const g: any = { competition: nameOfT.get(f.tournamentId), kickoffUtc: f.startTime, home: f.participant1Name, away: f.participant2Name, tiers: key, ruleSample: rule?.n ?? 0, selections: [] as any[] };
          const add = (k: string, label: string, base: number | undefined, price: number | undefined, mkt: number | undefined, w: number) => {
            if (base == null || !rule || rule.n < 40) return;
            const prob = mkt != null ? w * base + (1 - w) * mkt : base;
            const s: any = { key: k, label, modelProb: r3(base), marketProb: mkt != null ? r3(mkt) : null, prob: r3(prob), price, minOdds: Math.ceil((1.05 / prob) * 100) / 100 };
            if (price) { s.edge = r3(prob * price - 1); if (s.edge > 0.4) s.suspectPrice = true; }
            g.selections.push(s);
            if (s.edge > 0 && !s.suspectPrice && prob >= 0.6) picks.push({ competition: g.competition, home: g.home, away: g.away, kickoffUtc: g.kickoffUtc, tiers: key, ...s });
          };
          if (rule) {
            if (rule.home >= 0.6) add("home", `${g.home} to win`, rule.home, p1, f1x2?.[0], 0.5);
            if (rule.away >= 0.6) add("away", `${g.away} to win`, rule.away, p2, f1x2?.[2], 0.5);
            if (rule.home + rule.draw >= 0.8) add("home_or_draw", `${g.home} or draw (1X)`, rule.home + rule.draw, undefined, f1x2 ? f1x2[0] + f1x2[1] : undefined, 0.5);
            if (rule.over_2_5 >= 0.6) add("over_2.5", "Over 2.5 goals", rule.over_2_5, po, fou?.[0], 0.35);
            if (rule.btts >= 0.6) add("btts_yes", "Both teams to score", rule.btts, by, fbt?.[0], 0.35);
            if (1 - rule.btts >= 0.6) add("btts_no", "BTTS - No", 1 - rule.btts, bn, fbt?.[1], 0.35);
          }
          if (!o) g.oddsNote = "No Pinnacle odds yet";
          games.push(g);
        }
        picks.sort((a, b) => b.edge - a.edge);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              window: { from: start.toISOString(), to: end.toISOString() },
              rulesFromSeasons: rulesDoc.seasons,
              valuePicks: picks.slice(0, 10),
              games,
              notes,
              method: "Base rate for the tier matchup from past Europa/Conference League seasons, blended with Pinnacle fair odds (50/50 results, 35/65 goals). Only rules with 40+ past matches are used.",
              caution: "Cup games carry rotation risk (big clubs rest players). Check line-ups and team news before betting.",
            }),
          }],
        };
      }
    );
  }
}
