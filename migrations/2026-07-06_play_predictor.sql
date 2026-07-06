-- ─────────────────────────────────────────────────────────────────────────────
-- Play Predictor — fans predict the Christchurch United first team's score +
-- goalscorers from the CUFC website, earn points, and climb per-game + season
-- leaderboards for prizes. Every entrant is captured as a CUFC (org 1)
-- marketing contact and feeds the CUFC Mailer audience.
--   predictor_fixtures    — first-team games (kickoff gates predictions; the
--                           final result + actual scorers drive scoring)
--   predictor_entrants    — fan contact capture, unique per (org, email)
--   predictor_predictions — one prediction per entrant per fixture (revisable
--                           until kickoff); points_awarded set once final
--   predictor_squad       — first-team player list behind the goalscorer picker
--
-- ADDITIVE ONLY — safe to run against the live Supabase DB. Run BEFORE the deploy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS predictor_fixtures (
  id               serial PRIMARY KEY,
  organization_id  integer NOT NULL DEFAULT 1,
  external_id      text,
  opponent         text NOT NULL,
  home_away        text NOT NULL DEFAULT 'H',      -- 'H' | 'A'
  kickoff_at       timestamptz NOT NULL,
  venue            text,
  status           text NOT NULL DEFAULT 'scheduled', -- 'scheduled' | 'final'
  cufc_score       integer,
  opponent_score   integer,
  goalscorers      jsonb,                          -- actual scorers (array of names)
  prize            text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS predictor_fixtures_org_external_unq
  ON predictor_fixtures (organization_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS predictor_entrants (
  id                serial PRIMARY KEY,
  organization_id   integer NOT NULL DEFAULT 1,
  full_name         text NOT NULL,
  email             text NOT NULL,
  phone             text NOT NULL,
  marketing_consent boolean NOT NULL DEFAULT true,
  source            text,
  created_at        timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS predictor_entrants_org_email_unq
  ON predictor_entrants (organization_id, lower(email));

CREATE TABLE IF NOT EXISTS predictor_predictions (
  id              serial PRIMARY KEY,
  fixture_id      integer NOT NULL REFERENCES predictor_fixtures(id),
  entrant_id      integer NOT NULL REFERENCES predictor_entrants(id),
  cufc_score      integer NOT NULL,
  opponent_score  integer NOT NULL,
  goalscorers     text[] NOT NULL DEFAULT '{}',    -- the entrant's picks (max 3)
  points_awarded  integer,                         -- set when the fixture goes final
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  CONSTRAINT predictor_predictions_fixture_entrant_unq UNIQUE (fixture_id, entrant_id)
);

CREATE TABLE IF NOT EXISTS predictor_squad (
  id               serial PRIMARY KEY,
  organization_id  integer NOT NULL DEFAULT 1,
  name             text NOT NULL,
  position         text,
  active           boolean NOT NULL DEFAULT true,
  sort             integer NOT NULL DEFAULT 0,
  created_at       timestamptz DEFAULT now()
);
