// Additive migration: generalize split_sessions to fund venue bookings too.
// Adds funding_type (default 'registration') + facility_booking_group_id.
// Idempotent. Backward-compatible — existing MFL splits become 'registration'.
// Run BEFORE deploying venue Player Pay code.
//   npx tsx script/apply-split-funding.ts   (writes to DATABASE_URL in .env)
import "dotenv/config";
import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE split_sessions ADD COLUMN IF NOT EXISTS funding_type text NOT NULL DEFAULT 'registration';`);
    await client.query(`ALTER TABLE split_sessions ADD COLUMN IF NOT EXISTS facility_booking_group_id text;`);
    const { rows } = await client.query(`SELECT funding_type, COUNT(*)::int AS n FROM split_sessions GROUP BY funding_type`);
    console.log("✓ split_sessions funding columns ready. Existing by type:", rows.length ? rows : "(no rows yet)");
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
