-- ─────────────────────────────────────────────────────────────────────────────
-- CIC interest registrations — structured "Register Your Interest" submissions
-- from cicyouth.com. One row per club: a club admin registers ALL the age groups
-- they want in one hit and is the single contact for all of them (age_groups
-- holds every selected grade). Powers the age-group board in the CIC Registrations
-- tab (slots fill per grade with the exact team contact + registration timestamp).
--
-- ADDITIVE ONLY — safe to run against the live Supabase DB. Run BEFORE the deploy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cic_interest_registrations (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name       text NOT NULL,
  last_name        text,
  email            text NOT NULL,
  phone            text,
  club             text,
  location         text,
  age_groups       text[] NOT NULL DEFAULT ARRAY[]::text[],
  status           text NOT NULL DEFAULT 'new',
  notes            text,
  source_url       text,
  created_at       timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cic_interest_org_idx ON cic_interest_registrations(organization_id, created_at);
