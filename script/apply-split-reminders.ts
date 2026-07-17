// Additive migration: Player Pay share-link reminder tracking on split_sessions.
// Purely additive (ADD COLUMN IF NOT EXISTS) — safe to re-run, never drops or
// alters existing data. Run BEFORE deploying the app build.
//   npx tsx --env-file=.env script/apply-split-reminders.ts
//
// reminder_count   — automated nudges sent so far (cap enforced app-side)
// last_reminder_at — last send (sweep cadence + admin-resend cooldown)
// See reference_clubos_prod_db_drift: prod DB has drift, so we migrate
// additively by hand and NEVER run db:push --force.

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE split_sessions
        ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_reminder_at timestamp
    `);
    await client.query("COMMIT");

    const check = await client.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'split_sessions' AND column_name IN ('reminder_count', 'last_reminder_at')
      ORDER BY column_name
    `);
    console.log("Verified columns:", check.rows);
    if (check.rows.length !== 2) throw new Error("Expected 2 columns after migration");
    console.log("✓ split_sessions reminder columns applied");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
