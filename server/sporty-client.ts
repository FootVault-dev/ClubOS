// Sporty Football API client — auth, pacing, retries. Implements the contract
// in outputs/sporty-api-brief/sporty-football-api-swagger-2026-07-21.json:
//  · POST /api/token?apikey=… (form-urlencoded username/password/grant_type)
//    → JWT valid 24h. Every other call carries BOTH the Bearer token and the
//    static apikey (query param).
//  · Rate limit 2 req/s per method. We pace harder than required (1 req/700ms)
//    because their Best Practices ask for spacing, and a nightly sync has no
//    reason to sprint. 429 → exponential backoff, then give up loudly.
//  · A 400 from RegisterPerson is a BUSINESS outcome (possibly carrying the
//    SportyId we are required to save) — returned as a value, never thrown.
//    401/429-exhausted/5xx-exhausted are transport failures — thrown.
//
// Config is env-only (no OAuth dance — NZF issues static credentials):
//   SPORTY_BASE_URL   defaults to UAT. Production (www.sporty.co.nz) must be
//                     set EXPLICITLY — a missing env var can never point at live.
//   SPORTY_API_KEY / SPORTY_API_USERNAME / SPORTY_API_PASSWORD

import type {
  SportyCountry,
  SportyEthnicityGroup,
  SportyRegisterPersonRequest,
  SportyRegistrationResponse,
} from "@shared/sporty";

export interface SportyConfig {
  baseUrl: string;
  apiKey: string;
  username: string;
  password: string;
}

export const SPORTY_UAT_BASE = "https://uat.sporty.co.nz";

export function readSportyConfig(): SportyConfig | null {
  const apiKey = (process.env.SPORTY_API_KEY || "").trim();
  const username = (process.env.SPORTY_API_USERNAME || "").trim();
  const password = (process.env.SPORTY_API_PASSWORD || "").trim();
  if (!apiKey || !username || !password) return null;
  const baseUrl = (process.env.SPORTY_BASE_URL || SPORTY_UAT_BASE).trim().replace(/\/+$/, "");
  return { baseUrl, apiKey, username, password };
}

/** Transport-level failure (auth, rate-limit exhausted, 5xx exhausted, network). */
export class SportyTransportError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "SportyTransportError";
  }
}

