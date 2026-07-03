/**
 * AttributionOS — attribution query layer (T18).
 *
 * Fetches conversions (8 tables), the touch log (analytics_events), and ad spend
 * from Postgres, then feeds them through the pure model helpers in
 * `shared/attribution-models.ts` to produce revenue-by-channel/campaign/ad,
 * CAC/ROAS, person journeys, and the reconciliation dataset. Org-scoped, with an
 * org-array signature so the master workspace can roll several orgs up at once.
 *
 * All heavy attribution logic is pure + tested in `script/test-attribution-reports.ts`;
 * this module is the (untestable-in-loop) DB glue. Read-only — never writes.
 */

import { sql } from "drizzle-orm";
import { db } from "./db";
import { mapHdyhauToChannel } from "@shared/attribution";
import { nzDateString } from "@shared/meta-insights";
import {
  ATTRIBUTION_MODELS,
  DEFAULT_WINDOW_DAYS,
  attachSpendMetrics,
  buildReconciliation,
  coerceAttributionModel,
  computeCac,
  computeRoas,
  rollupAdPlatformSplit,
  rollupConversions,
  tagNewVsReturning,
  type AttributionModel,
  type ConversionRecord,
  type RollupRow,
  type SpendMetrics,
  type Touch,
} from "@shared/attribution-models";

const DAY_MS = 86_400_000;
const PAID_CHANNELS = new Set(["facebook", "instagram", "google", "meta_unattributed"]);

export interface ReportParams {
  orgIds: number[];
  model?: AttributionModel | string;
  windowDays?: number;
  /** Conversion date range (epoch ms). Defaults to the trailing 90 days. */
  startMs?: number | null;
  endMs?: number | null;
  filter?: "all" | "new" | "returning";
}

interface ResolvedRange {
  startMs: number;
  endMs: number;
  windowDays: number;
  model: AttributionModel;
  filter: "all" | "new" | "returning";
}

function resolveParams(p: ReportParams): ResolvedRange {
  const endMs = p.endMs ?? Date.now();
  const startMs = p.startMs ?? endMs - 90 * DAY_MS;
  const windowDays =
    p.windowDays && p.windowDays > 0 ? Math.min(p.windowDays, 365) : DEFAULT_WINDOW_DAYS;
  const filter = p.filter === "new" || p.filter === "returning" ? p.filter : "all";
  return { startMs, endMs, windowDays, model: coerceAttributionModel(p.model), filter };
}

// ── Raw fetchers ─────────────────────────────────────────────────────────────

interface ConvRow extends ConversionRecord {
  personId: number | null;
  visitorId: string | null;
}

/**
 * Union the 8 conversion/lead tables into one normalised set. Optionally scoped to
 * a single person (for journeys) and/or a date range. Sales carry revenue; leads are
 * revenue-0. `registrations` (confirmed) + `cugc_registrations` (paid) + `print_orders`
 * (paid_cents>0) are sales; everything else — and unpaid print enquiries — are leads.
 */
