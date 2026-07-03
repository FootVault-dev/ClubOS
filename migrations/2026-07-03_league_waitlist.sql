-- League waitlist — captured from the public join site when a night is sold out.
-- Additive only. Run on Supabase prod BEFORE the Fly deploy.

CREATE TABLE IF NOT EXISTS league_waitlist (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competition_id integer REFERENCES league_competitions(id) ON DELETE CASCADE,
  program_slug text,
  team_name text NOT NULL,
  contact_name text NOT NULL,
  email text NOT NULL,
  phone text,
  division_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  status text NOT NULL DEFAULT 'waiting',
  utm_source text,
  utm_medium text,
  utm_campaign text,
  fbclid text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS league_waitlist_org_idx ON league_waitlist (organization_id, status, created_at DESC);
