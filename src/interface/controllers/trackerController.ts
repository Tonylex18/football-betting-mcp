import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FootballDataService, BallDontLieService } from "../../infrastructure/services/liveSources.js";

/**
 * Results tracker: logs the picks that were sent, settles them against final
 * scores, and keeps a running record (hit rate vs expected, profit at the
 * Pinnacle price and at the minimum SportyBet price).
 * Stored in ~/.mcp-football-cache/picks.json on the user's Mac.
 */

const FILE = nodePath.join(os.homedir(), ".mcp-football-cache", "picks.json");
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;

type Pick = {
  id: string;
  date: string; // Lagos date the pick was sent
  sport: "football" | "basketball";
  competition?: string;
  home: string;
  away: string;
  kickoffUtc: string;
  key: string; // home | away | home_or_draw | over_2.5 | under_2.5 | btts_yes | btts_no | over | under
  line?: number;
  label: string;
  prob: number;
  price?: number;
  minOdds?: number;
  slip?: boolean;
  status: "open" | "won" | "lost" | "void";
  score?: string;
};

function load(): Pick[] {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}
function save(p: Pick[]) {
  fs.mkdirSync(nodePath.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(p, null, 1));
}

function norm(s: string) {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function sameTeam(a: string, names: (string | undefined)[]) {
  const na = norm(a);
  return names.some((n) => {
    const nn = norm(n ?? "");
    return nn && (nn === na || nn.includes(na) || na.includes(nn));
  });
}

function settle(key: string, line: number | undefined, hg: number, ag: number): "won" | "lost" | "void" {
  const tot = hg + ag;
  const ou = (side: "over" | "under", l: number) => {
    if (tot === l) return "void" as const;
    return (side === "over" ? tot > l : tot < l) ? "won" : "lost";
  };
  switch (key) {
    case "home": return hg > ag ? "won" : "lost";
    case "away": return ag > hg ? "won" : "lost";
    case "draw": return hg === ag ? "won" : "lost";
    case "home_or_draw": return hg >= ag ? "won" : "lost";
    case "away_or_draw": return ag >= hg ? "won" : "lost";
    case "btts_yes": return hg > 0 && ag > 0 ? "won" : "lost";
    case "btts_no": return hg > 0 && ag > 0 ? "lost" : "won";
    case "home_spread": { const v = hg + (line ?? 0) - ag; return v === 0 ? "void" : v > 0 ? "won" : "lost"; }
    case "away_spread": { const v = hg + (line ?? 0) - ag; return v === 0 ? "void" : v < 0 ? "won" : "lost"; }
    case "over": return ou("over", line ?? 0);
    case "under": return ou("under", line ?? 0);
  }
  const m = key.match(/^(over|under)_(\d+(\.\d+)?)$/);
  if (m) return ou(m[1] as "over" | "under", Number(m[2]));
  return "void";
}

export class TrackerController {
  constructor(private server: McpServer, private fd: FootballDataService, private bdl: BallDontLieService) {
    this.registerLog();
    this.registerSettle();
    this.registerRecord();
    this.registerManualResult();
  }

  private registerManualResult(): void {
    this.server.tool(
      "record-result",
      "Settle open picks for one match from a final score you looked up (use for competitions the automatic settler " +
        "cannot reach, such as Europa League / Conference League). Score is the 90-minute result, home-away, e.g. '2-1'.",
      {
        home: z.string().describe("Home team as logged"),
        away: z.string().describe("Away team as logged"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Match date (UTC) YYYY-MM-DD"),
        score: z.string().regex(/^\d+-\d+$/).describe("Final score home-away, e.g. 2-1"),
      },
      async ({ home, away, date, score }) => {
        const [hg, ag] = score.split("-").map(Number);
        const all = load();
        const hits = all.filter((p) => p.status === "open" && p.kickoffUtc.slice(0, 10) === date && sameTeam(home, [p.home]) && sameTeam(away, [p.away]));
        for (const p of hits) {
          p.status = settle(p.key, p.line, hg, ag);
          p.score = score;
        }
        save(all);
        return { content: [{ type: "text" as const, text: JSON.stringify({ settled: hits.map((p) => ({ pick: p.label, result: p.status })) }) }] };
      }
    );
  }

  private registerLog(): void {
    this.server.tool(
      "log-picks",
      "Save the picks that were recommended today so they can be settled later. Use the fields from get-daily-slate " +
        "valueSelections (competition, home, away, key, kickoffUtc, label, prob, price, minOdds) or get-basketball-slate " +
        "valuePicks (home, away, key, line, tipoffUtc as kickoffUtc). Mark slip legs with slip=true. Duplicates are ignored.",
      {
        date: z.string().describe("Lagos date the picks were sent, YYYY-MM-DD"),
        picks: z.array(z.object({
          sport: z.enum(["football", "basketball"]),
          competition: z.string().optional(),
          home: z.string(),
          away: z.string(),
          kickoffUtc: z.string(),
          key: z.string(),
          line: z.number().optional(),
          label: z.string(),
          prob: z.number(),
          price: z.number().optional(),
          minOdds: z.number().optional(),
          slip: z.boolean().optional(),
        })).min(1),
      },
      async ({ date, picks }) => {
        const all = load();
        let added = 0;
        for (const p of picks) {
          const id = [p.sport, norm(p.home), norm(p.away), p.kickoffUtc.slice(0, 10), p.key, p.line ?? ""].join("|");
          if (all.some((x) => x.id === id)) continue;
          all.push({ ...p, id, date, status: "open" });
          added++;
        }
        save(all);
        return { content: [{ type: "text" as const, text: JSON.stringify({ added, total: all.length }) }] };
      }
    );
  }

  private registerSettle(): void {
    this.server.tool(
      "settle-picks",
      "Check final scores for all open picks whose match has finished and mark them won/lost/void. " +
        "Uses football-data.org (football) and balldontlie (NBA). Returns what was settled.",
      {},
      async () => {
        const all = load();
        const due = all.filter((p) => p.status === "open" && Date.parse(p.kickoffUtc) < Date.now() - 3 * 3600 * 1000);
        const settled: any[] = [];
        const notes: string[] = [];

        // football, grouped by competition
        const comps = [...new Set(due.filter((p) => p.sport === "football").map((p) => p.competition ?? ""))].filter((c) => c && !["UEL", "UECL"].includes(c));
        for (const code of comps) {
          let matches: any[] = [];
          try {
            matches = (await this.fd.seasonMatches(code)).matches ?? [];
          } catch (e: any) {
            notes.push(`${code}: ${e?.message ?? e}`);
            continue;
          }
          for (const p of due.filter((x) => x.sport === "football" && x.competition === code)) {
            const m = matches.find((mm) =>
              Math.abs(Date.parse(mm.utcDate) - Date.parse(p.kickoffUtc)) < 6 * 3600 * 1000 &&
              sameTeam(p.home, [mm.homeTeam?.shortName, mm.homeTeam?.name, mm.homeTeam?.tla]) &&
              sameTeam(p.away, [mm.awayTeam?.shortName, mm.awayTeam?.name, mm.awayTeam?.tla]));
            if (!m) continue;
            if (["POSTPONED", "CANCELLED", "SUSPENDED"].includes(m.status)) { p.status = "void"; p.score = m.status; settled.push(p); continue; }
            if (m.status !== "FINISHED" || m.score?.fullTime?.home == null) continue;
            const hg = m.score.fullTime.home, ag = m.score.fullTime.away;
            p.status = settle(p.key, p.line, hg, ag);
            p.score = `${hg}-${ag}`;
            settled.push(p);
          }
        }

        // basketball
        const nba = due.filter((p) => p.sport === "basketball");
        if (nba.length) {
          try {
            const now = new Date();
            const season = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
            const games: any[] = await this.bdl.currentSeason(season, `${season}-10-01`, now.toISOString().slice(0, 10));
            for (const p of nba) {
              const g = games.find((gg) =>
                String(gg.status) === "Final" &&
                Math.abs(Date.parse(gg.datetime ?? gg.date) - Date.parse(p.kickoffUtc)) < 18 * 3600 * 1000 &&
                sameTeam(p.home, [gg.home_team?.full_name, gg.home_team?.name]) &&
                sameTeam(p.away, [gg.visitor_team?.full_name, gg.visitor_team?.name]));
              if (!g) continue;
              const hg = Number(g.home_team_score), ag = Number(g.visitor_team_score);
              p.status = settle(p.key, p.line, hg, ag);
              p.score = `${hg}-${ag}`;
              settled.push(p);
            }
          } catch (e: any) {
            notes.push(`NBA: ${e?.message ?? e}`);
          }
        }

        save(all);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              settled: settled.map((p) => ({ date: p.date, match: `${p.home} v ${p.away}`, pick: p.label, result: p.status, score: p.score, price: p.price })),
              stillOpen: all.filter((p) => p.status === "open").length,
              needManualResult: all
                .filter((p) => p.status === "open" && Date.parse(p.kickoffUtc) < Date.now() - 3 * 3600 * 1000 && ["UEL", "UECL"].includes(p.competition ?? ""))
                .map((p) => ({ home: p.home, away: p.away, date: p.kickoffUtc.slice(0, 10), pick: p.label })),
              notes,
            }),
          }],
        };
      }
    );
  }

  private registerRecord(): void {
    this.server.tool(
      "get-pick-record",
      "Running record of all settled picks: hit rate vs the hit rate our probabilities expected, profit per 1-unit " +
        "stake at the Pinnacle price and at the minimum SportyBet price, split by sport, plus slip results by day.",
      { days: z.number().optional().describe("Only include picks from the last N days (default all)") },
      async ({ days }) => {
        const cutoff = days ? Date.now() - days * 24 * 3600 * 1000 : 0;
        const all = load().filter((p) => Date.parse(p.date) >= cutoff);
        const done = all.filter((p) => p.status === "won" || p.status === "lost");
        const sum = (ps: Pick[]) => {
          const won = ps.filter((p) => p.status === "won");
          const withPrice = ps.filter((p) => p.price);
          const withMin = ps.filter((p) => p.minOdds);
          return {
            settled: ps.length,
            won: won.length,
            hitRate: ps.length ? r3(won.length / ps.length) : null,
            expectedHitRate: ps.length ? r3(ps.reduce((a, p) => a + p.prob, 0) / ps.length) : null,
            profitAtPinnacle: r2(withPrice.reduce((a, p) => a + (p.status === "won" ? (p.price as number) - 1 : -1), 0)),
            profitAtMinSportyBet: r2(withMin.reduce((a, p) => a + (p.status === "won" ? (p.minOdds as number) - 1 : -1), 0)),
          };
        };
        // slips: picks flagged slip=true, grouped by date
        const byDate = new Map<string, Pick[]>();
        for (const p of all.filter((x) => x.slip)) byDate.set(p.date, [...(byDate.get(p.date) ?? []), p]);
        const slips = [...byDate.entries()].map(([date, legs]) => ({
          date,
          legs: legs.map((l) => `${l.label} (${l.home} v ${l.away}): ${l.status}`),
          result: legs.some((l) => l.status === "lost") ? "lost" : legs.every((l) => l.status === "won" || l.status === "void") ? "won" : "open",
        }));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              overall: sum(done),
              football: sum(done.filter((p) => p.sport === "football")),
              basketball: sum(done.filter((p) => p.sport === "basketball")),
              open: all.filter((p) => p.status === "open").length,
              slips: slips.slice(-14),
              note: "Profit is per 1-unit stake on each pick. A hit rate close to expectedHitRate means our probabilities are honest; profit only matters over 100+ picks.",
            }),
          }],
        };
      }
    );
  }
}
