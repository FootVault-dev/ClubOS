// One-off migration for tournament disciplinary cards (yellow/red tracker).
// Purely additive — CREATE TABLE IF NOT EXISTS only. One transaction.
//
// Usage: npx tsx --env-file=.env script/apply-tournament-cards-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS tournament_cards (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  game_id integer NOT NULL REFERENCES tournament_games(id) ON DELETE CASCADE,
  player_id integer NOT NULL REFERENCES tournament_players(id) ON DELETE CASCADE,
  team_id integer NOT NULL REFERENCES tournament_teams(id) ON DELETE CASCADE,
  card_type text NOT NULL,
  minute integer,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tournament_cards_game_idx  ON tournament_cards (game_id);
CREATE INDEX IF NOT EXISTS tournament_cards_player_idx ON tournament_cards (player_id);

COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log("Applying tournament cards migration...");
    await client.query(SQL);
    const check = await client.query(`SELECT to_regclass('public.tournament_cards') AS t`);
    if (!check.rows[0]?.t) throw new Error("tournament_cards table not found after migration");
    console.log("✅ Migration applied. ✓ tournament_cards");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