async function fetchConversions(opts: {
  orgIds: number[];
  startMs?: number | null;
  endMs?: number | null;
  personId?: number;
}): Promise<ConvRow[]> {
  const { orgIds } = opts;
  if (!orgIds.length) return [];
  const startIso = opts.startMs != null ? new Date(opts.startMs).toISOString() : null;
  const endIso = opts.endMs != null ? new Date(opts.endMs).toISOString() : null;
  const person = opts.personId ?? null;

  // Shared range/person predicate, applied per sub-select with its own timestamp col.
  const rangeSql = (tsCol: string) =>
    sql`${sql.raw(tsCol)} >= COALESCE(${startIso}::timestamptz, ${sql.raw(tsCol)}) AND ${sql.raw(
      tsCol,
    )} < COALESCE(${endIso}::timestamptz, ${sql.raw(tsCol)} + interval '1 second')`;
  const personSql = (col: string) =>
    person != null ? sql`AND ${sql.raw(col)} = ${person}` : sql``;

  const res = await db.execute(sql`
    SELECT source, id, EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms, revenue_cents, is_lead,
           person_id, visitor_id, click_id, meta_ad_id, meta_adset_id, meta_campaign_id,
           meta_platform, attribution_channel, hdyhau
    FROM (
      SELECT 'registration'::text AS source, r.id AS id, r.registered_at AS ts,
        COALESCE(r.total_cents, 0) AS revenue_cents, false AS is_lead,
        r.person_id, r.visitor_id, r.click_id, r.meta_ad_id, r.meta_adset_id,
        r.meta_campaign_id, r.meta_platform, r.attribution_channel, r.referral_source AS hdyhau
      FROM registrations r JOIN programs p ON p.id = r.program_id
      WHERE p.organization_id = ANY(${orgIds}) AND r.status = 'confirmed'
        AND ${rangeSql("r.registered_at")} ${personSql("r.person_id")}

      UNION ALL
      SELECT 'cugc_registration', c.id, c.created_at, COALESCE(c.price_cents, 0), false,
        c.person_id, c.visitor_id, c.click_id, c.meta_ad_id, c.meta_adset_id,
        c.meta_campaign_id, c.meta_platform, c.attribution_channel, c.heard_via
      FROM cugc_registrations c
      WHERE c.organization_id = ANY(${orgIds}) AND c.status = 'paid'
        AND ${rangeSql("c.created_at")} ${personSql("c.person_id")}

      UNION ALL
      SELECT 'print_order', po.id, po.created_at, COALESCE(po.paid_cents, 0),
        (COALESCE(po.paid_cents, 0) = 0),
        po.person_id, po.visitor_id, po.click_id, po.meta_ad_id, po.meta_adset_id,
        po.meta_campaign_id, po.meta_platform, po.attribution_channel, po.hdyhau
      FROM print_orders po
      WHERE po.organization_id = ANY(${orgIds})
        AND ${rangeSql("po.created_at")} ${personSql("po.person_id")}

      UNION ALL
      SELECT 'cugc_free_session', f.id, f.created_at, 0, true,
        f.person_id, f.visitor_id, f.click_id, f.meta_ad_id, f.meta_adset_id,
        f.meta_campaign_id, f.meta_platform, f.attribution_channel, f.hdyhau
      FROM cugc_free_sessions f
      WHERE f.organization_id = ANY(${orgIds})
        AND ${rangeSql("f.created_at")} ${personSql("f.person_id")}

      UNION ALL
      SELECT 'league_waitlist', w.id, w.created_at, 0, true,
        w.person_id, w.visitor_id, w.click_id, w.meta_ad_id, w.meta_adset_id,
        w.meta_campaign_id, w.meta_platform, w.attribution_channel, w.hdyhau
      FROM league_waitlist w
      WHERE w.organization_id = ANY(${orgIds})
        AND ${rangeSql("w.created_at")} ${personSql("w.person_id")}

      UNION ALL
      SELECT 'cic7s_registration', x.id, x.created_at, 0, true,
        x.person_id, x.visitor_id, x.click_id, x.meta_ad_id, x.meta_adset_id,
        x.meta_campaign_id, x.meta_platform, x.attribution_channel, x.hdyhau
      FROM cic7s_registrations x
      WHERE x.organization_id = ANY(${orgIds})
        AND ${rangeSql("x.created_at")} ${personSql("x.person_id")}

      UNION ALL
      SELECT 'football_institute', fi.id, fi.created_at, 0, true,
        fi.person_id, fi.visitor_id, fi.click_id, fi.meta_ad_id, fi.meta_adset_id,
        fi.meta_campaign_id, fi.meta_platform, fi.attribution_channel, fi.hdyhau
      FROM football_institute_applications fi
      WHERE fi.organization_id = ANY(${orgIds})
        AND ${rangeSql("fi.created_at")} ${personSql("fi.person_id")}

      UNION ALL
      SELECT 'booking_request', b.id, b.created_at, 0, true,
        b.person_id, b.visitor_id, b.click_id, b.meta_ad_id, b.meta_adset_id,
        b.meta_campaign_id, b.meta_platform, b.attribution_channel, b.hdyhau
      FROM booking_requests b
      WHERE b.organization_id = ANY(${orgIds})
        AND ${rangeSql("b.created_at")} ${personSql("b.person_id")}
    ) u
    ORDER BY ts_ms ASC
  `);

  return (res.rows as any[]).map((r) => {
    const personId = r.person_id != null ? Number(r.person_id) : null;
    const visitorId = r.visitor_id != null ? String(r.visitor_id) : null;
    return {
      source: String(r.source),
      id: Number(r.id),
      key: personId != null ? `p:${personId}` : visitorId ? `v:${visitorId}` : null,
      timestamp: Number(r.ts_ms),
      revenueCents: Number(r.revenue_cents) || 0,
      isLead: r.is_lead === true || r.is_lead === "true",
      isNew: false, // filled by tagNewVsReturning
      personId,
      visitorId,
      stampedChannel: r.attribution_channel ?? null,
      stampedCampaign: null,
      stampedAdId: r.meta_ad_id ?? null,
      stampedAdsetId: r.meta_adset_id ?? null,
      stampedCampaignId: r.meta_campaign_id ?? null,
      stampedPlatform: r.meta_platform ?? null,
      hdyhau: r.hdyhau ?? null,
    } as ConvRow;
  });
}

