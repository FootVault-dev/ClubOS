/**
 * AttributionOS — query-time attribution MODELS + pure aggregation helpers (T18).
 *
 * This module is deliberately DB-free and client-safe (only imports the pure
 * `./attribution` vocabulary). The heavy attribution logic lives here so it can
 * be unit-tested over synthetic touch arrays (`script/test-attribution-reports.ts`)
 * — the server report layer (`server/attribution-reports.ts`) just fetches rows
 * from Postgres and feeds them through these functions.
 *
 * Models (pinned in AGENTS.md — do not add fractional / U-shaped / time-decay):
 *   - first_touch       : first touch WITHIN the lookback window
 *   - last_non_direct   : latest non-direct touch within the window (GA4 fallback:
 *                         if every touch is direct, the last touch wins)
 *   - lifetime_first    : the person's first-ever touch (ignores the window)
 *
 * The window is a query param (default 90 days). New-vs-returning is a first-class
 * split: every rollup row carries both counts and callers may also filter the set.
 */

import { mapHdyhauToChannel } from "./attribution";

export const ATTRIBUTION_MODELS = [
  "first_touch",
  "last_non_direct",
  "lifetime_first",
] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export const DEFAULT_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

export function isAttributionModel(v: unknown): v is AttributionModel {
  return typeof v === "string" && (ATTRIBUTION_MODELS as readonly string[]).includes(v);
}

/** Coerce an untrusted model string to a valid one (default last_non_direct). */
export function coerceAttributionModel(v: unknown): AttributionModel {
  return isAttributionModel(v) ? v : "last_non_direct";
}

/**
 * A single touchpoint from the analytics_events log (already classified at ingest).
 * `timestamp` is epoch-ms so the pure layer never touches Date/timezone.
 */
export interface Touch {
  channel: string | null;
  channelRaw?: string | null;
  campaign?: string | null;
  content?: string | null;
  adId?: string | null;
  adsetId?: string | null;
  campaignId?: string | null;
  /** Meta publisher_platform ('facebook' | 'instagram' | 'audience_network' | ...). */
  platform?: string | null;
  timestamp: number;
}

/** A revenue/lead event pulled from one of the conversion tables. */
export interface ConversionRecord {
  /** Join key into `touchesByKey` — `p:<personId>` when identified, else `v:<visitorId>`. */
  key: string | null;
  timestamp: number;
  revenueCents: number;
  /** true = this is the person's first conversion (new customer). */
  isNew: boolean;
  /** true = lead (waitlist/free-session/enquiry), false = a paid sale. */
  isLead: boolean;
  /** Conversion-time attribution stamp (last-touch), used as fallback when no touch log. */
  stampedChannel?: string | null;
  stampedCampaign?: string | null;
  stampedAdId?: string | null;
  stampedAdsetId?: string | null;
  stampedCampaignId?: string | null;
  stampedPlatform?: string | null;
  /** Self-reported "how did you hear" answer (id), used as the last-resort waterfall step. */
  hdyhau?: string | null;
  /** Free-form origin table label, for drilldowns / journeys. */
  source?: string;
  id?: number;
}

export type ReportDimension = "channel" | "campaign" | "ad" | "platform";

const DIRECT_CHANNELS = new Set(["direct", "", "unattributed"]);

export function isDirectChannel(channel: string | null | undefined): boolean {
  return channel == null || DIRECT_CHANNELS.has(channel);
}

/** Meta publisher_platform → FB/IG bucket for the FB-vs-IG split. Null when unknown. */
export function normalizeMetaPlatform(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = String(raw).toLowerCase();
  if (v.includes("instagram")) return "instagram";
  if (v.includes("facebook")) return "facebook";
  if (v.includes("audience")) return "audience_network";
  if (v.includes("messenger")) return "messenger";
  return "other";
}

/**
 * Filter + sort a touch list for a given conversion & model.
 * Returns touches ascending by time, capped at the conversion time (a touch can't
 * post-date its conversion) and — unless lifetime — bounded below by the window.
 */
function eligibleTouches(
  touches: Touch[],
  conversionTime: number | null | undefined,
  windowDays: number,
  ignoreWindow: boolean,
): Touch[] {
  const sorted = [...touches].sort((a, b) => a.timestamp - b.timestamp);
  if (conversionTime == null) return sorted;
  const lower = ignoreWindow ? -Infinity : conversionTime - windowDays * DAY_MS;
  return sorted.filter((t) => t.timestamp <= conversionTime && t.timestamp >= lower);
}

