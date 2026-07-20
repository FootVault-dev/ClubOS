// Total Tracking Platform, Phase 1 (Behavioral Depth) — pure SQL-builder module for
// the nightly rollup recompute (T7). No DB import here so this unit-tests standalone:
//   npx tsx script/test-behavior-rollups.ts
//
// Each `build*` function returns a { text, params } pair using standard Postgres
// positional placeholders ($1, ...) — the same shape `pg`/node-postgres expects from
// `pool.query(text, params)`. The cron (T7) is the ONLY caller that ever executes
// these; this module never touches a connection. Every query:
//   - is bounded to a single UTC calendar `day` ($1::date .. $1::date + 1 day)
//   - excludes is_bot = true rows
//   - is an idempotent UPSERT (ON CONFLICT ... DO UPDATE) — safe to re-run for the
//     same day, EXCEPT hour_of_day_profile, which is a deliberate rolling-weekly
//     INCREMENT (see AGENTS.md Lessons learned, T3) — re-running the same day twice
//     double-counts that day's contribution. T7 must not re-run a day twice for that
//     one rollup (the other four are full overwrites and safe to re-run any number
//     of times).
//   - contains no destructive verb (no DROP/TRUNCATE/DELETE) — recompute is
//     additive-or-overwrite only, per AGENTS.md rule 3.
//
// Source tables, per AGENTS.md §4: page_stats_daily / section_stats_daily /
// click_stats_daily / hour_of_day_profile read ONLY behavior_events (the new v2
// behavioral pipeline). journey_edges_daily is the one exception — it also reads
// analytics_events (event_type='page_view') for classic full-page navigations,
// unioned with behavior_events route_change rows for SPA navigations. Reading
// analytics_events here is fine (rule 4 forbids touching its WRITE path / classifier
// semantics, not reading it downstream).

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a `day` is a plain YYYY-MM-DD date string. Throws on anything else —
 *  callers (the cron) always pass a computed date, never raw user input, so a
 *  throw here means a programming error, not a runtime/security concern. */
function assertDay(day: string): string {
  if (typeof day !== "string" || !DAY_RE.test(day)) {
    throw new Error(`behavior-rollups: invalid day "${String(day)}", expected YYYY-MM-DD`);
  }
  return day;
}

export interface SqlQuery {
  text: string;
  params: unknown[];
}

/** The 11 scroll bands stored in `page_stats_daily.scroll_hist` (matches
 *  shared/behavior.ts `bucketScrollBand` — always a multiple of 10, 0..100). */
export const SCROLL_BANDS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

// ── 1. page_stats_daily ──────────────────────────────────────────────────────
/** Recompute one day's page_stats_daily: views/uniques/avg_dwell_ms come from
 *  `page_leave` rows (one per completed pageview); the scroll histogram is a
 *  cumulative "reached-at-least-this-band" count over each session's MAX scroll
 *  band on that page; exit_rate is the share of a page's page_leave rows that
 *  were the LAST page_leave in their session that day. Full overwrite per day —
 *  safe to re-run. */
export function buildPageStatsDailyUpsert(day: string): SqlQuery {
  assertDay(day);
  const histFields = SCROLL_BANDS.map(
    (b) => `'${b}', COUNT(*) FILTER (WHERE max_band >= ${b})`,
  ).join(",\n      ");
  const text = `
INSERT INTO page_stats_daily (site, page_path, day, views, uniques, avg_dwell_ms, scroll_hist, exit_rate, updated_at)
WITH day_events AS (
  SELECT * FROM behavior_events
  WHERE is_bot = false AND ts >= $1::date AND ts < $1::date + interval '1 day'
),
leaves AS (
  SELECT COALESCE(site, '') AS site, page_path, session_id, visitor_id, dwell_ms,
         ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC) AS rn_in_session
  FROM day_events
  WHERE event_type = 'page_leave' AND page_path IS NOT NULL
),
page_agg AS (
  SELECT site, page_path,
    COUNT(*) AS views,
    COUNT(DISTINCT visitor_id) AS uniques,
    AVG(dwell_ms) AS avg_dwell_ms,
    COUNT(*) FILTER (WHERE rn_in_session = 1) AS exits
  FROM leaves
  GROUP BY site, page_path
),
scrolls AS (
  SELECT COALESCE(site, '') AS site, page_path, session_id, MAX(scroll_band) AS max_band
  FROM day_events
  WHERE event_type = 'scroll' AND page_path IS NOT NULL
  GROUP BY site, page_path, session_id
),
scroll_hist AS (
  SELECT site, page_path,
    jsonb_build_object(
      ${histFields}
    ) AS hist
  FROM scrolls
  GROUP BY site, page_path
)
SELECT
  p.site, p.page_path, $1::date,
  p.views, p.uniques, COALESCE(p.avg_dwell_ms, 0),
  COALESCE(s.hist, '{}'::jsonb),
  CASE WHEN p.views > 0 THEN p.exits::real / p.views ELSE 0 END,
  now()
FROM page_agg p
LEFT JOIN scroll_hist s ON s.site = p.site AND s.page_path = p.page_path
ON CONFLICT (site, page_path, day) DO UPDATE SET
  views = EXCLUDED.views,
  uniques = EXCLUDED.uniques,
  avg_dwell_ms = EXCLUDED.avg_dwell_ms,
  scroll_hist = EXCLUDED.scroll_hist,
  exit_rate = EXCLUDED.exit_rate,
  updated_at = now();
`.trim();
  return { text, params: [day] };
}

