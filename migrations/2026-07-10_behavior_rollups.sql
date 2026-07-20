-- Total Tracking Platform, Phase 1 (Behavioral Depth) — nightly rollup tables.
-- Additive only (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS). Safe
-- to re-run. Run on Supabase prod BEFORE the Fly deploy. DO NOT db:push.
--
-- These are the ONLY tables the ClubOS "Behavior" tab and any agent read — never
-- the raw behavior_events table (see AGENTS.md North star, D17/D18). Recomputed
-- nightly for "yesterday" by server/behavior-rollup-cron.ts (T7) via idempotent
-- upserts, so every table below carries a unique key matching its natural grain.
--
-- No FKs to behavior_events on purpose — behavior_events is partitioned + pruned
-- at 13 months, these rollups are kept forever, so they must not depend on rows
-- that may no longer exist.

-- ── page_stats_daily ─────────────────────────────────────────────────────────
-- Per site+page+day: views, uniques, avg dwell (from page_leave dwell_ms), a
-- scroll-depth histogram (band 0/10/.../100 -> count of sessions that reached
-- at least that band), and exit_rate (share of sessions whose LAST page_view
-- on that day was this page).
CREATE TABLE IF NOT EXISTS page_stats_daily (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  site text NOT NULL DEFAULT '',
  page_path text NOT NULL,
  day date NOT NULL,
  views integer NOT NULL DEFAULT 0,
  uniques integer NOT NULL DEFAULT 0,
  avg_dwell_ms real NOT NULL DEFAULT 0,
  scroll_hist jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"0":12,"10":9,...,"100":2}
  exit_rate real NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS page_stats_daily_unq ON page_stats_daily (site, page_path, day);
CREATE INDEX IF NOT EXISTS page_stats_daily_day_idx ON page_stats_daily (day);

-- ── section_stats_daily ──────────────────────────────────────────────────────
-- Per page+section+day: how long visitors actually looked at that section
-- (accumulated visible-ms from IntersectionObserver, T6) and how many times it
-- was seen.
CREATE TABLE IF NOT EXISTS section_stats_daily (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  page_path text NOT NULL,
  section_key text NOT NULL,
  day date NOT NULL,
  avg_visible_ms real NOT NULL DEFAULT 0,
  view_count integer NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS section_stats_daily_unq ON section_stats_daily (page_path, section_key, day);
CREATE INDEX IF NOT EXISTS section_stats_daily_day_idx ON section_stats_daily (day);

-- ── click_stats_daily ────────────────────────────────────────────────────────
-- Per page+element+viewport+day: the heatmap data. avg_offset_x/y are the mean
-- normalized (0..1) click position within the element, letting the UI render a
-- coarse heat dot per css_path without ever storing raw pixel coordinates.
CREATE TABLE IF NOT EXISTS click_stats_daily (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  page_path text NOT NULL,
  css_path text NOT NULL,
  viewport text NOT NULL DEFAULT '',  -- 'mobile' | 'tablet' | 'desktop'
  day date NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  uniques integer NOT NULL DEFAULT 0,
  avg_offset_x real NOT NULL DEFAULT 0,
  avg_offset_y real NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS click_stats_daily_unq ON click_stats_daily (page_path, css_path, viewport, day);
CREATE INDEX IF NOT EXISTS click_stats_daily_day_idx ON click_stats_daily (day);

-- ── journey_edges_daily ──────────────────────────────────────────────────────
-- Per site+day: page->page transition counts (consecutive page_view rows within
-- a session, from analytics_events, plus route_change events from T6) — the
-- Sankey source for T11.
CREATE TABLE IF NOT EXISTS journey_edges_daily (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  site text NOT NULL DEFAULT '',
  from_path text NOT NULL,
  to_path text NOT NULL,
  day date NOT NULL,
  count integer NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS journey_edges_daily_unq ON journey_edges_daily (site, from_path, to_path, day);
CREATE INDEX IF NOT EXISTS journey_edges_daily_day_idx ON journey_edges_daily (day);

-- ── hour_of_day_profile ──────────────────────────────────────────────────────
-- Per site+day-of-week+hour: a rolling session-count profile (NOT scoped to a
-- single calendar day — the nightly cron increments the (dow, hour) bucket that
-- "yesterday" fell into, building up a stable weekly traffic-heat pattern over
-- time). dow: 0=Sunday..6=Saturday (Postgres EXTRACT(DOW) convention). hour:
-- 0..23, NZ local time.
CREATE TABLE IF NOT EXISTS hour_of_day_profile (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  site text NOT NULL DEFAULT '',
  dow smallint NOT NULL,
  hour smallint NOT NULL,
  sessions integer NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS hour_of_day_profile_unq ON hour_of_day_profile (site, dow, hour);
