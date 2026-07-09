-- AttributionOS — migration file 1: identity spine + analytics_events touch columns.
-- Additive only (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS). Safe to
-- re-run. Run on Supabase prod BEFORE the Fly deploy. DO NOT db:push.
--
-- The attribution "person" is always the PARENT/payer — never a child.

-- ── persons ────────────────────────────────────────────────────────────────
-- The identity spine. Visitor ids, emails and phones all resolve to one person.
CREATE TABLE IF NOT EXISTS persons (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  primary_email text,
  primary_phone text,
  first_name text,
  last_name text,
  created_at timestamp NOT NULL DEFAULT now()
);

-- ── person_identities ────────────────────────────────────────────────────────
-- Every known handle for a person. unique(kind, value): a handle points at one person.
CREATE TABLE IF NOT EXISTS person_identities (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  person_id integer NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  kind text NOT NULL,   -- 'email' | 'phone' | 'visitor'
  value text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS person_identities_kind_value_unq
  ON person_identities (kind, value);
CREATE UNIQUE INDEX IF NOT EXISTS person_identities_person_kind_value_unq
  ON person_identities (person_id, kind, value);

-- ── person_merges ────────────────────────────────────────────────────────────
-- Audit trail for every merge decision, including refusals (reason
-- 'blocked_auto_merge' when two already-identified persons collide).
CREATE TABLE IF NOT EXISTS person_merges (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  winner_id integer NOT NULL,   -- person kept (not FK — losers may be deleted)
  loser_id integer NOT NULL,    -- person merged away (or would-be)
  reason text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

-- ── analytics_events — attribution touch columns ─────────────────────────────
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS fbclid text;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS gclid text;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS click_id text;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS fbp text;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS fbc text;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS person_id integer;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS channel_raw text;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS landing_url text;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS is_bot boolean NOT NULL DEFAULT false;
