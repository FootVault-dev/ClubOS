-- AttributionOS — migration file 3: VACUUM-friendly analytics indexes (T21).
-- Additive only (CREATE INDEX IF NOT EXISTS). Safe to re-run. Run on Supabase
-- prod BEFORE the Fly deploy. DO NOT db:push.
--
-- These three composite indexes back the hot attribution read paths:
--   · (visitor_id, timestamp) — per-visitor touch spine + stitch lookups
--   · (person_id,  timestamp) — per-person journey timelines (T18/T19)
--   · (channel,    timestamp) — channel-over-time reporting aggregates
-- and they keep the nightly prune + autovacuum from thrashing the table.
--
-- NOTE for the human applying this: analytics_events can be large. On a big prod
-- table prefer running each statement CONCURRENTLY (outside a transaction) to
-- avoid a write lock, e.g.
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS analytics_events_visitor_ts_idx
--     ON analytics_events (visitor_id, timestamp);
-- The plain (transaction-safe) form is below so the file runs cleanly either way.

CREATE INDEX IF NOT EXISTS analytics_events_visitor_ts_idx
  ON analytics_events (visitor_id, timestamp);

CREATE INDEX IF NOT EXISTS analytics_events_person_ts_idx
  ON analytics_events (person_id, timestamp);

CREATE INDEX IF NOT EXISTS analytics_events_channel_ts_idx
  ON analytics_events (channel, timestamp);