export interface SelectOpts {
  conversionTime?: number | null;
  windowDays?: number;
}

/** Core model selection — pick the attributed touch, or null if none in range. */
export function selectAttributedTouch(
  touches: Touch[],
  model: AttributionModel,
  opts: SelectOpts = {},
): Touch | null {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const ignoreWindow = model === "lifetime_first";
  const eligible = eligibleTouches(touches, opts.conversionTime, windowDays, ignoreWindow);
  if (eligible.length === 0) return null;

  if (model === "first_touch" || model === "lifetime_first") return eligible[0];

  // last_non_direct: latest non-direct touch, else fall back to the last touch.
  for (let i = eligible.length - 1; i >= 0; i--) {
    if (!isDirectChannel(eligible[i].channel)) return eligible[i];
  }
  return eligible[eligible.length - 1];
}

export type MatchedBy = "touch" | "stamped" | "self_reported" | "unattributed";

export interface AttributedConversion {
  channel: string;
  channelRaw: string | null;
  campaign: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  platform: string | null;
  matchedBy: MatchedBy;
}

/**
 * Resolve the attributed dimensions for one conversion under a model.
 * Waterfall when the touch log is empty: stamped channel → self-reported → unattributed.
 */
export function attributeConversion(
  conv: ConversionRecord,
  touches: Touch[],
  model: AttributionModel,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): AttributedConversion {
  const touch = selectAttributedTouch(touches, model, {
    conversionTime: conv.timestamp,
    windowDays,
  });
  if (touch) {
    // Channel/campaign come from the model-selected touch. Ad-level identifiers
    // are NOT in the analytics_events touch log — they only exist on the conversion
    // row's own stamp (the last-click ad) — so fall back to the stamp for those.
    return {
      channel: touch.channel || "direct",
      channelRaw: touch.channelRaw ?? null,
      campaign: touch.campaign ?? conv.stampedCampaign ?? null,
      adId: touch.adId ?? conv.stampedAdId ?? null,
      adsetId: touch.adsetId ?? conv.stampedAdsetId ?? null,
      campaignId: touch.campaignId ?? conv.stampedCampaignId ?? null,
      platform: normalizeMetaPlatform(touch.platform ?? conv.stampedPlatform),
      matchedBy: "touch",
    };
  }
  if (conv.stampedChannel || conv.stampedAdId) {
    // Ad present without a stamped channel → infer from the ad platform (meta ⇒ fb/ig).
    const platform = normalizeMetaPlatform(conv.stampedPlatform);
    const channel =
      conv.stampedChannel ||
      (platform === "facebook" || platform === "instagram" ? platform : "meta_unattributed");
    return {
      channel,
      channelRaw: conv.stampedChannel ?? null,
      campaign: conv.stampedCampaign ?? null,
      adId: conv.stampedAdId ?? null,
      adsetId: conv.stampedAdsetId ?? null,
      campaignId: conv.stampedCampaignId ?? null,
      platform,
      matchedBy: "stamped",
    };
  }
  if (conv.hdyhau) {
    return {
      channel: mapHdyhauToChannel(conv.hdyhau),
      channelRaw: conv.hdyhau,
      campaign: null,
      adId: null,
      adsetId: null,
      campaignId: null,
      platform: null,
      matchedBy: "self_reported",
    };
  }
  return {
    channel: "unattributed",
    channelRaw: null,
    campaign: null,
    adId: null,
    adsetId: null,
    campaignId: null,
    platform: null,
    matchedBy: "unattributed",
  };
}

export interface RollupRow {
  key: string;
  conversions: number;
  leads: number;
  sales: number;
  revenueCents: number;
  newConversions: number;
  returningConversions: number;
}

export interface RollupOpts {
  model: AttributionModel;
  windowDays?: number;
  dimension?: ReportDimension;
  /** Optional new/returning filter applied to the conversion set before rollup. */
  filter?: "all" | "new" | "returning";
}

const NONE_BUCKET = "(none)";

function dimensionValue(attr: AttributedConversion, dimension: ReportDimension): string | null {
  switch (dimension) {
    case "channel":
      return attr.channel || "direct";
    case "campaign":
      return attr.campaign || NONE_BUCKET;
    case "ad":
      // Ad-level report only covers ad-attributed conversions.
      return attr.adId || null;
    case "platform":
      return attr.platform; // null → skipped (only meta-platform conversions)
    default:
      return null;
  }
}

