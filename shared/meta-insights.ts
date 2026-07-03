// AttributionOS (T16) — pure request builders + response parsers for the Meta
// Marketing (Insights) API. NO network, NO node builtins — the ad-spend cron
// (server/ad-spend-cron.ts) does the fetching and the DB upserts; this module
// only shapes the requests and parses the JSON so it is fully unit-testable with
// no live call (see script/test-attribution-meta.ts).
//
// Money rule: Meta returns `spend` as a decimal-DOLLAR string ("12.34"); every
// row is stored as integer CENTS in ad_spend_daily.spend_cents. Breakdown fields
// (publisher_platform / platform_position) default to '' so they mirror the
// schema defaults and never make the (date, ad_id, platform, position) unique
// key NULL.

export const META_GRAPH_BASE = "https://graph.facebook.com";

/** Fields we ask Insights for at level=ad. */
export const INSIGHTS_FIELDS = [
  "ad_id",
  "adset_id",
  "campaign_id",
  "ad_name",
  "adset_name",
  "campaign_name",
  "spend",
  "impressions",
  "clicks",
] as const;

// ── account ids ──────────────────────────────────────────────────────────────

/**
 * Normalise an ad-account id to Meta's canonical `act_<digits>` form. Accepts a
 * bare numeric id ("123") or an already-prefixed one ("act_123"), tolerating
 * surrounding whitespace. Returns null if the input holds no digits.
 */
export function normalizeAdAccountId(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const digits = s.replace(/^act_/i, "").trim();
  if (!/^\d+$/.test(digits)) return null;
  return `act_${digits}`;
}

/**
 * Parse a comma / space / newline / semicolon-separated list of account ids into
 * deduped, normalised `act_<digits>` ids (invalid entries dropped, order kept).
 */