/** Fetch the touch log for the given persons/visitors, back to `sinceMs`. */
async function fetchTouches(
  personIds: number[],
  visitorIds: string[],
  sinceMs: number,
): Promise<Map<string, Touch[]>> {
  const byKey = new Map<string, Touch[]>();
  if (!personIds.length && !visitorIds.length) return byKey;
  const sinceIso = new Date(sinceMs).toISOString();

  const res = await db.execute(sql`
    SELECT person_id, visitor_id, channel, channel_raw, utm_campaign,
           EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms
    FROM analytics_events
    WHERE is_bot = false
      AND event_type IN ('session_start', 'page_view')
      AND timestamp >= ${sinceIso}::timestamptz
      AND (person_id = ANY(${personIds}) OR visitor_id = ANY(${visitorIds}))
    ORDER BY timestamp ASC
  `);

  for (const r of res.rows as any[]) {
    const touch: Touch = {
      channel: r.channel ?? null,
      channelRaw: r.channel_raw ?? null,
      campaign: r.utm_campaign ?? null,
      timestamp: Number(r.ts_ms),
    };
    const pid = r.person_id != null ? Number(r.person_id) : null;
    const vid = r.visitor_id != null ? String(r.visitor_id) : null;
    if (pid != null) {
      const k = `p:${pid}`;
      (byKey.get(k) || byKey.set(k, []).get(k)!).push(touch);
    }
    if (vid) {
      const k = `v:${vid}`;
      (byKey.get(k) || byKey.set(k, []).get(k)!).push(touch);
    }
  }
  return byKey;
}

interface Dataset {
  conversions: ConversionRecord[];
  touchesByKey: Map<string, Touch[]>;
  range: ResolvedRange;
}

/** Load conversions + their touch log once; report builders transform this in memory. */
async function loadDataset(params: ReportParams): Promise<Dataset> {
  const range = resolveParams(params);
  const raw = await fetchConversions({
    orgIds: params.orgIds,
    startMs: range.startMs,
    endMs: range.endMs,
  });
  const conversions = tagNewVsReturning(raw) as (ConvRow & { isNew: boolean })[];

  const personIds = Array.from(
    new Set(conversions.map((c) => c.personId).filter((x): x is number => x != null)),
  );
  const visitorIds = Array.from(
    new Set(conversions.map((c) => c.visitorId).filter((x): x is string => !!x)),
  );
  const touchesByKey = await fetchTouches(
    personIds,
    visitorIds,
    range.startMs - range.windowDays * DAY_MS,
  );
  return { conversions, touchesByKey, range };
}

