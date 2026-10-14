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

  tournaments() {
    return this.get("/tournaments", { sportId: SOCCER_SPORT_ID }, 7 * DAY);
  }

  markets() {
    return this.get("/markets", {}, 7 * DAY);
  }

  /** Soccer fixtures in a window (must be < 10 days). */
  fixtures(fromIso: string, toIso: string) {
    return this.get(
      "/fixtures",
      { sportId: SOCCER_SPORT_ID, from: fromIso, to: toIso, hasOdds: "true" },
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
