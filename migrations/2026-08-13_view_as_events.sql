-- View As — the audit trail for support-style impersonation.
--
-- An impersonation feature that leaves no trace is exactly what a security
-- review should refuse. Every session is recorded: who did it, whom they viewed,
-- when it started, when it ended. A row with ended_at NULL is a session that was
-- never stopped (the browser was simply closed), which is worth being able to see.
--
-- ON DELETE RESTRICT on both sides, for the same reason served_by_user_id is:
-- deleting a staff account must never erase the record of who acted, or of who
-- was viewed. That is the whole value of an audit table.

CREATE TABLE IF NOT EXISTS view_as_events (
  id            serial PRIMARY KEY,
  actor_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz
);

CREATE INDEX IF NOT EXISTS view_as_events_actor_idx  ON view_as_events (actor_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS view_as_events_target_idx ON view_as_events (target_user_id, started_at DESC);

-- New tables default to RLS OFF and a Supabase anon key is public by design.
-- This table names staff and their impersonation history — it never gets read
-- through the anon key, and the app connects as postgres/service-role which
-- bypasses RLS, so enabling it costs nothing and closes the leaked-key path.
ALTER TABLE view_as_events ENABLE ROW LEVEL SECURITY;