// ── 2. section_stats_daily ───────────────────────────────────────────────────
/** Recompute one day's section_stats_daily from `section_view` rows (accumulated
 *  visible-ms per section per pageview, emitted by the client IntersectionObserver).
 *  Full overwrite per day — safe to re-run. */
export function buildSectionStatsDailyUpsert(day: string): SqlQuery {
  assertDay(day);
  const text = `
INSERT INTO section_stats_daily (page_path, section_key, day, avg_visible_ms, view_count, updated_at)
SELECT page_path, section_key, $1::date,
  AVG(visible_ms) AS avg_visible_ms,
  COUNT(*) AS view_count
FROM behavior_events
WHERE event_type = 'section_view'
  AND page_path IS NOT NULL AND section_key IS NOT NULL
  AND is_bot = false
  AND ts >= $1::date AND ts < $1::date + interval '1 day'
GROUP BY page_path, section_key
ON CONFLICT (page_path, section_key, day) DO UPDATE SET
  avg_visible_ms = EXCLUDED.avg_visible_ms,
  view_count = EXCLUDED.view_count,
  updated_at = now();
`.trim();
  return { text, params: [day] };
}

// ── 3. click_stats_daily ─────────────────────────────────────────────────────
/** Recompute one day's click_stats_daily — the heatmap data — from `click` rows.
 *  avg_offset_x/y are the mean normalized (0..1) click position within the
 *  element. Full overwrite per day — safe to re-run. */
export function buildClickStatsDailyUpsert(day: string): SqlQuery {
  assertDay(day);
  const text = `
INSERT INTO click_stats_daily (page_path, css_path, viewport, day, clicks, uniques, avg_offset_x, avg_offset_y, updated_at)
SELECT page_path, css_path, COALESCE(viewport, ''), $1::date,
  COUNT(*) AS clicks,
  COUNT(DISTINCT visitor_id) AS uniques,
  AVG(offset_x) AS avg_offset_x,
  AVG(offset_y) AS avg_offset_y
FROM behavior_events
WHERE event_type = 'click'
  AND page_path IS NOT NULL AND css_path IS NOT NULL
  AND is_bot = false
  AND ts >= $1::date AND ts < $1::date + interval '1 day'
GROUP BY page_path, css_path, COALESCE(viewport, '')
ON CONFLICT (page_path, css_path, viewport, day) DO UPDATE SET
  clicks = EXCLUDED.clicks,
  uniques = EXCLUDED.uniques,
  avg_offset_x = EXCLUDED.avg_offset_x,
  avg_offset_y = EXCLUDED.avg_offset_y,
  updated_at = now();
`.trim();
  return { text, params: [day] };
}

// ── 4. journey_edges_daily ───────────────────────────────────────────────────
/** Recompute one day's journey_edges_daily (the Sankey source, T11) — consecutive
 *  page transitions within a session, from analytics_events `page_view` rows
 *  (classic full-page navigations; analytics_events has no `site` column, so those
 *  edges are recorded under site='') UNIONed with behavior_events `route_change`
 *  rows (SPA navigations, real per-site). Full overwrite per day — safe to re-run.
 *  NOTE: a navigation that fires BOTH a page_view and a route_change (unlikely but
 *  possible on a hybrid app) is counted twice — acceptable for a directional flow
 *  view, flag if it becomes visibly wrong in the UI. */