// ── Spend fetchers ───────────────────────────────────────────────────────────

/** Meta spend grouped into channel buckets (facebook/instagram/other). Global — no org. */
async function fetchSpendByChannel(startMs: number, endMs: number): Promise<Map<string, SpendMetrics>> {
  const startDate = nzDateString(new Date(startMs));
  const endDate = nzDateString(new Date(endMs));
  const res = await db.execute(sql`
    SELECT publisher_platform,
           SUM(spend_cents)::bigint AS spend_cents,
           SUM(impressions)::bigint AS impressions,
           SUM(clicks)::bigint AS clicks
    FROM ad_spend_daily
    WHERE date >= ${startDate} AND date <= ${endDate}
    GROUP BY publisher_platform
  `);
  const byChannel = new Map<string, SpendMetrics>();
  for (const r of res.rows as any[]) {
    const raw = String(r.publisher_platform || "").toLowerCase();
    const channel = raw.includes("instagram")
      ? "instagram"
      : raw.includes("facebook")
        ? "facebook"
        : "other";
    const prev = byChannel.get(channel) || { spendCents: 0, impressions: 0, clicks: 0 };
    prev.spendCents += Number(r.spend_cents) || 0;
    prev.impressions += Number(r.impressions) || 0;
    prev.clicks += Number(r.clicks) || 0;
    byChannel.set(channel, prev);
  }
  return byChannel;
}

/** Meta spend grouped by ad id, plus ad display names. */
async function fetchSpendByAd(
  startMs: number,
  endMs: number,
): Promise<{ spend: Map<string, SpendMetrics>; names: Map<string, string> }> {
  const startDate = nzDateString(new Date(startMs));
  const endDate = nzDateString(new Date(endMs));
  const spendRes = await db.execute(sql`
    SELECT ad_id,
           SUM(spend_cents)::bigint AS spend_cents,
           SUM(impressions)::bigint AS impressions,
           SUM(clicks)::bigint AS clicks
    FROM ad_spend_daily
    WHERE date >= ${startDate} AND date <= ${endDate}
    GROUP BY ad_id
  `);
  const spend = new Map<string, SpendMetrics>();
  for (const r of spendRes.rows as any[]) {
    if (!r.ad_id) continue;
    spend.set(String(r.ad_id), {
      spendCents: Number(r.spend_cents) || 0,
      impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0,
    });
  }
  const nameRes = await db.execute(sql`
    SELECT ad_id, ad_name, adset_name, campaign_name FROM ad_entities
  `);
  const names = new Map<string, string>();
  for (const r of nameRes.rows as any[]) {
    if (r.ad_id && r.ad_name) names.set(String(r.ad_id), String(r.ad_name));
  }
  return { spend, names };
}

// ── Public report builders (T19 endpoints call these) ────────────────────────

function hdyhauCountsByChannel(conversions: ConversionRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of conversions) {
    if (!c.hdyhau) continue;
    const ch = mapHdyhauToChannel(c.hdyhau);
    m.set(ch, (m.get(ch) || 0) + 1);
  }
  return m;
}

function sumRevenue(rows: RollupRow[]): number {
  return rows.reduce((a, r) => a + r.revenueCents, 0);
}