export type RegisterPersonResult =
  | { ok: true; status: 200; data: SportyRegistrationResponse }
  | { ok: false; status: number; message: string; sportyId: number | null; body: unknown };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SportyClient {
  private token: string | null = null;
  private tokenExpiresAt = 0; // epoch ms
  private tokenPromise: Promise<string> | null = null;
  private lastRequestAt = 0;
  /** Their limit is 2/s; we self-impose ~1.4/s. */
  private readonly minIntervalMs: number;

  constructor(
    private readonly cfg: SportyConfig,
    opts?: { minIntervalMs?: number },
  ) {
    this.minIntervalMs = opts?.minIntervalMs ?? 700;
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  private paceChain: Promise<void> = Promise.resolve();

  /** Serialize slot acquisition across concurrent callers, then enforce the
   *  minimum spacing — so N parallel requests launch minIntervalMs apart
   *  instead of thundering into their 2/s limit together. */
  private async pace(): Promise<void> {
    const prev = this.paceChain;
    let release!: () => void;
    this.paceChain = new Promise<void>((r) => (release = r));
    await prev;
    try {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
    } finally {
      release();
    }
  }

  /** Backoff with jitter — identical retry delays re-collide forever. */
  private static backoffMs(base: number): number {
    return base + Math.floor(Math.random() * 500);
  }

  /** Single-flight token fetch; refreshes 5 minutes before the 24h expiry. */
  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchToken().finally(() => {
        this.tokenPromise = null;
      });
    }
    return this.tokenPromise;
  }

  private async fetchToken(): Promise<string> {
    const url = `${this.cfg.baseUrl}/api/token?apikey=${encodeURIComponent(this.cfg.apiKey)}`;
    const body = new URLSearchParams({
      grant_type: "password",
      username: this.cfg.username,
      password: this.cfg.password,
    });
    // The token endpoint shares their 2/s POST limit — a 429 here means "slow
    // down", never "bad credentials". Only a 401 blames the keys.
    const backoffs = [1500, 3000, 6000];
    let res: Response;
    for (;;) {
      await this.pace();
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
      } catch (e: any) {
        throw new SportyTransportError(`Sporty token request failed: ${e?.message || e}`, null);
      }
      if (res.status === 429) {
        const backoff = backoffs.shift();
        if (backoff !== undefined) {
          await sleep(SportyClient.backoffMs(backoff));
          continue;
        }
        throw new SportyTransportError("Sporty token endpoint rate limit (429) persisted through backoff", 429);
      }
      break;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const hint = res.status === 401 ? " — check SPORTY_API_KEY / username / password" : "";
      throw new SportyTransportError(`Sporty token request rejected (HTTP ${res.status})${hint}`, res.status, text);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new SportyTransportError("Sporty token response had no access_token", res.status, json);
    this.token = json.access_token;
    const ttlSeconds = typeof json.expires_in === "number" && json.expires_in > 600 ? json.expires_in : 86399;
    this.tokenExpiresAt = Date.now() + (ttlSeconds - 300) * 1000;
    return this.token;
  }

  /**
   * One HTTP call with pacing, one 401-refresh retry, 429 backoff (1.5s/3s/6s)
   * and a single 5xx retry. Returns status + parsed JSON; never throws on 400.
   */
  private async request(
    method: "GET" | "POST",
    path: string,
    jsonBody?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const backoffs = [1500, 3000, 6000];
    // 401 handling has to survive two real-world interleavings: (a) a parallel
    // request already replaced the token we used — retrying with the current
    // one is free; (b) a 429 backoff delayed our retry past a token expiry.
    // Genuinely bad credentials never reach this budget — they throw from
    // /api/token itself — so the budget only guards the pathological case of
    // tokens that are issued but rejected, and four tries is plenty.
    let authRefreshes = 0;
    let serverRetried = false;
    for (;;) {
      const token = await this.getToken();
      await this.pace();
      const sep = path.includes("?") ? "&" : "?";
      const url = `${this.cfg.baseUrl}${path}${sep}apikey=${encodeURIComponent(this.cfg.apiKey)}`;
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
        });
      } catch (e: any) {
        if (!serverRetried) {
          serverRetried = true;
          await sleep(2000);
          continue;
        }
        throw new SportyTransportError(`Sporty request failed: ${e?.message || e}`, null);
      }

      if (res.status === 401) {
        if (this.token && this.token !== token) continue; // someone else refreshed — reuse theirs
        if (authRefreshes < 4) {
          authRefreshes += 1;
          await this.getToken(true);
          continue;
        }
        // fall through: a persistent 401 is returned to the caller below
      }
      if (res.status === 429) {
        const backoff = backoffs.shift();
        if (backoff !== undefined) {
          await sleep(SportyClient.backoffMs(backoff));
          continue;
        }
        throw new SportyTransportError("Sporty rate limit (429) persisted through backoff — try again later", 429);
      }
      if (res.status >= 500 && !serverRetried) {
        serverRetried = true;
        await sleep(2000);
        continue;
      }

      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          /* leave as text */
        }
      }
      return { status: res.status, body: parsed };
    }
  }

  async registerPerson(payload: SportyRegisterPersonRequest): Promise<RegisterPersonResult> {
    const { status, body } = await this.request("POST", "/api/v1/football/RegisterPerson", payload);
    if (status === 200) {
      return { ok: true, status: 200, data: body as SportyRegistrationResponse };
    }
    if (status === 401) throw new SportyTransportError("Sporty auth failed even after token refresh", 401, body);
    const err = (body ?? {}) as { Message?: string; SportyId?: number };
    return {
      ok: false,
      status,
      message: typeof err.Message === "string" ? err.Message : `HTTP ${status}`,
      sportyId: typeof err.SportyId === "number" ? err.SportyId : null,
      body,
    };
  }

  private async getJson<T>(path: string, what: string): Promise<T> {
    const { status, body } = await this.request("GET", path);
    if (status !== 200) throw new SportyTransportError(`Sporty ${what} returned HTTP ${status}`, status, body);
    return body as T;
  }

  async getCountries(): Promise<SportyCountry[]> {
    return this.getJson<SportyCountry[]>("/api/v1/football/country/GetCountries", "GetCountries");
  }

  async getGenders(): Promise<string[]> {
    return this.getJson<string[]>("/api/v1/football/gender/GetGenders", "GetGenders");
  }

  async getEthnicityGroups(): Promise<SportyEthnicityGroup[]> {
    return this.getJson<SportyEthnicityGroup[]>("/api/v1/football/ethnicity/GetEthnicityGroups", "GetEthnicityGroups");
  }

  async getFantailFormOptions(): Promise<unknown> {
    return this.getJson<unknown>("/api/v1/football/fantail/GetFormOptions", "fantail GetFormOptions");
  }

  /** Token + one cheap reference call — proves key, credentials and reachability. */
  async testConnection(): Promise<{ ok: true; genders: string[] } | { ok: false; error: string }> {
    try {
      await this.getToken(true);
      const genders = await this.getGenders();
      return { ok: true, genders };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
}
