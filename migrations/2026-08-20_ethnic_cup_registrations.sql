-- Christchurch Ethnic Cup — registrations of interest from ethniccup.com.
-- Additive only. NO BEGIN/COMMIT in here: the apply script wraps this in its
-- own transaction, and an inner COMMIT would end it and make --dry-run's
-- ROLLBACK run in autocommit — i.e. rehearse nothing. (14 migrations in this
-- repo still have that hole.)

CREATE TABLE IF NOT EXISTS ethnic_cup_registrations (
  id               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name       text NOT NULL,
  last_name        text,
  email            text NOT NULL,
  phone            text,
  community        text,
  grade            text,
  message          text,
  source_url       text,
  status           text NOT NULL DEFAULT 'new',
  notes            text,
  created_at       timestamp NOT NULL DEFAULT now(),
  updated_at       timestamp NOT NULL DEFAULT now()
);

-- No CHECK on status on purpose: a stale CHECK is how the MFL checkout 500'd.
-- Valid values are enforced in ethnic-cup-routes.ts, which is the one decider.

CREATE INDEX IF NOT EXISTS ethnic_cup_registrations_org_created_idx
  ON ethnic_cup_registrations (organization_id, created_at DESC);

-- A new table defaults to RLS OFF, and an anon key is public by design.
-- The app connects as postgres/service-role (rolbypassrls), so this changes
-- nothing for us — it is the second wall if a key ever leaks.
ALTER TABLE ethnic_cup_registrations ENABLE ROW LEVEL SECURITY;