/** Header stat cards + the channel table with CAC/ROAS. */
export async function attributionOverview(params: ReportParams) {
  const ds = await loadDataset(params);
  const channelRows = rollupConversions(ds.conversions, ds.touchesByKey, {
    model: ds.range.model,
    windowDays: ds.range.windowDays,
    dimension: "channel",
    filter: ds.range.filter,
  });
  const spendByChannel = await fetchSpendByChannel(ds.range.startMs, ds.range.endMs);
  const channels = attachSpendMetrics(channelRows, spendByChannel);

  const trackedRevenueCents = sumRevenue(channelRows);
  const totalConversions = channelRows.reduce((a, r) => a + r.conversions, 0);
  const totalSales = channelRows.reduce((a, r) => a + r.sales, 0);
  const totalLeads = channelRows.reduce((a, r) => a + r.leads, 0);
  const unattributed = channelRows.find((r) => r.key === "unattributed");
  const pctUnattributed = totalConversions
    ? (unattributed?.conversions || 0) / totalConversions
    : 0;
  const topChannel = channelRows.find((r) => r.key !== "unattributed")?.key ?? null;

  let paidSpendCents = 0;
  for (const s of spendByChannel.values()) paidSpendCents += s.spendCents;
  const paidRevenueCents = channelRows
    .filter((r) => PAID_CHANNELS.has(r.key))
    .reduce((a, r) => a + r.revenueCents, 0);

  return {
    model: ds.range.model,
    windowDays: ds.range.windowDays,
    filter: ds.range.filter,
    range: { startMs: ds.range.startMs, endMs: ds.range.endMs },
    availableModels: ATTRIBUTION_MODELS,
    stats: {
      trackedRevenueCents,
      totalConversions,
      totalSales,
      totalLeads,
      topChannel,
      pctUnattributed,
      paidSpendCents,
      paidRevenueCents,
      paidRoas: computeRoas(paidRevenueCents, paidSpendCents),
      paidCacCents: computeCac(paidSpendCents, totalSales),
    },
    channels,
  };
}

/** Revenue rolled up by utm_campaign (touch-derived). No spend join (spend is ad-level). */
export async function revenueByCampaign(params: ReportParams) {
  const ds = await loadDataset(params);
  const rows = rollupConversions(ds.conversions, ds.touchesByKey, {
    model: ds.range.model,
    windowDays: ds.range.windowDays,
    dimension: "campaign",
    filter: ds.range.filter,
  });
  return { model: ds.range.model, windowDays: ds.range.windowDays, campaigns: rows };
}

/** Ad-level revenue with FB-vs-IG split columns + spend/CAC/ROAS + ad names. */
export async function revenueByAd(params: ReportParams) {
  const ds = await loadDataset(params);
  const rows = rollupAdPlatformSplit(ds.conversions, ds.touchesByKey, {
    model: ds.range.model,
    windowDays: ds.range.windowDays,
  });
  const { spend, names } = await fetchSpendByAd(ds.range.startMs, ds.range.endMs);
  const ads = rows.map((r) => {
    const s = spend.get(r.adId);
    const spendCents = s?.spendCents || 0;
    return {
      ...r,
      adName: names.get(r.adId) || r.adId,
      spendCents,
      impressions: s?.impressions || 0,
      clicks: s?.clicks || 0,
      roas: computeRoas(r.revenueCents, spendCents),
      cacCents: computeCac(spendCents, r.conversions),
    };
  });
  return { model: ds.range.model, windowDays: ds.range.windowDays, ads };
}

/** Leads (waitlist/free-session/enquiry) rolled up by channel. */
export async function leadsByChannel(params: ReportParams) {
  const ds = await loadDataset(params);
  const leadsOnly = ds.conversions.filter((c) => c.isLead);
  const rows = rollupConversions(leadsOnly, ds.touchesByKey, {
    model: ds.range.model,
    windowDays: ds.range.windowDays,
    dimension: "channel",
    filter: ds.range.filter,
  });
  return { model: ds.range.model, channels: rows };
}

/**
 * Reconciliation: tracked conversions vs ad-platform activity vs HDYHAU self-report,
 * per channel. These deliberately will NOT match — divergence is information.
 */
export async function reconciliation(params: ReportParams) {
  const ds = await loadDataset(params);
  const tracked = rollupConversions(ds.conversions, ds.touchesByKey, {
    model: ds.range.model,
    windowDays: ds.range.windowDays,
    dimension: "channel",
    filter: ds.range.filter,
  });
  const spendByChannel = await fetchSpendByChannel(ds.range.startMs, ds.range.endMs);
  const rows = buildReconciliation({
    tracked,
    hdyhauByChannel: hdyhauCountsByChannel(ds.conversions),
    platformByChannel: spendByChannel,
  });
  return { model: ds.range.model, rows };
}