export function buildJourneyEdgesDailyUpsert(day: string): SqlQuery {
  assertDay(day);
  const text = `
INSERT INTO journey_edges_daily (site, from_path, to_path, day, count, updated_at)
WITH pv AS (
  SELECT session_id, page AS path, timestamp AS ts, ''::text AS site
  FROM analytics_events
  WHERE event_type = 'page_view' AND page IS NOT NULL AND is_bot = false
    AND timestamp >= $1::date AND timestamp < $1::date + interval '1 day'
),
rc AS (
  SELECT session_id, page_path AS path, ts, COALESCE(site, '') AS site
  FROM behavior_events
  WHERE event_type = 'route_change' AND page_path IS NOT NULL AND is_bot = false
    AND ts >= $1::date AND ts < $1::date + interval '1 day'
),
combined AS (
  SELECT session_id, path, ts, site FROM pv
  UNION ALL
  SELECT session_id, path, ts, site FROM rc
),
ordered AS (
  SELECT session_id, site, path,
    LAG(path) OVER (PARTITION BY session_id ORDER BY ts) AS prev_path
  FROM combined
),
edges AS (
  SELECT site, prev_path AS from_path, path AS to_path, COUNT(*) AS count
  FROM ordered
  WHERE prev_path IS NOT NULL AND prev_path <> path
  GROUP BY site, prev_path, path
)
SELECT site, from_path, to_path, $1::date, count, now()
FROM edges
ON CONFLICT (site, from_path, to_path, day) DO UPDATE SET
  count = EXCLUDED.count,
  updated_at = now();
`.trim();
  return { text, params: [day] };
}

// ── 5. hour_of_day_profile ───────────────────────────────────────────────────
/** INCREMENT (not overwrite) the rolling weekly (site, dow, hour) session-count
 *  profile with one day's contribution. NZ local time (Pacific/Auckland) per
 *  AGENTS.md §4/schema comment. dow follows Postgres EXTRACT(DOW) (0=Sun..6=Sat).
 *  ⚠️ NOT safe to re-run for the same `day` — it will double-count. T7 must only
 *  call this once per calendar day (see AGENTS.md Lessons learned, T3). */
export function buildHourOfDayProfileUpsert(day: string): SqlQuery {
  assertDay(day);
  const text = `
INSERT INTO hour_of_day_profile (site, dow, hour, sessions, updated_at)
SELECT
  COALESCE(site, '') AS site,
  EXTRACT(DOW FROM ts AT TIME ZONE 'Pacific/Auckland')::smallint AS dow,
  EXTRACT(HOUR FROM ts AT TIME ZONE 'Pacific/Auckland')::smallint AS hour,
  COUNT(DISTINCT session_id) AS sessions
FROM behavior_events
WHERE is_bot = false AND ts >= $1::date AND ts < $1::date + interval '1 day'
GROUP BY 1, 2, 3
ON CONFLICT (site, dow, hour) DO UPDATE SET
  sessions = hour_of_day_profile.sessions + EXCLUDED.sessions,
  updated_at = now();
`.trim();
  return { text, params: [day] };
}

// ── Manifest — T7 iterates this to run "all 5 rollups for yesterday" ────────
export interface RollupBuilder {
  name: string;
  build: (day: string) => SqlQuery;
}

export const ROLLUP_BUILDERS: RollupBuilder[] = [
  { name: "page_stats_daily", build: buildPageStatsDailyUpsert },
  { name: "section_stats_daily", build: buildSectionStatsDailyUpsert },
  { name: "click_stats_daily", build: buildClickStatsDailyUpsert },
  { name: "journey_edges_daily", build: buildJourneyEdgesDailyUpsert },
  { name: "hour_of_day_profile", build: buildHourOfDayProfileUpsert },
];

// ── Client-facing read-shape reducers (pure — used by T8/T10) ───────────────

/** Turn a `page_stats_daily.scroll_hist` jsonb blob (band -> cumulative-sessions
 *  count, keys as strings) into an ordered funnel: each band's share of the band-0
 *  count (the "reached the page at all" baseline), 0 when there's no baseline. */
export function scrollHistToFunnel(
  hist: Record<string, number> | null | undefined,
): Array<{ band: number; sessions: number; pct: number }> {
  const h = hist || {};
  const baseline = Number(h["0"]) || 0;
  return SCROLL_BANDS.map((band) => {
    const sessions = Number(h[String(band)]) || 0;
    const pct = baseline > 0 ? Math.round((sessions / baseline) * 1000) / 10 : 0;
    return { band, sessions, pct };
  });
}

/** Turn `hour_of_day_profile` rows into a dense 7×24 grid (grid[dow][hour] =
 *  sessions), zero-filled for buckets with no data yet. `dow` 0=Sun..6=Sat. */
export function hourProfileToGrid(
  rows: Array<{ dow: number; hour: number; sessions: number }>,
): number[][] {
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of rows) {
    const dow = Math.trunc(r.dow);
    const hour = Math.trunc(r.hour);
    if (dow < 0 || dow > 6 || hour < 0 || hour > 23) continue;
    grid[dow][hour] = Number(r.sessions) || 0;
  }
  return grid;
}
