// Additive migration: the CIC Skills Challenge gains a terminal-outcome column.
//
// A contestant can end a challenge with no valid number — didn't start (DNS),
// didn't finish (DNF), or was disqualified (DSQ). Those are recorded in
// `status`, mutually exclusive with `score`. Purely additive — one nullable
// text column, IF NOT EXISTS, in a transaction. Safe to run twice.
//
// Run BEFORE deploying the code that reads the column:
//   npx tsx --env-file=.env script/apply-skills-status-column.ts
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE skills_challenge_entries ADD COLUMN IF NOT EXISTS status text`);
    await client.query("COMMIT");
    const { rows } = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'skills_challenge_entries' AND column_name = 'status'`,
    );
    console.log("✅ status column present:", rows[0] ?? "(missing!)");
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("❌ rolled back —", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