function emptyRow(key: string): RollupRow {
  return {
    key,
    conversions: 0,
    leads: 0,
    sales: 0,
    revenueCents: 0,
    newConversions: 0,
    returningConversions: 0,
  };
}

function accumulate(row: RollupRow, conv: ConversionRecord): void {
  row.conversions += 1;
  row.revenueCents += conv.revenueCents || 0;
  if (conv.isLead) row.leads += 1;
  else row.sales += 1;
  if (conv.isNew) row.newConversions += 1;
  else row.returningConversions += 1;
}

/** Roll conversions up by a dimension under the chosen model. Sorted desc by revenue then count. */
export function rollupConversions(
  conversions: ConversionRecord[],
  touchesByKey: Map<string, Touch[]>,
  opts: RollupOpts,
): RollupRow[] {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const dimension = opts.dimension ?? "channel";
  const filter = opts.filter ?? "all";
  const map = new Map<string, RollupRow>();

  for (const conv of conversions) {
    if (filter === "new" && !conv.isNew) continue;
    if (filter === "returning" && conv.isNew) continue;
    const touches = (conv.key && touchesByKey.get(conv.key)) || [];
    const attr = attributeConversion(conv, touches, opts.model, windowDays);
    const dim = dimensionValue(attr, dimension);
    if (dim == null) continue;
    const row = map.get(dim) || emptyRow(dim);
    accumulate(row, conv);
    map.set(dim, row);
  }

  return [...map.values()].sort(
    (a, b) => b.revenueCents - a.revenueCents || b.conversions - a.conversions,
  );
}

export interface AdPlatformRow {
  adId: string;
  conversions: number;
  revenueCents: number;
  facebookRevenueCents: number;
  instagramRevenueCents: number;
  otherRevenueCents: number;
  facebookConversions: number;
  instagramConversions: number;
  otherConversions: number;
}

/**
 * Ad-level rollup with the FB-vs-IG split columns the dashboard needs.
 * Only ad-attributed conversions participate.
 */
export function rollupAdPlatformSplit(
  conversions: ConversionRecord[],
  touchesByKey: Map<string, Touch[]>,
  opts: { model: AttributionModel; windowDays?: number },
): AdPlatformRow[] {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const map = new Map<string, AdPlatformRow>();

  for (const conv of conversions) {
    const touches = (conv.key && touchesByKey.get(conv.key)) || [];
    const attr = attributeConversion(conv, touches, opts.model, windowDays);
    if (!attr.adId) continue;
    const row =
      map.get(attr.adId) ||
      ({
        adId: attr.adId,
        conversions: 0,
        revenueCents: 0,
        facebookRevenueCents: 0,
        instagramRevenueCents: 0,
        otherRevenueCents: 0,
        facebookConversions: 0,
        instagramConversions: 0,
        otherConversions: 0,
      } as AdPlatformRow);
    const rev = conv.revenueCents || 0;
    row.conversions += 1;
    row.revenueCents += rev;
    if (attr.platform === "facebook") {
      row.facebookRevenueCents += rev;
      row.facebookConversions += 1;
    } else if (attr.platform === "instagram") {
      row.instagramRevenueCents += rev;
      row.instagramConversions += 1;
    } else {
      row.otherRevenueCents += rev;
      row.otherConversions += 1;
    }
    map.set(attr.adId, row);
  }

  return [...map.values()].sort(
    (a, b) => b.revenueCents - a.revenueCents || b.conversions - a.conversions,
  );
}

// ── CAC / ROAS ───────────────────────────────────────────────────────────────

/** ROAS = revenue ÷ spend (both cents). Null when spend is 0 (undefined ROAS). */
export function computeRoas(revenueCents: number, spendCents: number): number | null {
  if (!spendCents || spendCents <= 0) return null;
  return revenueCents / spendCents;
}

/** CAC = spend ÷ conversions (cents per acquisition). Null when no conversions. */
export function computeCac(spendCents: number, conversions: number): number | null {
  if (!conversions || conversions <= 0) return null;
  return spendCents / conversions;
}

export interface SpendMetrics {
  spendCents: number;
  impressions: number;
  clicks: number;
}

export interface RollupRowWithSpend extends RollupRow {
  spendCents: number;
  impressions: number;
  clicks: number;
  roas: number | null;
  cacCents: number | null;
}

