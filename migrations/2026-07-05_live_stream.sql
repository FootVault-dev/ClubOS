-- Live match + streaming ("Watch") support for the CIC Youth app + website.
-- ADDITIVE ONLY — safe to run on the live Supabase DB. Run this BEFORE the Fly
-- deploy that ships the new endpoints (per the prod-DB rule: never db:push --force).

-- Per-game live flag (admin toggles "Go Live" when a game is being streamed)
-- and an optional per-game stream URL. When a game's stream_url is null the app
-- falls back to the tournament-level stream_url below (single-camera setups).
ALTER TABLE tournament_games ADD COLUMN IF NOT EXISTS is_live boolean NOT NULL DEFAULT false;
ALTER TABLE tournament_games ADD COLUMN IF NOT EXISTS stream_url text;

-- Tournament-level stream URL (the default "Watch" destination for the whole
-- age group when a game doesn't carry its own).
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS stream_url text;
