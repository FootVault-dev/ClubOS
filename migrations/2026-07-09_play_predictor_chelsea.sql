-- ─────────────────────────────────────────────────────────────────────────────
-- Play Predictor → the Chelsea scoring system.
--
-- The original build scored one thing: the scoreline, plus up to three
-- goalscorer picks (5/2/+1). Chelsea's real Play Predictor grades NINE
-- categories per match, worth up to 105 points (see
-- outputs/deep-research/2026-07-07-nz-play-predictor/01-chelsea-premier-league.md
-- for the verbatim "Annex 2 – Scoring System" table).
--
-- This migration widens both the fixture (what actually happened) and the
-- prediction (what the fan called) to carry all nine, and lets each fixture
-- declare which categories are live via `categories`.
--
-- Why `categories` exists: Chelsea are fed by Opta. Mainland Football and NZ
-- Football publish goals, scorers and goal minutes, but never record shots,
-- shots on target, possession or corners (verified 2026-07-09 against the
-- match-centre API and its own widget bundle). A fixture therefore defaults to
-- the five categories we can settle honestly; the other four switch on only if
-- a staff member commits to logging them.
--
-- ADDITIVE ONLY — every statement is IF NOT EXISTS or a nullable ADD COLUMN.
-- No column is dropped, no type is changed, no row is rewritten. Safe to run
-- against the live Supabase DB while the current build is serving traffic.
-- Run BEFORE the deploy (reference_clubos_prod_db_drift: never db:push).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Fixtures: the actual result, one column per Chelsea category ─────────────

-- Which of the nine categories are live for this fixture. NULL means "the
-- default five" so every existing row keeps working untouched.
ALTER TABLE predictor_fixtures ADD COLUMN IF NOT EXISTS categories        jsonb;

-- Minute of United's first goal. Stoppage time is folded to 45 or 90, exactly
-- as Chelsea's T&Cs specify.
ALTER TABLE predictor_fixtures ADD COLUMN IF NOT EXISTS first_goal_minute integer;

-- The four Opta-style stats. NULL after a match means "not recorded" and the
-- category voids for every entrant rather than scoring them all zero.
ALTER TABLE predictor_fixtures ADD COLUMN IF NOT EXISTS shots             integer;
ALTER TABLE predictor_fixtures ADD COLUMN IF NOT EXISTS shots_on_target   integer;
ALTER TABLE predictor_fixtures ADD COLUMN IF NOT EXISTS possession        integer;
ALTER TABLE predictor_fixtures ADD COLUMN IF NOT EXISTS corners           integer;

-- Mainland Football match-centre id, so a result can be pulled from their
-- timeline/lineUp feed instead of typed in by hand.
ALTER TABLE predictor_fixtures ADD COLUMN IF NOT EXISTS mf_match_id       text;

-- ── Predictions: what the fan called, one column per Chelsea category ────────

-- The single first-goalscorer pick. Replaces the old three-scorer list, which
-- stays in place (nullable, defaulted) so nothing existing breaks.
ALTER TABLE predictor_predictions ADD COLUMN IF NOT EXISTS first_scorer      text;
ALTER TABLE predictor_predictions ADD COLUMN IF NOT EXISTS first_goal_minute integer;
ALTER TABLE predictor_predictions ADD COLUMN IF NOT EXISTS shots             integer;
ALTER TABLE predictor_predictions ADD COLUMN IF NOT EXISTS shots_on_target   integer;
ALTER TABLE predictor_predictions ADD COLUMN IF NOT EXISTS possession        integer;
ALTER TABLE predictor_predictions ADD COLUMN IF NOT EXISTS corners           integer;

-- The per-category points breakdown, stored at scoring time so a fan can be
-- shown exactly where their points came from without re-deriving it.
ALTER TABLE predictor_predictions ADD COLUMN IF NOT EXISTS points_breakdown  jsonb;

-- The old three-scorer array is no longer written. Drop its NOT NULL so future
-- inserts need not supply it. (The column itself is kept — additive only.)
ALTER TABLE predictor_predictions ALTER COLUMN goalscorers DROP NOT NULL;

-- ── Squad: shirt number for the goalscorer picker ────────────────────────────

ALTER TABLE predictor_squad ADD COLUMN IF NOT EXISTS shirt_number integer;

-- ── Leaderboard access paths ────────────────────────────────────────────────

-- Season and monthly boards both scan predictions joined to final fixtures.
CREATE INDEX IF NOT EXISTS predictor_predictions_fixture_idx
  ON predictor_predictions (fixture_id);
CREATE INDEX IF NOT EXISTS predictor_fixtures_org_kickoff_idx
  ON predictor_fixtures (organization_id, kickoff_at);
