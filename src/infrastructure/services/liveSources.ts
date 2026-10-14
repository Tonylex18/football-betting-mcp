import fetch from "node-fetch";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";

/**
 * Current-season data sources that work on free plans:
 *  - football-data.org  (fixtures, results, standings; header X-Auth-Token)
 *  - OddsPapi           (bookmaker odds; apiKey query parameter)
 *
 * Both are cached on disk with a TTL so re-running the daily slate does not
 * burn the monthly quota (OddsPapi free = 250 requests/month).
 */

const CACHE_DIR = nodePath.join(os.homedir(), ".mcp-football-cache", "live");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cacheFile(key: string) {
  return nodePath.join(CACHE_DIR, createHash("sha1").update(key).digest("hex") + ".json");
}

function readCache(key: string, ttlMs: number): any | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(key), "utf8"));
    if (Date.now() - raw.at < ttlMs) return raw.data;
  } catch {
    /* miss */
  }
  return undefined;
}

function writeCache(key: string, data: any) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(key), JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* best effort */
  }
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ */
/* football-data.org                                                   */
/* ------------------------------------------------------------------ */

export class FootballDataService {
  private base = "https://api.football-data.org/v4";
  private key = process.env.FOOTBALL_DATA_KEY ?? "";

  get configured() {
    return this.key.length > 0;
  }

  private async get(path: string, ttlMs: number): Promise<any> {
    if (!this.configured) {
      throw new Error("FOOTBALL_DATA_KEY is not set in the Claude Desktop config.");
    }
    const url = this.base + path;
    const cached = readCache("fd:" + path, ttlMs);
    if (cached) return cached;

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { "X-Auth-Token": this.key } });
      if (res.status === 429 && attempt < 3) {
        await sleep(12000); // free plan: 10 requests/minute
        continue;
      }
      if (!res.ok) {
        throw new Error(`football-data.org error ${res.status}: ${await res.text()}`);
      }
      const data = await res.json();
      writeCache("fd:" + path, data);
      return data;
    }
  }

  /** All matches of the current season for a competition (finished + scheduled). */
  seasonMatches(code: string) {
    return this.get(`/competitions/${code}/matches`, 30 * MIN);
  }

  standings(code: string) {
    return this.get(`/competitions/${code}/standings`, 30 * MIN);
  }
}

/* ------------------------------------------------------------------ */
/* OddsPapi                                                            */
/* ------------------------------------------------------------------ */

export const SOCCER_SPORT_ID = 10;
export const BASKETBALL_SPORT_ID = 11;

export class OddsPapiService {
  private base = "https://api.oddspapi.io/v4";
  private key = process.env.ODDSPAPI_KEY ?? "";
  private lastCall = 0;

  get configured() {
    return this.key.length > 0;
  }

  get defaultBookmakers(): string {
    return process.env.ODDSPAPI_BOOKMAKERS ?? "pinnacle";
  }

