-- Match timer state on each game — the two-half live clock the referee/office
-- runs from Score Game. ADDITIVE ONLY. Run on Supabase prod BEFORE the Fly
-- deploy. Adding columns with a constant default is a fast metadata-only change
-- in Postgres (no table rewrite), so this is safe on the live tournament_games.
--
--   Rehearse:  npx tsx --env-file=.env script/apply-match-timer.ts --dry-run
--   Apply:     npx tsx --env-file=.env script/apply-match-timer.ts
--
-- Phases: 'pre' → 'first_half' → 'half_time' → 'second_half' → 'finished'.
-- The live clock is DERIVED, never stored ticking:
--   first_half/second_half: elapsed = timer_base_seconds + (running ? now - timer_started_at : 0)  [counts UP to the half length = tournament game_duration_minutes]
--   half_time:              remaining = break_seconds - (now - timer_started_at)                   [counts DOWN from break_between_minutes]
-- 'finished' is what flips a game to status='final' + triggers bracket resolution
-- (knockout placements never derive from an in-progress game).

ALTER TABLE tournament_games
  ADD COLUMN IF NOT EXISTS timer_phase text NOT NULL DEFAULT 'pre';
ALTER TABLE tournament_games
  ADD COLUMN IF NOT EXISTS timer_running boolean NOT NULL DEFAULT false;
ALTER TABLE tournament_games
  ADD COLUMN IF NOT EXISTS timer_started_at timestamp;
ALTER TABLE tournament_games
  ADD COLUMN IF NOT EXISTS timer_base_seconds integer NOT NULL DEFAULT 0;
