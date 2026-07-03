-- Community engagement event tracker (SIU workspace) — one board for fan/community
-- events: outreach pipeline → plan → run → post-review. Ruby/Conor (merch),
-- Brad (fan engagement / watch-alongs), club visits, school visits, community days.
-- ADDITIVE ONLY — safe on the live Supabase DB. Run BEFORE the Fly deploy.

CREATE TABLE IF NOT EXISTS community_events (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  event_type       TEXT NOT NULL DEFAULT 'other',   -- watch_along | club_visit | community_day | school_visit | merch_activation | fan_event | outreach | other
  status           TEXT NOT NULL DEFAULT 'idea',     -- idea | outreach | confirmed | scheduled | completed | reviewed | cancelled
  owner            TEXT,                             -- Ruby | Conor | Brad | ...
  partner          TEXT,                             -- e.g. 'Nomads', 'Flying Kiwis'
  event_date       DATE,                             -- null while still in outreach
  location         TEXT,
  description      TEXT,                             -- the plan
  outreach_notes   TEXT,                             -- pipeline notes ('reached out 4 Jul, awaiting reply')
  review_notes     TEXT,                             -- post-event learnings
  attendance       INTEGER,
  reach            TEXT,                             -- social reach / estimate
  links            TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_community_events_org
  ON community_events (organization_id, event_date);
