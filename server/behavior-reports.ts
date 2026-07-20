/**
 * Total Tracking Platform, Phase 1 — Behavior admin reporting API (T8).
 *
 * Read-only DB glue over the `*_daily` rollup tables ONLY — never `behavior_events`
 * directly (AGENTS.md North star, D17/D18). Mirrors the shape of
 * `server/attribution-reports.ts` (T18): pure query params in, plain rows out; the
 * pure reducers it feeds through (`scrollHistToFunnel`, `hourProfileToGrid`) live in
 * `shared/behavior-rollups.ts` and are unit-tested there.
 */

import { sql } from "drizzle-orm";
import { db } from "./db";
import { nzDateString } from "@shared/meta-insights";
import { scrollHistToFunnel, hourProfileToGrid } from "@shared/behavior-rollups";

export interface BehaviorRange {
  /** Inclusive, YYYY-MM-DD, NZ-local (matches how the T7 cron buckets `day`). */
  startDay: string;
  endDay: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse the shared `start`/`end`/`days` query params into a NZ-local day range.
 *  Defaults to the trailing 30 days ending today, capped at 365 days. */
export function resolveBehaviorRange(q: Record<string, any>): BehaviorRange {
  const toDay = (v: any): string | null => {
    if (v == null || v === "") return null;
    const s = String(v).trim();
    return DAY_RE.test(s) ? s : null;
  };
  const endDay = toDay(q.end) ?? nzDateString(new Date());
  const daysRaw = q.days ? parseInt(String(q.days), 10) : NaN;
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30;
  const startDay =
    toDay(q.start) ?? nzDateString(new Date(Date.now() - days * 86_400_000));
  return { startDay, endDay };
}

/** Build (or omit) a `site = ANY(...)` predicate. Empty `sites` means "no filter" —
 *  used when an org has no mapped domain in shared/org-domains, or a group-scope
 *  workspace whose member orgs resolved zero domains. */
function siteFilter(sites: string[]) {
  return sites.length ? sql`AND site = ANY(${sites})` : sql``;
}

export interface OverviewRow {
  site: string;
  pagePath: string;
  views: number;
  uniques: number;
  avgDwellMs: number;
  exitRate: number;
}

/** Per-site page table: views/uniques/avg-dwell/exit-rate, summed over the range.
 *  avg_dwell_ms/exit_rate are re-weighted by each day's view count so a
 *  high-traffic day doesn't get diluted by a quiet one. */
export async function behaviorOverview(
  sites: string[],
  range: BehaviorRange,
): Promise<OverviewRow[]> {
  const res = await db.execute(sql`
    SELECT site, page_path,
      SUM(views)::int AS views,
      SUM(uniques)::int AS uniques,
      CASE WHEN SUM(views) > 0 THEN SUM(avg_dwell_ms * views) / SUM(views) ELSE 0 END AS avg_dwell_ms,
      CASE WHEN SUM(views) > 0 THEN SUM(exit_rate * views) / SUM(views) ELSE 0 END AS exit_rate
    FROM page_stats_daily
    WHERE day >= ${range.startDay}::date AND day <= ${range.endDay}::date ${siteFilter(sites)}
    GROUP BY site, page_path
    ORDER BY views DESC
    LIMIT 200
  `);
  return (res.rows as any[]).map((r) => ({
    site: String(r.site ?? ""),
    pagePath: String(r.page_path),
    views: Number(r.views) || 0,
    uniques: Number(r.uniques) || 0,
    avgDwellMs: Math.round(Number(r.avg_dwell_ms) || 0),
    exitRate: Number(r.exit_rate) || 0,
  }));
}

export interface ClickRow {
  cssPath: string;
  viewport: string;
  clicks: number;
  uniques: number;
  avgOffsetX: number;
  avgOffsetY: number;
}

export interface SectionRow {
  sectionKey: string;
  avgVisibleMs: number;
  viewCount: number;
}

export interface PageDetail {
  site: string;
  pagePath: string;
  scrollFunnel: ReturnType<typeof scrollHistToFunnel>;
  sections: SectionRow[];
  topClicks: ClickRow[];
}

/** Per-page detail: scroll-depth funnel, section timing, top-clicked elements.
 *  NOTE: `section_stats_daily`/`click_stats_daily` carry no `site` column (T3's
 *  schema — page_path is the only key) so these two are NOT site-filtered, only
 *  page_path-filtered; only the scroll funnel (sourced from `page_stats_daily`,
 *  which does have `site`) is exact per-site. Acceptable for Phase 1 MVP since
 *  page_path values are expected to be brand-specific in practice; flag if two
 *  brands are ever seen sharing an identical page_path with divergent content. */
export async function behaviorPageDetail(
  sites: string[],
  range: BehaviorRange,
  site: string,
  pagePath: string,
): Promise<PageDetail> {
  const histRes = await db.execute(sql`
    SELECT scroll_hist
    FROM page_stats_daily
    WHERE page_path = ${pagePath} AND site = ${site}
      AND day >= ${range.startDay}::date AND day <= ${range.endDay}::date
  `);
  const summedHist: Record<string, number> = {};
  for (const row of histRes.rows as any[]) {
    const hist = (row.scroll_hist ?? {}) as Record<string, number>;
    for (const [band, count] of Object.entries(hist)) {
      summedHist[band] = (summedHist[band] || 0) + (Number(count) || 0);
    }
  }

  const sectionRes = await db.execute(sql`
    SELECT section_key,
      CASE WHEN SUM(view_count) > 0 THEN SUM(avg_visible_ms * view_count) / SUM(view_count) ELSE 0 END AS avg_visible_ms,
      SUM(view_count)::int AS view_count
    FROM section_stats_daily
    WHERE page_path = ${pagePath}
      AND day >= ${range.startDay}::date AND day <= ${range.endDay}::date
    GROUP BY section_key
    ORDER BY view_count DESC
    LIMIT 50
  `);

  const clickRes = await db.execute(sql`
    SELECT css_path, viewport,
      SUM(clicks)::int AS clicks,
      SUM(uniques)::int AS uniques,
      CASE WHEN SUM(clicks) > 0 THEN SUM(avg_offset_x * clicks) / SUM(clicks) ELSE 0 END AS avg_offset_x,
      CASE WHEN SUM(clicks) > 0 THEN SUM(avg_offset_y * clicks) / SUM(clicks) ELSE 0 END AS avg_offset_y
    FROM click_stats_daily
    WHERE page_path = ${pagePath}
      AND day >= ${range.startDay}::date AND day <= ${range.endDay}::date
    GROUP BY css_path, viewport
    ORDER BY clicks DESC
    LIMIT 100
  `);

  return {
    site,
    pagePath,
    scrollFunnel: scrollHistToFunnel(summedHist),
    sections: (sectionRes.rows as any[]).map((r) => ({
      sectionKey: String(r.section_key),
      avgVisibleMs: Math.round(Number(r.avg_visible_ms) || 0),
      viewCount: Number(r.view_count) || 0,
    })),
    topClicks: (clickRes.rows as any[]).map((r) => ({
      cssPath: String(r.css_path),
      viewport: String(r.viewport ?? ""),
      clicks: Number(r.clicks) || 0,
      uniques: Number(r.uniques) || 0,
      avgOffsetX: Number(r.avg_offset_x) || 0,
      avgOffsetY: Number(r.avg_offset_y) || 0,
    })),
  };
}

export interface JourneyEdge {
  fromPath: string;
  toPath: string;
  count: number;
}

/** Top page->page transitions in range, summed across days (the Sankey source, T11). */
export async function behaviorJourneys(
  sites: string[],
  range: BehaviorRange,
): Promise<JourneyEdge[]> {
  const res = await db.execute(sql`
    SELECT from_path, to_path, SUM(count)::int AS count
    FROM journey_edges_daily
    WHERE day >= ${range.startDay}::date AND day <= ${range.endDay}::date ${siteFilter(sites)}
    GROUP BY from_path, to_path
    ORDER BY count DESC
    LIMIT 150
  `);
  return (res.rows as any[]).map((r) => ({
    fromPath: String(r.from_path),
    toPath: String(r.to_path),
    count: Number(r.count) || 0,
  }));
}

/** Dense 7x24 hour-of-day session grid (dow 0=Sun..6=Sat), pooled across the
 *  scoped sites. `hour_of_day_profile` is a rolling profile with no `day` column
 *  (T3's design) so there's no date-range filter here — it's "all time so far". */
export async function behaviorHours(sites: string[]): Promise<number[][]> {
  const res = await db.execute(sql`
    SELECT dow, hour, SUM(sessions)::int AS sessions
    FROM hour_of_day_profile
    WHERE true ${siteFilter(sites)}
    GROUP BY dow, hour
  `);
  return hourProfileToGrid(
    (res.rows as any[]).map((r) => ({
      dow: Number(r.dow),
      hour: Number(r.hour),
      sessions: Number(r.sessions) || 0,
    })),
  );
}