  private async get(path: string, params: Record<string, string | number>, ttlMs: number): Promise<any> {
    if (!this.configured) {
      throw new Error("ODDSPAPI_KEY is not set in the Claude Desktop config.");
    }
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const cacheKey = "op:" + path + "?" + qs.toString();
    const cached = readCache(cacheKey, ttlMs);
    if (cached) return cached;

    qs.set("apiKey", this.key);
    const url = `${this.base}${path}?${qs.toString()}`;

    for (let attempt = 0; ; attempt++) {
      // Respect endpoint cooldowns (1-2 s).
      const wait = this.lastCall + 2100 - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();

      const res = await fetch(url);
      if (res.status === 429 && attempt < 2) {
        await sleep(3000);
        continue;
      }
      if (!res.ok) {
        throw new Error(`OddsPapi error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = await res.json();
      writeCache(cacheKey, data);
      return data;
    }
  }

  bookmakers() {
    return this.get("/bookmakers", {}, 7 * DAY);
  }

  tournaments(sportId: number = SOCCER_SPORT_ID) {
    return this.get("/tournaments", { sportId }, 7 * DAY);
  }

  markets() {
    return this.get("/markets", {}, 7 * DAY);
  }

  /** Soccer fixtures in a window (must be < 10 days). */
  fixtures(fromIso: string, toIso: string, sportId: number = SOCCER_SPORT_ID) {
    return this.get(
      "/fixtures",
      { sportId, from: fromIso, to: toIso, hasOdds: "true" },
      2 * HOUR
    );
  }

  /** One bookmaker per request (free plan requires exactly one). */
  oddsByTournaments(tournamentIds: number[], bookmaker: string) {
    return this.get(
      "/odds-by-tournaments",
      { tournamentIds: tournamentIds.join(","), bookmaker, language: "en" },
      30 * MIN
    );
  }
}

/* ------------------------------------------------------------------ */
/* balldontlie (NBA results + schedule; free tier 5 requests/minute)   */
/* ------------------------------------------------------------------ */

const STATE_DIR = nodePath.join(os.homedir(), ".mcp-football-cache", "nba");

function readState(name: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(nodePath.join(STATE_DIR, name), "utf8"));
  } catch {
    return undefined;
  }
}
function writeState(name: string, data: any) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(nodePath.join(STATE_DIR, name), JSON.stringify(data));
  } catch {
    /* best effort */
  }
}

export class BallDontLieService {
  private base = "https://api.balldontlie.io/v1";
  private key = process.env.BALLDONTLIE_KEY ?? "";
  private lastCall = 0;

  get configured() {
    return this.key.length > 0;
  }

  private async page(params: Record<string, string>): Promise<any> {
    if (!this.configured) throw new Error("BALLDONTLIE_KEY is not set in the Claude Desktop config.");
    const qs = new URLSearchParams(params);
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCall + 12500 - Date.now(); // free tier: 5/min
      if (wait > 0 && this.lastCall > 0) await sleep(wait);
      this.lastCall = Date.now();
      const res = await fetch(`${this.base}/games?${qs.toString()}`, { headers: { Authorization: this.key } });
      if (res.status === 429 && attempt < 2) { await sleep(15000); continue; }
      if (!res.ok) throw new Error(`balldontlie error ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    }
  }

  /**
   * Last season's regular-season games, downloaded once in chunks (rate limit)
   * and stored permanently. Returns {games, complete}.
   */
  async priorSeason(season: number, maxPages = 3): Promise<{ games: any[]; complete: boolean }> {
    const file = `season-${season}.json`;
    const st = readState(file) ?? { games: [], cursor: null, complete: false };
    let pages = 0;
    while (!st.complete && pages < maxPages) {
      const params: Record<string, string> = { "seasons[]": String(season), per_page: "100", season_type: "regular" };
      if (st.cursor) params.cursor = String(st.cursor);
      const data = await this.page(params);
      st.games.push(...(data.data ?? []));
      st.cursor = data.meta?.next_cursor ?? null;
      if (!st.cursor) st.complete = true;
      pages++;
      writeState(file, st);
    }
    return { games: st.games, complete: st.complete };
  }

  /** Current season games from a start date through endDate (finished + scheduled). */
  async range(startDate: string, endDate: string, maxPages = 3): Promise<any[]> {
    const out: any[] = [];
    let cursor: any = null;
    let pages = 0;
    do {
      const params: Record<string, string> = { start_date: startDate, end_date: endDate, per_page: "100" };
      if (cursor) params.cursor = String(cursor);
      const data = await this.page(params);
      out.push(...(data.data ?? []));
      cursor = data.meta?.next_cursor ?? null;
      pages++;
    } while (cursor && pages < maxPages);
    return out;
  }

  /** Current-season finished games kept on disk; only new dates are fetched each run. */
  async currentSeason(season: number, seasonStart: string, windowEnd: string) {
    const file = `current-${season}.json`;
    const st = readState(file) ?? { games: {}, lastFinalDate: null };
    const from = st.lastFinalDate
      ? new Date(Date.parse(st.lastFinalDate) - 2 * DAY).toISOString().slice(0, 10)
      : seasonStart;
    const fetched = await this.range(from, windowEnd, 4);
    for (const g of fetched) st.games[String(g.id)] = g;
    const finals = Object.values<any>(st.games).filter((g) => String(g.status) === "Final");
    if (finals.length) st.lastFinalDate = finals.map((g) => String(g.date).slice(0, 10)).sort().slice(-1)[0];
    writeState(file, st);
    return Object.values<any>(st.games);
  }
}
