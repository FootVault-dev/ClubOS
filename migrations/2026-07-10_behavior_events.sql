-- Total Tracking Platform, Phase 1 (Behavioral Depth) — the raw behavioral event
-- table. A SEPARATE pipeline from analytics_events (session_start/page_view touch
-- classification, which is live in production — see AGENTS.md rule 4). This table
-- is written to ONLY by the new POST /api/public/analytics/behavior collector (T5).
-- Additive only (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS). Safe to
-- re-run. Run on Supabase prod BEFORE the Fly deploy. DO NOT db:push.
--
-- Monthly RANGE partitioned on `ts` — high-volume clickstream data, partitioning
-- keeps writes/index maintenance cheap and makes the 13-month prune (T7) a plain
-- DROP PARTITION instead of a slow bulk DELETE. No pg_partman extension — partition
-- maintenance (create next month, drop >13-month-old) is done in plain SQL by the
-- nightly server/behavior-rollup-cron.ts (T7), same additive-only discipline as
-- this migration. If that cron is ever paused for >1 month, a human must manually
-- add the next CREATE TABLE ... PARTITION OF statement (copy the pattern below)
-- before writes to that month start failing with "no partition found for row".
--
-- The attribution "person" is always the PARENT/payer — never a child. No child
-- PII is stored here (visitor_id + event shape only).

CREATE TABLE IF NOT EXISTS behavior_events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  visitor_id text,
  person_id integer,
  session_id text,
  site text,
  event_type text NOT NULL,
  page_path text,
  css_path text,
  offset_x real,
  offset_y real,
  viewport text,
  scroll_band int,
  section_key text,
  visible_ms int,
  dwell_ms int,
  form_id text,
  metric text,
  metric_value real,
  text_hash text,       -- FNV-1a hex hash of clicked-element text (NO raw text) — shapeBehaviorEvent
  country text,
  city text,
  is_bot boolean NOT NULL DEFAULT false,
  ts timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, ts)  -- partitioned tables require the partition key in every PK/unique constraint
) PARTITION BY RANGE (ts);

-- Current + next 2 monthly partitions (this migration authored 2026-07-10).
CREATE TABLE IF NOT EXISTS behavior_events_2026_07 PARTITION OF behavior_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS behavior_events_2026_08 PARTITION OF behavior_events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS behavior_events_2026_09 PARTITION OF behavior_events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- Indexes on the parent — Postgres automatically creates a matching index on
-- every existing partition, AND on every future partition created with
-- `... PARTITION OF behavior_events ...` after this point (PG11+ behaviour).
CREATE INDEX IF NOT EXISTS behavior_events_visitor_ts_idx ON behavior_events (visitor_id, ts);
CREATE INDEX IF NOT EXISTS behavior_events_page_ts_idx ON behavior_events (page_path, ts);
CREATE INDEX IF NOT EXISTS behavior_events_type_ts_idx ON behavior_events (event_type, ts);
CREATE INDEX IF NOT EXISTS behavior_events_section_ts_idx ON behavior_events (section_key, ts);
