-- CIC 7's register-interest submissions (from the cic7s.com marketing site).
-- ADDITIVE ONLY — safe to run on the live Supabase DB. Run this BEFORE the Fly deploy
-- that ships the new endpoints (per the prod-DB rule: never db:push --force).

CREATE TABLE IF NOT EXISTS cic7s_registrations (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name      TEXT NOT NULL,
  last_name       TEXT,
  email           TEXT NOT NULL,
  location        TEXT,
  phone           TEXT,
  category        TEXT,            -- 'Mens' | 'Masters' | 'Social'
  source_url      TEXT,
  status          TEXT NOT NULL DEFAULT 'new',  -- 'new' | 'contacted' | 'confirmed' | 'archived'
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cic7s_registrations_org
  ON cic7s_registrations (organization_id, created_at DESC);