/** Attach spend + derived CAC/ROAS to rollup rows, keyed on the row's dimension value. */
export function attachSpendMetrics(
  rows: RollupRow[],
  spendByKey: Map<string, SpendMetrics>,
): RollupRowWithSpend[] {
  return rows.map((r) => {
    const s = spendByKey.get(r.key);
    const spendCents = s?.spendCents || 0;
    return {
      ...r,
      spendCents,
      impressions: s?.impressions || 0,
      clicks: s?.clicks || 0,
      roas: computeRoas(r.revenueCents, spendCents),
      cacCents: computeCac(spendCents, r.conversions),
    };
  });
}

// ── Sessionisation (30-min inactivity gap) ───────────────────────────────────

/** Group touches into sessions split on a >gapMinutes inactivity gap. Ascending. */
export function sessionize(touches: Touch[], gapMinutes = 30): Touch[][] {
  const sorted = [...touches].sort((a, b) => a.timestamp - b.timestamp);
  const gap = gapMinutes * 60_000;
  const sessions: Touch[][] = [];
  let cur: Touch[] = [];
  for (const t of sorted) {
    if (cur.length && t.timestamp - cur[cur.length - 1].timestamp > gap) {
      sessions.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length) sessions.push(cur);
  return sessions;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export interface ReconciliationRow {
  channel: string;
  trackedConversions: number;
  trackedRevenueCents: number;
  hdyhauCount: number;
  spendCents: number;
  clicks: number;
  impressions: number;
}

/**
 * Combine three deliberately-divergent signals per channel:
 *   - tracked  : our attributed conversions/revenue (from rollupConversions, channel dim)
 *   - hdyhau   : self-reported "how did you hear" counts
 *   - platform : ad-platform activity (spend/clicks/impressions from ad_spend_daily)
 * They will not match — the divergence IS the information (see T20 UI).
 */
export function buildReconciliation(inputs: {
  tracked: RollupRow[];
  hdyhauByChannel: Map<string, number>;
  platformByChannel: Map<string, SpendMetrics>;
}): ReconciliationRow[] {
  const channels = new Set<string>();
  for (const r of inputs.tracked) channels.add(r.key);
  for (const c of inputs.hdyhauByChannel.keys()) channels.add(c);
  for (const c of inputs.platformByChannel.keys()) channels.add(c);

  const trackedByChannel = new Map(inputs.tracked.map((r) => [r.key, r]));
  const rows: ReconciliationRow[] = [];
  for (const channel of channels) {
    const t = trackedByChannel.get(channel);
    const p = inputs.platformByChannel.get(channel);
    rows.push({
      channel,
      trackedConversions: t?.conversions || 0,
      trackedRevenueCents: t?.revenueCents || 0,
      hdyhauCount: inputs.hdyhauByChannel.get(channel) || 0,
      spendCents: p?.spendCents || 0,
      clicks: p?.clicks || 0,
      impressions: p?.impressions || 0,
    });
  }
  return rows.sort((a, b) => b.trackedRevenueCents - a.trackedRevenueCents);
}

// ── New-vs-returning tagging (used by the server layer over fetched conversions) ─

/**
 * Given conversions carrying a person/visitor grouping key and a timestamp, mark
 * the earliest per key as `isNew` and the rest as returning. Rows with no key are
 * treated as new (we can't prove otherwise). Returns a fresh array; input untouched.
 */
export function tagNewVsReturning<T extends { key: string | null; timestamp: number }>(
  conversions: T[],
): Array<T & { isNew: boolean }> {
  const firstSeen = new Map<string, number>();
  for (const c of conversions) {
    if (!c.key) continue;
    const prev = firstSeen.get(c.key);
    if (prev == null || c.timestamp < prev) firstSeen.set(c.key, c.timestamp);
  }
  const usedFirst = new Set<string>();
  // Sort a shallow copy ascending so ties resolve to the truly-first row deterministically.
  const order = [...conversions]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.timestamp - b.c.timestamp || a.i - b.i);
  const isNewByIndex = new Array<boolean>(conversions.length).fill(false);
  for (const { c, i } of order) {
    if (!c.key) {
      isNewByIndex[i] = true;
      continue;
    }
    if (!usedFirst.has(c.key)) {
      usedFirst.add(c.key);
      isNewByIndex[i] = true;
    }
  }
  return conversions.map((c, i) => ({ ...c, isNew: isNewByIndex[i] }));
}
