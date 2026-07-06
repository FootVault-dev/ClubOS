-- Penalty shootout: kick-by-kick order for knockout games that finish level.
-- Additive only. The tournament_games.home_penalties / away_penalties columns
-- already exist (they back the bracket resolver) — this just adds the ordered
-- sequence so the app + website can show a pro-app shootout timeline.
-- Totals stay in tournament_games (source of truth for advancement); these rows
-- are recomputed into those totals on every change.

CREATE TABLE IF NOT EXISTS tournament_penalty_kicks (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  game_id      integer NOT NULL REFERENCES tournament_games(id) ON DELETE CASCADE,
  kick_number  integer NOT NULL,              -- running order across both teams: 1,2,3…
  team_id      integer NOT NULL REFERENCES tournament_teams(id) ON DELETE CASCADE,
  scored       boolean NOT NULL,              -- true = goal (✓), false = missed/saved (✗)
  player_id    integer REFERENCES tournament_players(id) ON DELETE SET NULL, -- optional taker
  created_at   timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_penalty_kicks_game
  ON tournament_penalty_kicks (game_id, kick_number);