export function parseAdAccountIds(raw: unknown): string[] {
  if (raw == null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(raw).split(/[\s,;]+/)) {
    const id = normalizeAdAccountId(part);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// ── numeric coercion ─────────────────────────────────────────────────────────

/** Meta decimal-dollar spend → integer cents. Defensive against null / NaN / commas. */
export function dollarsToCents(spend: unknown): number {
  if (spend == null) return 0;
  const n = Number(String(spend).replace(/,/g, "").trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Coerce a Meta integer-ish field ("1000", 1000, null) to a non-negative int. */
export function toInt(value: unknown): number {
  if (value == null) return 0;
  const n = parseInt(String(value).replace(/,/g, "").trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// ── date window (NZ-local, deterministic given `now`) ────────────────────────

/** YYYY-MM-DD for a Date in the given IANA timezone (default Pacific/Auckland). */
export function nzDateString(d: Date, timeZone = "Pacific/Auckland"): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Trailing window of `days` NZ-local days ending today (inclusive) — the
 * re-upsert range. `days=7` ⇒ since = today-6, until = today.
 */
export function trailingWindow(now: Date, days = 7, timeZone = "Pacific/Auckland"): { since: string; until: string } {
  const until = nzDateString(now, timeZone);
  const back = new Date(now.getTime() - Math.max(0, days - 1) * 24 * 60 * 60 * 1000);
  const since = nzDateString(back, timeZone);
  return { since, until };
}

// ── URL builders (token appended by the caller) ──────────────────────────────

/**
 * Build the Insights request URL for one account + date range, WITHOUT the
 * access_token (the cron appends it, keeping this pure/testable). level=ad,
 * per-day rows, split by publisher_platform × platform_position.
 */
export function buildInsightsUrl(
  accountId: string,
  opts: { since: string; until: string; apiVersion: string; limit?: number },
): string {
  const fields = INSIGHTS_FIELDS.join(",");
  const timeRange = encodeURIComponent(JSON.stringify({ since: opts.since, until: opts.until }));
  const limit = opts.limit ?? 500;
  return (
    `${META_GRAPH_BASE}/${opts.apiVersion}/${accountId}/insights` +
    `?level=ad&fields=${fields}` +
    `&breakdowns=publisher_platform,platform_position` +
    `&time_increment=1&time_range=${timeRange}&limit=${limit}`
  );
}

/**
 * Build the ad-entity node URL `/{ad-id}?fields=name,adset{name,campaign{name}}`
 * WITHOUT the access_token. Used to refresh names for ad ids seen in conversions
 * but not in the spend pull.
 */
export function buildAdEntityUrl(adId: string, opts: { apiVersion: string }): string {
  const fields = encodeURIComponent("name,adset{name,campaign{name}}");
  return `${META_GRAPH_BASE}/${opts.apiVersion}/${encodeURIComponent(adId)}?fields=${fields}`;
}

// ── response parsers ─────────────────────────────────────────────────────────

export interface ParsedAdSpendRow {
  date: string;
  adId: string;
  adsetId: string | null;
  campaignId: string | null;
  publisherPlatform: string;
  platformPosition: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  adName: string | null;
  adsetName: string | null;
  campaignName: string | null;
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Parse ONE page of an Insights response into normalised spend rows. Rows with
 * no `ad_id` or no `date_start` are skipped (can't key them). Missing breakdown
 * fields default to '' to match the schema + unique key.
 */
export function parseInsightsPage(json: unknown): ParsedAdSpendRow[] {
  const data = (json as any)?.data;
  if (!Array.isArray(data)) return [];
  const rows: ParsedAdSpendRow[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const adId = strOrNull((r as any).ad_id);
    const date = strOrNull((r as any).date_start);
    if (!adId || !date) continue;
    rows.push({
      date,
      adId,
      adsetId: strOrNull((r as any).adset_id),
      campaignId: strOrNull((r as any).campaign_id),
      publisherPlatform: strOrNull((r as any).publisher_platform) ?? "",
      platformPosition: strOrNull((r as any).platform_position) ?? "",
      spendCents: dollarsToCents((r as any).spend),
      impressions: toInt((r as any).impressions),
      clicks: toInt((r as any).clicks),
      adName: strOrNull((r as any).ad_name),
      adsetName: strOrNull((r as any).adset_name),
      campaignName: strOrNull((r as any).campaign_name),
    });
  }
  return rows;
}

/** Next-page cursor URL from an Insights response (already carries the token), or null. */
export function insightsNextPage(json: unknown): string | null {
  const next = (json as any)?.paging?.next;
  return typeof next === "string" && next ? next : null;
}

export interface ParsedAdEntity {
  adId: string;
  adsetId: string | null;
  campaignId: string | null;
  adName: string | null;
  adsetName: string | null;
  campaignName: string | null;
}

/**
 * Parse a `/{ad-id}?fields=name,adset{name,campaign{name}}` node response into an
 * ad_entities row. `fallbackAdId` is the id we requested (used when the response
 * omits `id`). Returns null if neither yields an id.
 */
export function parseAdEntity(json: unknown, fallbackAdId?: string): ParsedAdEntity | null {
  const obj = (json as any) || {};
  const adId = strOrNull(obj.id) ?? strOrNull(fallbackAdId);
  if (!adId) return null;
  const adset = obj.adset || {};
  const campaign = adset.campaign || {};
  return {
    adId,
    adsetId: strOrNull(adset.id),
    campaignId: strOrNull(campaign.id),
    adName: strOrNull(obj.name),
    adsetName: strOrNull(adset.name),
    campaignName: strOrNull(campaign.name),
  };
}

/**
 * Collapse spend rows to one ad_entities row per ad id (names come free on the
 * Insights response, so ads that had spend never need a second node fetch).
 */
export function adEntitiesFromSpend(rows: ParsedAdSpendRow[]): ParsedAdEntity[] {
  const byId = new Map<string, ParsedAdEntity>();
  for (const r of rows) {
    if (!r.adId) continue;
    const prev = byId.get(r.adId);
    // Keep the first non-null names we see (rows for the same ad repeat them).
    byId.set(r.adId, {
      adId: r.adId,
      adsetId: r.adsetId ?? prev?.adsetId ?? null,
      campaignId: r.campaignId ?? prev?.campaignId ?? null,
      adName: prev?.adName ?? r.adName ?? null,
      adsetName: prev?.adsetName ?? r.adsetName ?? null,
      campaignName: prev?.campaignName ?? r.campaignName ?? null,
    });
  }
  return [...byId.values()];
}
