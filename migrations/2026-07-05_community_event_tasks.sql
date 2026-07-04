-- Tasks/deadlines attached to community events — drives the events calendar
-- (what's pressing, deadlines, per-event tasks). ADDITIVE ONLY.
CREATE TABLE IF NOT EXISTS community_event_tasks (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id         INTEGER NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  due_date         DATE,
  done             BOOLEAN NOT NULL DEFAULT false,
  owner            TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_community_event_tasks_org ON community_event_tasks (organization_id, due_date);
CREATE INDEX IF NOT EXISTS idx_community_event_tasks_event ON community_event_tasks (event_id, sort_order);
