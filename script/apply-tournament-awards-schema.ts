// One-off migration for tournament Individual Awards — MVP votes + goalkeeper
// (Golden Glove) ratings. Purely additive — CREATE TABLE IF NOT EXISTS only.
// Wrapped in one transaction. Safe against the drifted prod DB.
//
// Usage: npx tsx --env-file=.env script/apply-tournament-awards-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS tournament_mvp_votes (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  game_id integer NOT NULL REFERENCES tournament_games(id) ON DELETE CASCADE,
  voter_team_id integer NOT NULL REFERENCES tournament_teams(id) ON DELETE CASCADE,
  player_id integer NOT NULL REFERENCES tournament_players(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT tournament_mvp_votes_game_voter_uniq UNIQUE (game_id, voter_team_id)
);

CREATE INDEX IF NOT EXISTS tournament_mvp_votes_game_idx
  ON tournament_mvp_votes (game_id);
CREATE INDEX IF NOT EXISTS tournament_mvp_votes_player_idx
  ON tournament_mvp_votes (player_id);

CREATE TABLE IF NOT EXISTS tournament_gk_ratings (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  game_id integer NOT NULL REFERENCES tournament_games(id) ON DELETE CASCADE,
  team_id integer NOT NULL REFERENCES tournament_teams(id) ON DELETE CASCADE,
  player_id integer NOT NULL REFERENCES tournament_players(id) ON DELETE CASCADE,
  rating integer NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT tournament_gk_ratings_game_team_uniq UNIQUE (game_id, team_id)
);

CREATE INDEX IF NOT EXISTS tournament_gk_ratings_game_idx
  ON tournament_gk_ratings (game_id);
CREATE INDEX IF NOT EXISTS tournament_gk_ratings_player_idx
  ON tournament_gk_ratings (player_id);

COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected. Applying tournament awards migration in one transaction...");
    await client.query(SQL);
    console.log("✅ Migration applied.");
    for (const t of ["tournament_mvp_votes", "tournament_gk_ratings"]) {
      const check = await client.query(`SELECT to_regclass('public.${t}') AS t`);
      if (!check.rows[0]?.t) throw new Error(`${t} table not found after migration`);
      console.log(`  ✓ ${t}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
