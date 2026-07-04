// Apply the live/stream columns (tournament_games.is_live/stream_url,
// tournaments.stream_url) to the live Supabase DB. ADDITIVE ONLY.
// Usage: npx tsx --env-file=.env script/apply-live-stream-schema.ts
import pg from "pg";

const SQL = `
BEGIN;
ALTER TABLE tournament_games ADD COLUMN IF NOT EXISTS is_live boolean NOT NULL DEFAULT false;
ALTER TABLE tournament_games ADD COLUMN IF NOT EXISTS stream_url text;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS stream_url text;
COMMIT;
`;

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(SQL);
    const check = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE (table_name='tournament_games' AND column_name IN ('is_live','stream_url'))
          OR (table_name='tournaments' AND column_name='stream_url')
       ORDER BY table_name, column_name`,
    );
    console.log("Columns present:", check.rows.map((r) => `${r.table_name}.${r.column_name}`).join(", "));
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(() => { console.log("✓ live/stream schema applied"); process.exit(0); })
  .catch((e) => { console.error("✗ failed:", e.message); process.exit(1); });