/**
 * Recent conversions across the 8 tables (most-recent first), for the journeys
 * drilldown list. Anonymous rows are included so the list is complete; `personId`
 * is null when the buyer was never identified (only person-backed rows can open a
 * full timeline via `personJourney`). Capped so the list stays cheap.
 */
export async function recentConversions(params: ReportParams & { limit?: number }) {
  const range = resolveParams(params);
  const raw = await fetchConversions({
    orgIds: params.orgIds,
    startMs: range.startMs,
    endMs: range.endMs,
  });
  const tagged = tagNewVsReturning(raw) as (ConvRow & { isNew: boolean })[];
  const limit = params.limit && params.limit > 0 ? Math.min(Math.floor(params.limit), 500) : 100;
  const conversions = tagged
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map((c) => ({
      source: c.source,
      id: c.id,
      personId: c.personId,
      visitorId: c.visitorId,
      timestamp: c.timestamp,
      revenueCents: c.revenueCents,
      isLead: c.isLead,
      isNew: c.isNew,
      channel: c.stampedChannel ?? null,
    }));
  return {
    model: range.model,
    windowDays: range.windowDays,
    range: { startMs: range.startMs, endMs: range.endMs },
    total: tagged.length,
    conversions,
  };
}

// ── Journey ──────────────────────────────────────────────────────────────────

export interface JourneyItem {
  type: "touch" | "conversion";
  timestamp: number;
  channel: string | null;
  channelRaw?: string | null;
  campaign?: string | null;
  landingUrl?: string | null;
  // conversion-only:
  source?: string;
  id?: number;
  revenueCents?: number;
  isLead?: boolean;
}

/** Full person timeline: every touch + conversion, ordered. Org-scoped for safety. */
export async function personJourney(personId: number, orgIds: number[]) {
  if (!Number.isInteger(personId) || !orgIds.length) return null;

  const personRes = await db.execute(sql`
    SELECT id, primary_email, primary_phone, first_name, last_name, created_at
    FROM persons WHERE id = ${personId}
  `);
  const personRow = (personRes.rows as any[])[0];
  if (!personRow) return null;

  const idRes = await db.execute(sql`
    SELECT value FROM person_identities WHERE person_id = ${personId} AND kind = 'visitor'
  `);
  const visitorIds = (idRes.rows as any[]).map((r) => String(r.value)).filter(Boolean);

  const touchRes = await db.execute(sql`
    SELECT channel, channel_raw, utm_campaign, landing_url,
           EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms
    FROM analytics_events
    WHERE is_bot = false
      AND event_type IN ('session_start', 'page_view')
      AND (person_id = ${personId} OR visitor_id = ANY(${visitorIds}))
    ORDER BY timestamp ASC
  `);
  const touches: JourneyItem[] = (touchRes.rows as any[]).map((r) => ({
    type: "touch" as const,
    timestamp: Number(r.ts_ms),
    channel: r.channel ?? null,
    channelRaw: r.channel_raw ?? null,
    campaign: r.utm_campaign ?? null,
    landingUrl: r.landing_url ?? null,
  }));

  const convs = await fetchConversions({ orgIds, personId });
  const conversions: JourneyItem[] = convs.map((c) => ({
    type: "conversion" as const,
    timestamp: c.timestamp,
    channel: c.stampedChannel ?? null,
    source: c.source,
    id: c.id,
    revenueCents: c.revenueCents,
    isLead: c.isLead,
  }));

  const timeline = [...touches, ...conversions].sort((a, b) => a.timestamp - b.timestamp);
  return {
    person: {
      id: Number(personRow.id),
      email: personRow.primary_email ?? null,
      phone: personRow.primary_phone ?? null,
      firstName: personRow.first_name ?? null,
      lastName: personRow.last_name ?? null,
    },
    touchCount: touches.length,
    conversionCount: conversions.length,
    timeline,
  };
}
